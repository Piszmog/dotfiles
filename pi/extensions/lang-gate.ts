/**
 * Language Gate
 *
 * Declares only the MCP language-server tools that match the workspace.
 *
 * - `mcp__gopls__*` is enabled only in a Go workspace (`go.mod`/`go.work`).
 * - `mcp__cclsp__*` is disabled in a Go-only workspace, where cclsp has no server for `.go`
 *   files and every call returns "no LSP server configured". cclsp is kept when it has a reason
 *   to be there: its own markers, or `.templ`/Tailwind files, which is how a Go+templ project
 *   without node tooling still gets the templ, SQL, HTML, and CSS servers.
 *
 * Markers are looked up from `cwd` to the repository root. Manifests are also scanned two levels
 * below the root, which covers monorepos (`services/api/go.mod`) without descending from arbitrary
 * parent directories and picking up a sibling checkout. `.templ` files are scanned four levels
 * deep (`internal/ui/views/components/x.templ`).
 *
 * Everything not named `mcp__gopls__*` or `mcp__cclsp__*` is left untouched, so built-in
 * tools, other MCP servers, and an explicit `--tools`/`--exclude-tools` choice still win.
 * A server whose tools exist but are all inactive is treated as an opt-out the first time the
 * gate sees it; later removals are tracked, so re-gating another repository can restore exactly
 * the tools this gate took away without overriding a tool the user disabled separately.
 *
 * MCP tools do not exist yet at `session_start`: the built-in MCP extension connects in the
 * background, and it emits `mcp_servers_change` only when an extension registers or unregisters a
 * server, never when a server finishes connecting and registers its tools. So a single check can
 * run before the tools exist — the case that matters, for example `pi -p` or a startup message.
 * The gate therefore re-checks on a short timer after `session_start` until both servers are
 * visible, and again before every prompt (`before_agent_start`, which also covers a session that
 * moved to another repository).
 *
 * Toggle at runtime: /lang-gate off | on | status. Turning the gate off restores its removals.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GO_PREFIX = "mcp__gopls__";
const CCLSP_PREFIX = "mcp__cclsp__";

const GO_MARKERS = ["go.mod", "go.work"];
const CCLSP_MARKERS = [
	"Cargo.toml",
	"package.json",
	"tsconfig.json",
	"pyproject.toml",
	"requirements.txt",
	"setup.py",
	"flake.nix",
	"shell.nix",
	"sqlc.yaml",
	"tailwind.config.js",
	"tailwind.config.ts",
	"tailwind.config.cjs",
	"tailwind.config.mjs",
];
/** Formats with no manifest of their own; a file is the marker. */
const CCLSP_SUFFIXES = [".templ"];
/** Directories a shallow marker scan never descends into. */
const SCAN_SKIP = new Set([".git", ".venv", "__pycache__", "build", "dist", "node_modules", "target", "vendor"]);
/** Manifest markers live at the root or one project level down (`services/api/go.mod`). */
const MARKER_SCAN_DEPTH = 2;
/** `internal/ui/views/components/page.templ` is four directories below the repository root. */
const TEMPL_SCAN_DEPTH = 4;
/** MCP servers connect in the background; re-check for a while after `session_start`. */
const SETTLE_INTERVAL_MS = 250;
const SETTLE_SLOW_INTERVAL_MS = 1_000;
const SETTLE_TIMEOUT_MS = 15_000;

export interface WorkspaceMarkers {
	go: boolean;
	cclsp: boolean;
}

export interface DirEntry {
	name: string;
	/** True for directories, so the `.templ` scan never recurses into a file. */
	dir: boolean;
}

function listDir(dir: string): DirEntry[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
	} catch {
		return [];
	}
}

/** Look for a name matching `match` in `dir` and, shallowly, its subdirectories. */
function hasMatch(
	dir: string,
	list: (dir: string) => DirEntry[],
	depth: number,
	match: (name: string) => boolean,
): boolean {
	const entries = list(dir);
	if (entries.some((entry) => match(entry.name))) return true;
	if (depth <= 0) return false;
	return entries.some(
		(entry) =>
			entry.dir &&
			!SCAN_SKIP.has(entry.name) &&
			!entry.name.startsWith(".") &&
			hasMatch(join(dir, entry.name), list, depth - 1, match),
	);
}

/** Look up from `cwd` to the repository root (the directory holding `.git`, or the filesystem root). */
export function detectMarkers(
	cwd: string,
	exists: (path: string) => boolean = existsSync,
	list: (dir: string) => DirEntry[] = listDir,
): WorkspaceMarkers {
	const found: WorkspaceMarkers = { go: false, cclsp: false };
	const named = (names: string[]) => (name: string) => names.includes(name);
	const templ = (name: string) => CCLSP_SUFFIXES.some((suffix) => name.endsWith(suffix));

	let dir = cwd;
	for (;;) {
		if (!found.go && GO_MARKERS.some((marker) => exists(join(dir, marker)))) found.go = true;
		if (!found.cclsp && CCLSP_MARKERS.some((marker) => exists(join(dir, marker)))) found.cclsp = true;
		// templ projects are Go projects: only look for those files once a Go module is in scope.
		if (found.go && !found.cclsp && hasMatch(dir, list, TEMPL_SCAN_DEPTH, templ)) found.cclsp = true;
		// Monorepos keep their manifests in project subdirectories (`services/api/go.mod`). That is
		// only scanned at the repository root: descending from arbitrary ancestors would enable a
		// server for whatever happens to live next to the checkout.
		const root = exists(join(dir, ".git"));
		if (root) {
			if (!found.go && hasMatch(dir, list, MARKER_SCAN_DEPTH, named(GO_MARKERS))) found.go = true;
			if (!found.cclsp && hasMatch(dir, list, MARKER_SCAN_DEPTH, named(CCLSP_MARKERS))) found.cclsp = true;
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}

/** What the gate itself changed, so a later re-gate can distinguish its own work from a user opt-out. */
export interface GateState {
	/** Prefix → true when the server's tools were registered but none were active the first time we looked. */
	optedOut: Map<string, boolean>;
	/** Tools this gate deactivated, so a later gate can restore exactly those. */
	removed: Map<string, Set<string>>;
}

export function newGateState(): GateState {
	return { optedOut: new Map(), removed: new Map() };
}

/** The active tool set, with gopls/cclsp tools added or removed to match `markers`. */
export function gateTools(
	active: string[],
	all: string[],
	markers: WorkspaceMarkers,
	state: GateState = newGateState(),
): string[] {
	const wanted = new Set(active);
	const has = (prefix: string) => all.some((name) => name.startsWith(prefix));

	// Decide once, when the server first becomes visible. Deciding on every call would read the
	// gate's own earlier removal as an opt-out and never restore the tools.
	const optedOut = (prefix: string) => {
		let decision = state.optedOut.get(prefix);
		if (decision === undefined) {
			decision = has(prefix) && !active.some((name) => name.startsWith(prefix));
			state.optedOut.set(prefix, decision);
		}
		return decision;
	};

	const apply = (prefix: string, enabled: boolean) => {
		if (!has(prefix) || optedOut(prefix)) return;
		if (enabled) {
			const removed = state.removed.get(prefix);
			if (!removed) return;
			// Restore only what the gate removed; a tool the user disabled separately stays off.
			for (const name of [...removed]) {
				if (!all.includes(name)) continue;
				wanted.add(name);
				removed.delete(name);
			}
			return;
		}
		const removed = state.removed.get(prefix) ?? new Set<string>();
		// Record only what was active: restoring those later cannot override a separate opt-out.
		for (const name of active) {
			if (!name.startsWith(prefix)) continue;
			wanted.delete(name);
			removed.add(name);
		}
		if (removed.size > 0) state.removed.set(prefix, removed);
	};

	apply(GO_PREFIX, markers.go);
	apply(CCLSP_PREFIX, markers.cclsp);
	return [...wanted];
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let lastKey: string | undefined;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	const state = newGateState();

	const hasTools = (prefix: string) => pi.getAllTools().some((tool) => tool.name.startsWith(prefix));

	const stopSettle = () => {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = undefined;
	};

	const apply = (ctx: { cwd: string }) => {
		if (!enabled) return;
		const all = pi.getAllTools().map((tool) => tool.name);
		const active = pi.getActiveTools();
		const next = gateTools(active, all, detectMarkers(ctx.cwd), state);
		// The key covers both sides: a server that connects between two runs changes `active` without
		// changing `next`, and skipping here would leave its tools declared.
		const key = `${[...next].sort().join(",")}|${[...active].sort().join(",")}`;
		if (key === lastKey) return;
		lastKey = key;
		pi.setActiveTools(next);
	};

	// Servers connect in the background, so their tools are not registered yet when
	// `session_start` runs. Poll for a bounded window so the first run is gated too.
	const settle = (ctx: { cwd: string }) => {
		stopSettle();
		if (!enabled) return;
		const start = Date.now();
		const deadline = start + SETTLE_TIMEOUT_MS;
		const tick = () => {
			settleTimer = undefined;
			apply(ctx);
			if (Date.now() >= deadline || (hasTools(GO_PREFIX) && hasTools(CCLSP_PREFIX))) return;
			// Fast at first (a local server connects in milliseconds), then coarse, so a slow one does
			// not cost a marker scan every 250 ms for the rest of the window.
			const delay = Date.now() - start < SETTLE_INTERVAL_MS * 4 ? SETTLE_INTERVAL_MS : SETTLE_SLOW_INTERVAL_MS;
			settleTimer = setTimeout(tick, delay);
			settleTimer.unref?.();
		};
		settleTimer = setTimeout(tick, SETTLE_INTERVAL_MS);
		settleTimer.unref?.();
	};

	pi.on("session_start", async (_event, ctx) => {
		lastKey = undefined;
		apply(ctx);
		settle(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopSettle();
	});

	// Before each prompt, so a session that moved to another repository is re-gated.
	pi.on("before_agent_start", async (_event, ctx) => {
		apply(ctx);
		if (hasTools(GO_PREFIX) && hasTools(CCLSP_PREFIX)) stopSettle();
	});

	pi.registerCommand("lang-gate", {
		description: "Show or toggle language-based MCP tool gating (on|off|status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off") {
				enabled = false;
				stopSettle();
				// Turning gating off should undo its own removals; otherwise the only recovery is a reload.
				const all = pi.getAllTools().map((tool) => tool.name);
				const restored = new Set(pi.getActiveTools());
				for (const removed of state.removed.values()) {
					for (const name of removed) if (all.includes(name)) restored.add(name);
				}
				state.removed.clear();
				lastKey = undefined;
				pi.setActiveTools([...restored]);
				ctx.ui.notify("Language gate off; MCP language tools are no longer added or removed", "warning");
				return;
			}
			if (action === "on") {
				enabled = true;
				lastKey = undefined;
				apply(ctx);
				ctx.ui.notify("Language gate on", "info");
				return;
			}
			if (action && action !== "status") {
				ctx.ui.notify("Usage: /lang-gate [on|off|status]", "warning");
				return;
			}
			const markers = detectMarkers(ctx.cwd);
			const active = pi.getActiveTools();
			const go = active.filter((name) => name.startsWith(GO_PREFIX)).length;
			const cclsp = active.filter((name) => name.startsWith(CCLSP_PREFIX)).length;
			ctx.ui.notify(
				`Language gate ${enabled ? "on" : "off"} · go=${markers.go} cclsp=${markers.cclsp} · active gopls=${go} cclsp=${cclsp}`,
				"info",
			);
		},
	});
}
