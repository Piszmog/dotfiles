/**
 * Tests for the lang-gate extension. Run from the pi config directory:
 *
 *   node --test 'tests/*.test.ts'
 *
 * The filesystem is stubbed, so these pin the marker and gating rules without depending on what
 * happens to be installed in the workspace under test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import langGate, { type DirEntry, detectMarkers, gateTools, newGateState } from "../extensions/lang-gate.ts";

const GOPLS = ["mcp__gopls__go_search", "mcp__gopls__go_diagnostics"];
const CCLSP = ["mcp__cclsp__find_definition", "mcp__cclsp__get_diagnostics"];
const BASE = ["read", "edit", "bash"];
const ALL = [...BASE, ...GOPLS, ...CCLSP];

const dir = (name: string): DirEntry => ({ name, dir: true });
const file = (name: string): DirEntry => ({ name, dir: false });

/** A fake workspace: `tree` maps a directory to its entries; `git` is the repository root. */
function workspace(tree: Record<string, (string | DirEntry)[]>, git = "/repo") {
	const entries = (path: string) => {
		const key = path.replace(/\/$/, "");
		const list = (tree[key] ?? []).map((entry) => (typeof entry === "string" ? { name: entry, dir: false } : entry));
		if (key === git && !list.some((entry) => entry.name === ".git")) list.push({ name: ".git", dir: false });
		return list;
	};
	const exists = (path: string) => {
		const cut = path.lastIndexOf("/");
		const parent = path.slice(0, cut) || "/";
		const name = path.slice(cut + 1);
		return entries(parent).some((entry) => entry.name === name);
	};
	return { exists, list: entries, markers: () => detectMarkers("/repo", exists, entries) };
}

test("a Go-only workspace keeps gopls and drops cclsp", () => {
	const ws = workspace({ "/repo": [file("go.mod")] });
	assert.deepEqual(ws.markers(), { go: true, cclsp: false });
	const tools = gateTools(ALL, ALL, ws.markers());
	assert.ok(tools.includes(GOPLS[0]));
	assert.ok(!tools.includes(CCLSP[0]));
	assert.ok(BASE.every((name) => tools.includes(name)), "unrelated tools are untouched");
});

test("a Go workspace with templ files keeps both servers", () => {
	const ws = workspace({ "/repo": [file("go.mod"), dir("components")], "/repo/components": [file("page.templ")] });
	assert.deepEqual(ws.markers(), { go: true, cclsp: true });
	const tools = gateTools(ALL, ALL, ws.markers());
	assert.ok(tools.includes(GOPLS[0]) && tools.includes(CCLSP[0]));
});

test("a Go workspace with Tailwind config keeps cclsp", () => {
	const ws = workspace({ "/repo": [file("go.mod"), file("tailwind.config.ts")] });
	assert.deepEqual(ws.markers(), { go: true, cclsp: true });
});

test("a Rust workspace keeps cclsp and drops gopls", () => {
	const ws = workspace({ "/repo": [file("Cargo.toml")] });
	assert.deepEqual(ws.markers(), { go: false, cclsp: true });
	const tools = gateTools(ALL, ALL, ws.markers());
	assert.ok(!tools.includes(GOPLS[0]));
	assert.ok(tools.includes(CCLSP[0]));
});

test("markers are found from a nested working directory", () => {
	const ws = workspace({ "/repo": [file("go.mod")], "/repo/internal": [dir("deep")] });
	assert.equal(detectMarkers("/repo/internal/deep", ws.exists, ws.list).go, true);
});

test("a monorepo detects manifests in project subdirectories", () => {
	const ws = workspace({
		"/repo": [dir("services"), dir("tools")],
		"/repo/services": [dir("api")],
		"/repo/services/api": [file("go.mod")],
		"/repo/tools": [dir("cli")],
		"/repo/tools/cli": [file("Cargo.toml")],
	});
	assert.deepEqual(ws.markers(), { go: true, cclsp: true });
});

test("templ files are found below the first project levels", () => {
	const ws = workspace({
		"/repo": [file("go.mod"), dir("internal")],
		"/repo/internal": [dir("ui")],
		"/repo/internal/ui": [dir("views")],
		"/repo/internal/ui/views": [dir("components")],
		"/repo/internal/ui/views/components": [file("page.templ")],
	});
	assert.deepEqual(ws.markers(), { go: true, cclsp: true });
});

test("a workspace without language markers loses both servers", () => {
	const ws = workspace({ "/repo": [file("README.md")] });
	assert.deepEqual(ws.markers(), { go: false, cclsp: false });
	assert.deepEqual(gateTools(ALL, ALL, ws.markers()), BASE);
});

test("templ files are not found by descending into dependency directories", () => {
	const ws = workspace({
		"/repo": [file("go.mod"), dir("node_modules")],
		"/repo/node_modules": [dir("pkg")],
		"/repo/node_modules/pkg": [file("x.templ")],
	});
	assert.equal(ws.markers().cclsp, false);
});

test("markers are not read above the repository root", () => {
	const ws = workspace({ "/repo": [], "/": [file("Cargo.toml")] });
	assert.equal(ws.markers().cclsp, false);
});

test("an explicit opt-out is never re-enabled", () => {
	const tools = gateTools([...BASE, ...CCLSP], ALL, { go: true, cclsp: true });
	assert.ok(!tools.includes(GOPLS[0]), "gopls had no active tools, so the user excluded it");
	assert.ok(tools.includes(CCLSP[0]));
});

test("re-gating restores only the tools the gate itself removed", () => {
	const state = newGateState();
	const go = gateTools(ALL, ALL, { go: true, cclsp: false }, state);
	assert.ok(!go.includes(CCLSP[0]));

	const rust = gateTools(go, ALL, { go: false, cclsp: true }, state);
	assert.ok(rust.includes(CCLSP[0]), "cclsp comes back in a Rust workspace");
	assert.ok(!rust.includes(GOPLS[0]), "gopls is dropped in a Rust workspace");
});

test("a tool the user disabled separately is not restored with the server", () => {
	const state = newGateState();
	const userActive = [...BASE, GOPLS[0]]; // go_diagnostics stays intentionally inactive
	const off = gateTools(userActive, ALL, { go: false, cclsp: false }, state);
	assert.deepEqual(off, BASE);

	const back = gateTools(off, ALL, { go: true, cclsp: false }, state);
	assert.deepEqual(back, [...BASE, GOPLS[0]]);
});

test("a server that is not configured stays absent", () => {
	assert.deepEqual(gateTools(BASE, BASE, { go: true, cclsp: true }), BASE);
});

test("moving the session to another repository re-gates both servers", async () => {
	const goRepo = mkdtempSync(join(tmpdir(), "pi-lang-gate-go-"));
	writeFileSync(join(goRepo, "go.mod"), "module x\n");
	writeFileSync(join(goRepo, ".git"), "");
	const rustRepo = mkdtempSync(join(tmpdir(), "pi-lang-gate-rust-"));
	writeFileSync(join(rustRepo, "Cargo.toml"), '[package]\nname = "a"\nversion = "0.1.0"\n');
	writeFileSync(join(rustRepo, ".git"), "");

	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	let active = [...ALL];
	langGate({
		on: (type: string, fn: never) => {
			handlers.set(type, fn);
			return () => {};
		},
		registerCommand: () => {},
		getAllTools: () => ALL.map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	} as never);

	const ctx = (cwd: string) => ({ cwd, ui: { notify: () => {} } });
	await handlers.get("session_start")?.({ reason: "startup" }, ctx(goRepo));
	assert.ok(!active.some((name) => name.startsWith("mcp__cclsp__")), "cclsp dropped in a Go repo");

	await handlers.get("before_agent_start")?.({}, ctx(rustRepo));
	assert.ok(active.some((name) => name.startsWith("mcp__cclsp__")), "cclsp restored in a Rust repo");
	assert.ok(!active.some((name) => name.startsWith("mcp__gopls__")), "gopls dropped in a Rust repo");
});

test("gating catches MCP tools that connect after session start", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	let all = [...BASE];
	let active = [...BASE];

	langGate({
		on: (type: string, fn: never) => {
			handlers.set(type, fn);
			return () => {};
		},
		registerCommand: () => {},
		getAllTools: () => all.map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	} as never);

	// The extension reads the real filesystem, so give it a real (empty) Rust repo.
	const repo = mkdtempSync(join(tmpdir(), "pi-lang-gate-test-"));
	writeFileSync(join(repo, "Cargo.toml"), '[package]\nname = "a"\nversion = "0.1.0"\n');
	writeFileSync(join(repo, ".git"), "");
	const ctx = { cwd: repo, ui: { notify: () => {} } };

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(active, BASE, "nothing to gate before a server connects");

	// The servers connect in the background and register their direct tools, which activates them.
	// Pi emits `mcp_servers_change` only for extension-registered servers, so the gate has to poll.
	all = [...ALL];
	active = [...ALL];
	t.mock.timers.tick(250);
	assert.ok(!active.some((name) => name.startsWith("mcp__gopls__")), "gopls removed once visible");
	assert.ok(active.some((name) => name.startsWith("mcp__cclsp__")));

	const settled = [...active];
	t.mock.timers.tick(250);
	assert.deepEqual(active, settled, "polling stops once both servers are visible");
});

test("turning gating off restores its removals and stops re-gating", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notices: string[] = [];
	let active = [...ALL];

	langGate({
		on: (type: string, fn: never) => {
			handlers.set(type, fn);
			return () => {};
		},
		registerCommand: (name: string, options: never) => commands.set(name, options),
		getAllTools: () => ALL.map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	} as never);

	const repo = mkdtempSync(join(tmpdir(), "pi-lang-gate-test-"));
	writeFileSync(join(repo, "Cargo.toml"), '[package]\nname = "a"\nversion = "0.1.0"\n');
	writeFileSync(join(repo, ".git"), "");
	const ctx = { cwd: repo, ui: { notify: (message: string) => notices.push(message) } };

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.ok(!active.some((name) => name.startsWith("mcp__gopls__")), "gopls dropped in a Rust repo");

	await handlers.get("before_agent_start")?.({}, ctx);
	assert.ok(!active.some((name) => name.startsWith("mcp__gopls__")), "re-gating is idempotent");

	await commands.get("lang-gate")?.handler("off", ctx);
	assert.ok(active.some((name) => name.startsWith("mcp__gopls__")), "off restores tools the gate removed");
	const before = [...active];
	await handlers.get("before_agent_start")?.({}, ctx);
	assert.deepEqual(active, before, "off stops all gating");

	await commands.get("lang-gate")?.handler("on", ctx);
	assert.ok(!active.some((name) => name.startsWith("mcp__gopls__")), "on re-applies");

	await commands.get("lang-gate")?.handler("status", ctx);
	assert.match(notices.at(-1) ?? "", /go=false cclsp=true/);
});
