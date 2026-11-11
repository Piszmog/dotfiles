/**
 * Shell Reaper
 *
 * Kills the shells a session started when that session goes away, so a backgrounded dev server
 * cannot outlive the conversation that started it.
 *
 * Pi already kills the process tree of a bash call while it runs: Esc, the tool timeout, and the
 * abort that `/new` performs all reach `killProcessTree`. The leak is elsewhere. `untrackDetachedChildPid`
 * runs in the `finally` of the bash tool as soon as the shell exits, so `npm run dev &` is nobody's
 * child by the time the session ends, and quit does not use the tracked-pid cleanup anyway.
 * earendil-works/pi#8225 is the upstream ruling on that: expected behaviour, and the suggested
 * workaround is "record the pid when you launch it, kill the group later". This extension is that
 * workaround, done in the shell.
 *
 * Recording goes through `shellCommandPrefix` in settings.json, which runs one line before every
 * bash tool command and every `!` command:
 *
 *   printf '%s\n' "$$" >> "${TMPDIR:-/tmp}/pi-shells-$PPID.log" 2>/dev/null || true
 *
 * Pi spawns the shell detached, so its pid is its process-group id (measured on macOS: recorded
 * pid == child pid == pgid). Signalling the negative pid reaches background children even after
 * the shell itself has exited, which is the case that leaks. The file is keyed by the pi pid, so
 * `/reload` keeps its shells, and `/new`, `/resume`, `/fork`, and quit reap them.
 *
 * The extension is inert without that settings line. `/shell-reaper` reports whether the two are
 * still in sync, and so does `tests/shell-reaper.test.ts`. The reverse also holds: removing the
 * extension while leaving the line behind only accumulates one short line per command in tmp until
 * the OS clears it.
 *
 * Not covered: a process that leaves its group (`setsid`, some daemons, Playwright's browser — see
 * pi#10797), anything tmux/launchd/systemd/docker started, and Windows. Pid-group reuse inside one
 * pi run is possible in theory and ignored in practice.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** How long a shell gets between SIGTERM and SIGKILL. */
export const GRACE_MS = 150;

/** File name the shell writes to; `$PPID` is the pi pid, `$$` is the shell pid. */
export const REGISTRY_NAME = "pi-shells-$PPID.log";

/**
 * The exact line that must sit in `settings.json` as `shellCommandPrefix`. `printf` is a shell
 * builtin, so this costs no extra process per command.
 */
export const SHELL_PREFIX = `printf '%s\\n' "$$" >> "\${TMPDIR:-/tmp}/${REGISTRY_NAME}" 2>/dev/null || true`;

/** Registry file for one pi process. `tmpdir()` honours TMPDIR and drops the trailing slash. */
export function registryPath(pid: number = process.pid, dir: string = tmpdir()): string {
	return join(dir, REGISTRY_NAME.replace("$PPID", String(pid)));
}

/** Strict parse: whole lines that are decimal pids. Duplicates collapse, junk is dropped. */
export function parsePids(text: string): number[] {
	const seen = new Set<number>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!/^\d+$/.test(trimmed)) continue;
		const pid = Number(trimmed);
		// 0 and 1 are never a shell of ours. `kill(-0)` would signal pi's own process group.
		if (pid > 1 && pid < 2 ** 31) seen.add(pid);
	}
	return [...seen];
}

/** Whether any process is left in the group led by `pid`. */
export function isGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		// EPERM means the group exists but is not ours to signal, which still counts as alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Candidate group leaders: whole ids above 1, minus pi itself. `kill(-0)` targets pi's own group,
 * so the filter is the only thing standing between a corrupt registry and the user's terminal.
 */
export function reapTargets(pids: readonly number[], selfPid: number = process.pid): number[] {
	return [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== selfPid);
}

export interface ReapResult {
	/** Group leaders that were signalled. */
	targeted: number;
	/** Groups still alive after the grace period, so they got SIGKILL. */
	forceKilled: number;
}

/**
 * Stop each recorded shell: SIGTERM to the group, one grace period, then SIGKILL for whatever is
 * left. Synchronous on purpose — it runs from `session_shutdown` and from a `process.on("exit")`
 * handler, where nothing can be awaited.
 */
export function reap(pids: readonly number[], options: { graceMs?: number; selfPid?: number } = {}): ReapResult {
	const selfPid = options.selfPid ?? process.pid;
	// A recorded shell that exited cleanly leaves an empty group. Dropping those first keeps the
	// common case free: a session whose commands all finished pays no grace period at all.
	const targets = reapTargets(pids, selfPid).filter(isGroupAlive);
	if (targets.length === 0) return { targeted: 0, forceKilled: 0 };

	for (const pid of targets) signalGroup(pid, "SIGTERM");
	const graceMs = options.graceMs ?? GRACE_MS;
	if (graceMs > 0) pause(graceMs);

	let forceKilled = 0;
	for (const pid of targets) {
		if (!isGroupAlive(pid)) continue;
		signalGroup(pid, "SIGKILL");
		forceKilled++;
	}
	return { targeted: targets.length, forceKilled };
}

/** Kill what `path` lists, then delete it. Missing file means nothing was started. */
export function reapRegistry(path: string, options: { graceMs?: number; selfPid?: number } = {}): ReapResult {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { targeted: 0, forceKilled: 0 };
	}
	const result = reap(parsePids(text), options);
	rmSync(path, { force: true });
	return result;
}

/** Forget the recorded shells without touching them. */
export function clearRegistry(path: string): void {
	try {
		writeFileSync(path, "");
	} catch {
		// An unwritable registry only loses cleanup, never the command itself.
	}
}

/** Signal the group led by `pid`; fall back to the single process when it is not a leader. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch {
		// Not a group leader, or an already-dead group.
	}
	try {
		process.kill(pid, signal);
	} catch {
		// Gone between the check and the signal.
	}
}

function pause(ms: number): void {
	try {
		spawnSync("sleep", [String(ms / 1000)], { stdio: "ignore" });
	} catch {
		// A missing sleep only shortens the grace period.
	}
}

/** Whether settings.json still carries the recording line. */
export function prefixWired(prefix: string | undefined): boolean {
	return typeof prefix === "string" && prefix.includes(SHELL_PREFIX);
}

export default function shellReaper(pi: ExtensionAPI) {
	const registry = registryPath();
	let exitHook: (() => void) | undefined;

	const reapNow = (): ReapResult => {
		if (process.platform === "win32") return { targeted: 0, forceKilled: 0 };
		try {
			return reapRegistry(registry);
		} catch {
			return { targeted: 0, forceKilled: 0 };
		}
	};

	pi.on("session_start", async (event, ctx) => {
		// A reload keeps the conversation and its servers; every other start begins with a clean list,
		// which also drops the entries a crashed run left behind.
		if (event.reason !== "reload") clearRegistry(registry);

		if (!exitHook) {
			exitHook = () => {
				reapNow();
			};
			// Session shutdown covers quit, /new, /resume, and /fork. The exit hook covers the crash
			// paths that call process.exit without emitting shutdown.
			process.on("exit", exitHook);
		}

		if (ctx.hasUI && !prefixWired(pi.getSettings().shellCommandPrefix)) {
			ctx.ui.notify(
				"Shell reaper is inactive: settings.json shellCommandPrefix does not contain the pid line. Run /shell-reaper for details.",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (exitHook) {
			process.off("exit", exitHook);
			exitHook = undefined;
		}
		if (event.reason === "reload") return;
		reapNow();
	});

	pi.registerCommand("shell-reaper", {
		description: "Show which shells this session is tracking",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action && action !== "status") {
				ctx.ui.notify("Usage: /shell-reaper [status]", "warning");
				return;
			}
			const wired = prefixWired(pi.getSettings().shellCommandPrefix);
			let recorded: number[] = [];
			try {
				recorded = parsePids(readFileSync(registry, "utf8"));
			} catch {
				// No command has run yet.
			}
			const running = recorded.filter(isGroupAlive);
			const notes = [
				wired
					? "Shell reaper wired: shellCommandPrefix records the pid"
					: "Shell reaper NOT wired: settings.json shellCommandPrefix is missing the pid line",
				`Registry ${registry}`,
				`${recorded.length} shells started this session, ${running.length} still running`,
			];
			if (process.platform === "win32") notes.push("Windows: groups are not reaped");
			ctx.ui.notify(notes.join("\n"), wired ? "info" : "warning");
		},
	});
}
