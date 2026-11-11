/**
 * Worktree
 *
 * `/worktree <branch> [<base>]` creates or attaches the git worktree for that branch and moves
 * the running session into it. `/worktree` alone lists the worktrees of this repository.
 *
 * Why a move and not a launch flag: the session cwd is fixed when the SessionManager and the
 * tool stack are built, and extension flags are only readable after that point. `switchSession`
 * is the one API that rebuilds the cwd-bound runtime afterwards, so the conversation reaches the
 * worktree by forking the session file to a header carrying the target cwd and switching to it.
 * The fork is a copy: the pre-fork conversation stays behind in the original session file.
 *
 * The location formula mirrors the `gwt` fish function — `<root>/<repo>/<branch with / -> ->`,
 * `$GWT_ROOT` first — but nothing here calls fish. A branch that already has a worktree is
 * attached to wherever it is, so a worktree made by `gwt` is found instead of duplicated.
 *
 * Deliberately not implemented: deleting worktrees (`gwt -d` owns that), moving uncommitted
 * changes (refused instead), and creating local branches for remote-only names.
 *
 * The forked session lands in the default session directory for the worktree. A custom
 * `--session-dir` is not carried over: `getDefaultSessionDir` is not exported and the read-only
 * session manager exposes no way to tell a custom directory from a default one.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * The session cwd, which is not `process.cwd()`: switching sessions rebuilds the runtime around
 * the new directory but leaves the process where it started. Completion has no context argument,
 * so the cwd is tracked from `session_start` and from every successful move.
 */
let sessionCwd: string | undefined;

export interface WorktreeEntry {
	path: string;
	branch: string | undefined;
	detached: boolean;
}

/** Worktree root: `$GWT_ROOT`, else the same default the `gwt` fish function uses. */
export function resolveRoot(env: Record<string, string | undefined> = process.env): string {
	const configured = env.GWT_ROOT?.trim();
	return configured ? configured : join(homedir(), "Documents/dev/.worktrees");
}

/** Branch names may contain `/`; a directory may not nest, so flatten the separator. */
export function flattenBranch(branch: string): string {
	return branch.replaceAll("/", "-");
}

export function worktreePath(root: string, repoRoot: string, branch: string): string {
	return join(root, basename(repoRoot), flattenBranch(branch));
}

/**
 * The main checkout for a git common directory, mirroring `_gwt_repo` in the fish function.
 * `--show-toplevel` cannot be used here: inside a linked worktree it returns that worktree, which
 * would name the directory after the branch instead of the repository.
 */
export function repoRootFrom(commonDir: string): string {
	return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
}

/** Parse `git worktree list --porcelain`. Entries are separated by blank lines. */
export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			if (current) entries.push(current);
			current = undefined;
			continue;
		}
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length), branch: undefined, detached: false };
		} else if (current && line.startsWith("branch refs/heads/")) {
			current.branch = line.slice("branch refs/heads/".length);
		} else if (current && line === "detached") {
			current.detached = true;
		}
	}
	if (current) entries.push(current);
	return entries;
}

export function findWorktreeForBranch(
	entries: WorktreeEntry[],
	branch: string,
): WorktreeEntry | undefined {
	return entries.find((entry) => entry.branch === branch);
}

/**
 * Compare two paths as directories. `git worktree list` reports real paths, so a worktree under a
 * symlinked prefix (`/tmp` → `/private/tmp` on macOS) would not match a computed path literally.
 */
export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function samePath(left: string, right: string): boolean {
	return canonicalPath(left) === canonicalPath(right);
}

/**
 * Git prints progress on stderr alongside the failure, so `worktree add` reports
 * "Preparing worktree (new branch 'x')\nfatal: ...". Keep only the diagnostic lines.
 */
export function cleanGitError(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const diagnostic = lines.filter((line) => /^(fatal|error):/i.test(line));
	return (diagnostic.length > 0 ? diagnostic : lines).join("; ");
}

function firstLines(text: string, count: number): string {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(0, count)
		.join(", ");
}

/**
 * Header line for a session that has no history to carry. `SessionManager.create` does not write
 * its file until the first entry, so an empty session has to be materialised before it can be
 * switched to. Shape and field order follow `SessionManager.forkFrom`.
 */
export function emptySessionHeader(version: number, id: string, cwd: string, timestamp: string): string {
	return `${JSON.stringify({ type: "session", version, id, timestamp, cwd })}\n`;
}

async function git(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const result = await pi.exec("git", args, { cwd, timeout: 30_000 });
	return { code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function fail(message: string): never {
	throw new Error(message);
}

/**
 * A refusal is a condition the user can fix — a dirty tree, a branch on origin only, no worktree
 * to make. Reported through the UI so it reads as an answer, not as a crash with a stack trace.
 */
class Refusal extends Error {}

function refuse(message: string): never {
	throw new Refusal(message);
}

async function listWorktrees(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const top = await git(pi, ["rev-parse", "--show-toplevel"], ctx.cwd);
	if (top.code !== 0 || top.stdout === "") refuse("Not inside a git repository");
	const result = await git(pi, ["worktree", "list", "--porcelain"], ctx.cwd);
	if (result.code !== 0) fail(`git worktree list failed: ${result.stderr || "unknown error"}`);
	const entries = parseWorktreePorcelain(result.stdout);
	if (entries.length === 0) {
		ctx.ui.notify("No worktrees", "info");
		return;
	}
	const lines = entries.map((entry) => {
		const label = entry.branch ?? (entry.detached ? "(detached)" : "(bare)");
		return `${label}\t${entry.path}`;
	});
	ctx.ui.notify(lines.join("\n"), "info");
}

async function moveToWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	branch: string,
	base: string | undefined,
): Promise<void> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) refuse("This session is not persisted, so it cannot be moved");

	if (!ctx.isIdle()) {
		ctx.ui.notify("Waiting for the current turn to finish", "info");
		await ctx.waitForIdle();
	}

	const common = await git(pi, ["rev-parse", "--path-format=absolute", "--git-common-dir"], ctx.cwd);
	if (common.code !== 0 || common.stdout === "") refuse("Not inside a git repository");
	const repoRoot = repoRootFrom(common.stdout);

	const status = await git(pi, ["status", "--porcelain", "-uall"], ctx.cwd);
	if (status.code !== 0) fail(`git status failed: ${status.stderr || "unknown error"}`);
	if (status.stdout !== "") {
		refuse(`Working tree has changes (${firstLines(status.stdout, 3)}); commit or stash before moving`);
	}

	const listed = await git(pi, ["worktree", "list", "--porcelain"], ctx.cwd);
	if (listed.code !== 0) fail(`git worktree list failed: ${listed.stderr || "unknown error"}`);
	const entries = parseWorktreePorcelain(listed.stdout);

	let target = findWorktreeForBranch(entries, branch)?.path;
	if (target) {
		if (base !== undefined) {
			refuse(`'${branch}' already has a worktree; a base only applies to a new branch`);
		}
		if (samePath(target, ctx.cwd)) refuse(`Already in the worktree for '${branch}'`);
	}

	if (!target) {
		target = worktreePath(resolveRoot(), repoRoot, branch);
		const local = await git(pi, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
		if (local.code === 0) {
			if (base !== undefined) {
				refuse(`'${branch}' already exists; a base only applies to a new branch`);
			}
			const add = await git(pi, ["worktree", "add", target, branch], repoRoot);
			if (add.code !== 0) refuse(`git worktree add failed: ${cleanGitError(add.stderr)}`);
		} else {
			const remote = await git(
				pi,
				["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
				repoRoot,
			);
			if (remote.code === 0) {
				refuse(`'${branch}' exists only on origin; run 'gwt ${branch}' to create it locally`);
			}
			const add = await git(
				pi,
				["worktree", "add", "-b", branch, target, base ?? "HEAD"],
				repoRoot,
			);
			if (add.code !== 0) refuse(`git worktree add failed: ${cleanGitError(add.stderr)}`);
		}
	}

	// `git worktree list` reports real paths, and pi derives the session directory from the cwd. A root
	// under a symlinked prefix (`/tmp` on macOS) would file the forked session under a directory that
	// `pi --continue` in that same worktree could not find.
	target = canonicalPath(target);

	// Imported lazily: a top-level value import would make this file unloadable outside pi, and the
	// pure helpers above are covered by `node --test` without pi on the module path.
	const { CURRENT_SESSION_VERSION, SessionManager } = await import("@earendil-works/pi-coding-agent");

	// `forkFrom` refuses a source with no entries, which is the normal state of a session whose
	// first action is this command: pi keeps a few bookkeeping entries in memory and writes the file
	// only once the first real entry lands. Nothing to carry, so start an empty session instead.
	let nextFile: string | undefined;
	if (existsSync(sessionFile)) {
		nextFile = SessionManager.forkFrom(sessionFile, target).getSessionFile();
	} else {
		const created = SessionManager.create(target);
		const createdFile = created.getSessionFile();
		if (!createdFile) fail("Could not create a session in the worktree");
		mkdirSync(dirname(createdFile), { recursive: true });
		writeFileSync(
			createdFile,
			emptySessionHeader(
				CURRENT_SESSION_VERSION,
				created.getSessionId(),
				target,
				new Date().toISOString(),
			),
			{ flag: "wx" },
		);
		nextFile = createdFile;
	}
	if (!nextFile) fail("Could not create the forked session");

	const switched = await ctx.switchSession(nextFile, {
		withSession: async (next) => next.ui.notify(`Session moved to ${target}`, "info"),
	});
	if (switched.cancelled) {
		ctx.ui.notify("Move cancelled", "warning");
		return;
	}
	sessionCwd = target;
}

export default function worktreeExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd;
	});

	pi.registerCommand("worktree", {
		description: "Create or attach a git worktree and move this session into it",
		getArgumentCompletions: async (prefix) => {
			const result = await pi.exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
				cwd: sessionCwd ?? process.cwd(),
			});
			if (result.code !== 0) return null;
			const branches = result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((name) => name !== "" && name.startsWith(prefix));
			return branches.length > 0 ? branches.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			// Print and JSON modes have no UI to report a move, so refuse before touching anything.
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				fail(`/worktree needs an interactive or RPC session, not ${ctx.mode} mode`);
			}
			sessionCwd = ctx.cwd;
			const [branch, base] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (branch === undefined) {
					await listWorktrees(pi, ctx);
					return;
				}
				await moveToWorktree(pi, ctx, branch, base);
			} catch (error) {
				if (error instanceof Refusal) {
					ctx.ui.notify(error.message, "error");
					return;
				}
				throw error;
			}
		},
	});
}
