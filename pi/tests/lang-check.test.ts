/**
 * Tests for the lang-check extension. Run from the pi config directory:
 *
 *   node --test 'tests/*.test.ts'
 *
 * Node strips the TypeScript types, so there is no build step. Binary calls are stubbed: these
 * tests pin the parsing and the decisions the extension makes, not gopls or cargo themselves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import langCheck, {
	cargoEdition,
	generatedPath,
	parseCargoCheck,
	parseGoCheck,
	parseTemplGenerate,
	templSourceHint,
	workspaceRootFor,
} from "../extensions/lang-check.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	cwd: string | undefined;
}

type Exec = (command: string, args: string[], options?: { cwd?: string }) => Promise<{
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}>;

const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
const failed = (stderr = "", code = 1) => ({ stdout: "", stderr, code, killed: false });

function harness(exec: Exec) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	langCheck({
		on: (type: string, fn: never) => {
			handlers.set(type, fn);
			return () => {};
		},
		registerCommand: (name: string, options: never) => commands.set(name, options),
		exec,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
	} as never);
	const edited = async (path: string, cwd: string, extra: Record<string, unknown> = {}) =>
		(await handlers.get("tool_result")?.(
			{ toolName: "edit", isError: false, input: { path }, content: [{ type: "text", text: "Edited" }] },
			{ cwd, ...extra },
		)) as { content: { type: "string"; text: string }[] } | undefined;
	return { edited, commands };
}

/** Record every call and answer through `reply`. */
function recorder(reply: (call: ExecCall) => ReturnType<Exec> extends Promise<infer R> ? R : never) {
	const calls: ExecCall[] = [];
	const exec: Exec = async (command, args, options) => {
		const call = { cmd: command, args, cwd: options?.cwd };
		calls.push(call);
		return reply(call);
	};
	return { calls, exec };
}

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lang-check-test-"));
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return root;
}

const summary = (result: { content: { text: string }[] } | undefined) => result?.content.at(-1)?.text.trim() ?? "";

test("parseGoCheck makes paths module-relative and drops noise", () => {
	const output = [
		"/m/go/a.go:3:5-9: cannot use x",
		"gopls: some banner",
		"/m/go/b.go:1:1: undefined: y",
	].join("\n");
	assert.deepEqual(parseGoCheck(output, ["/m/go"]), ["a.go:3:5 cannot use x", "b.go:1:1 undefined: y"]);
	assert.deepEqual(parseGoCheck(output, "/m/go", (file) => (file === "/m/go/a.go" ? "a.go" : undefined)), [
		"a.go:3:5 cannot use x",
		"b.go:1:1 undefined: y",
	]);
});

test("parseCargoCheck dedupes replayed errors and counts other files", () => {
	const message = (file: string, level = "error") =>
		JSON.stringify({
			reason: "compiler-message",
			message: {
				level,
				message: "mismatched types",
				code: { code: "E0308" },
				spans: [{ file_name: file, line_start: 2, column_start: 18, is_primary: true }],
			},
		});
	const stream = [message("src/lib.rs"), message("src/lib.rs"), message("src/other.rs"), message("src/lib.rs", "warning"), "not json"].join("\n");

	const all = parseCargoCheck(stream);
	assert.equal(all.errors.length, 2, "lib.rs once, other.rs once");
	assert.equal(all.others, 0);

	const scoped = parseCargoCheck(stream, ["src/lib.rs"]);
	assert.deepEqual(scoped.errors, ["error[E0308]: mismatched types (src/lib.rs:2:18)"]);
	assert.equal(scoped.others, 1);
});

test("cargoEdition reads [package] and inherited workspace editions", () => {
	const standalone = tree({ "Cargo.toml": '[package]\nname = "a"\nedition = "2021"\n' });
	assert.equal(cargoEdition(standalone), "2021");

	const inherited = tree({
		"Cargo.toml": '[workspace]\nmembers = ["m"]\n\n[workspace.package]\nedition = "2024"\n',
		"m/Cargo.toml": '[package]\nname = "m"\nedition.workspace = true\n',
	});
	assert.equal(cargoEdition(join(inherited, "m")), "2024");

	const single = tree({ "Cargo.toml": '[package]\nname = "s"\nedition = \'2021\'\n' });
	assert.equal(cargoEdition(single), "2021");

	const missing = tree({ "Cargo.toml": '[package]\nname = "c"\n' });
	assert.equal(cargoEdition(missing), undefined);
});

test("workspaceRootFor skips manifest-less directories and stops at the repository root", () => {
	const workspace = tree({ ".git/HEAD": "ref\n", "Cargo.toml": "[workspace]\n", "crates/a/Cargo.toml": "[package]\n" });
	assert.equal(workspaceRootFor(join(workspace, "crates/a")), workspace);

	const standalone = tree({ "Cargo.toml": "[package]\n" });
	assert.equal(workspaceRootFor(standalone), standalone);

	const nested = tree({ "Cargo.toml": "[package]\n", "sub/Cargo.toml": "[package]\n" });
	// A crate below another manifest belongs to it (cargo refuses the split), so the walk reports the
	// outer manifest: the key only has to serialize builds that share a target directory.
	assert.equal(workspaceRootFor(join(nested, "sub")), nested);

	const outside = tree({
		"Cargo.toml": "[package]\n",
		"repo/.git/HEAD": "ref\n",
		"repo/Cargo.toml": "[package]\n",
		"repo/crates/a/Cargo.toml": "[package]\n",
	});
	// A manifest above the checkout is never adopted, even when the repository root has one too.
	assert.equal(workspaceRootFor(join(outside, "repo")), join(outside, "repo"));
	assert.equal(workspaceRootFor(join(outside, "repo/crates/a")), join(outside, "repo"));
});

test("rust formatting passes the crate edition and stays scoped to the edited file", async () => {
	const crate = tree({
		"Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
		"src/lib.rs": "pub async fn root() -> i32 {\n        1\n}\n",
		"src/other.rs": "pub async fn other() -> i32 {\n        2\n}\n",
	});
	const { calls, exec } = recorder((call) => {
		if (call.cmd === "rustfmt") {
			// `--check` exits 1 with a diff on stdout when the file is not formatted.
			return call.args.includes("--check")
				? { stdout: "Diff in src/lib.rs:1:\n", stderr: "", code: 1, killed: false }
				: ok();
		}
		return ok(JSON.stringify({ reason: "build-finished", success: true }));
	});
	const { edited } = harness(exec);

	const text = summary(await edited("src/lib.rs", crate));
	assert.match(text, /rustfmt: reformatted/);
	const writes = calls.filter((call) => call.cmd === "rustfmt" && !call.args.includes("--check"));
	assert.equal(writes.length, 1);
	assert.ok(writes[0]?.args.includes("--edition"), "rustfmt needs an explicit edition");
	assert.ok(writes[0]?.args.includes("2021"));
	assert.ok(writes[0]?.args.includes("skip_children=true"));
	assert.deepEqual(writes[0]?.args.filter((arg) => arg.endsWith(".rs")), ["src/lib.rs"]);
});

test("a rust file that cannot be parsed is reported instead of skipped in silence", async () => {
	const crate = tree({ "Cargo.toml": '[package]\nname = "a"\nedition = "2021"\n', "src/lib.rs": "pub fn (\n" });
	const { exec } = recorder((call) =>
		call.cmd === "rustfmt" ? failed("error: expected one of `!` or `::`, found `(`") : ok(),
	);
	const { edited } = harness(exec);
	const text = summary(await edited("src/lib.rs", crate));
	assert.match(text, /rustfmt: skipped \(error: expected/);
});

test("missing tooling is reported, not silently ignored", async () => {
	const module = tree({ "go.mod": "module x\n", "a.go": "package main\n" });
	const { exec } = recorder(() => failed());
	const { edited } = harness(exec);
	const text = summary(await edited("a.go", module));
	assert.match(text, /unavailable: gopls not installed/);
});

test("a missing binary is reported once, not on every edit", async () => {
	const module = tree({ "go.mod": "module x\n", "a.go": "package main\n" });
	const { calls, exec } = recorder(() => failed());
	const { edited } = harness(exec);
	assert.match(summary(await edited("a.go", module)), /unavailable: gopls not installed/);
	assert.equal(await edited("a.go", module), undefined, "the second edit says nothing");
	assert.equal(calls.filter((call) => call.cmd === "gopls").length, 1, "gopls is not retried");
});

test("one gopls invocation covers every file of a burst", async () => {
	const module = tree({
		"go.mod": "module x\n",
		"a.go": "package main\n",
		"b.go": "package main\n",
		"c.go": "package main\n",
	});
	const { calls, exec } = recorder(() => ok());
	const { edited } = harness(exec);

	await Promise.all([edited("a.go", module), edited("b.go", module), edited("c.go", module)]);

	const checks = calls.filter((call) => call.cmd === "gopls");
	assert.equal(checks.length, 2, "the first edit checks alone, the next two share one check");
	assert.ok(checks[1]?.args.includes("b.go") && checks[1]?.args.includes("c.go"));
});

test("the first check of a crate is the cold library build, later ones cover all targets", async () => {
	const crate = tree({ "Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": "pub fn a() {}\n" });
	const { calls, exec } = recorder((call) =>
		call.cmd === "rustfmt" ? ok() : ok(JSON.stringify({ reason: "build-finished", success: true })),
	);
	const { edited } = harness(exec);

	await edited("src/lib.rs", crate);
	await edited("src/lib.rs", crate);

	const checks = calls.filter((call) => call.cmd === "cargo");
	assert.equal(checks.length, 2);
	assert.ok(!checks[0]?.args.includes("--all-targets"), "a cold crate builds the library only");
	assert.ok(checks[1]?.args.includes("--all-targets"), "the warm crate checks tests, benches, and examples");
});

test("a clean edit produces no tool output", async () => {
	const module = tree({ "go.mod": "module x\n", "a.go": "package main\n" });
	const { exec } = recorder(() => ok());
	const { edited } = harness(exec);
	assert.equal(await edited("a.go", module), undefined);
});

test("a mixed Go/Rust root checks each language with its own toolchain", async () => {
	const root = tree({
		"go.mod": "module x\n",
		"a.go": "package main\n",
		"Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
		"src/lib.rs": "pub fn a() {}\n",
	});
	const { calls, exec } = recorder((call) => {
		if (call.cmd === "cargo") return ok(JSON.stringify({ reason: "build-finished", success: true }));
		return ok();
	});
	const { edited } = harness(exec);

	await Promise.all([edited("a.go", root), edited("src/lib.rs", root)]);

	assert.ok(calls.some((call) => call.cmd === "gopls" && call.args.includes("a.go")));
	assert.ok(calls.some((call) => call.cmd === "cargo"), "the Rust edit still runs cargo check");
	assert.ok(
		!calls.some((call) => call.cmd === "goimports" && call.args.some((arg) => arg.endsWith(".rs"))),
		"a .rs file must not go through the Go formatter",
	);
	assert.ok(
		!calls.some((call) => call.cmd === "rustfmt" && call.args.some((arg) => arg.endsWith(".go"))),
		"a .go file must not go through the Rust formatter",
	);
});

test("edits that arrive together share one check per batch", async () => {
	const crate = tree({
		"Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
		"src/lib.rs": "pub mod a;\npub mod b;\n",
		"src/a.rs": "pub fn a() {}\n",
		"src/b.rs": "pub fn b() {}\n",
	});
	const { calls, exec } = recorder((call) =>
		call.cmd === "rustfmt" ? ok() : ok(JSON.stringify({ reason: "build-finished", success: true })),
	);
	const { edited } = harness(exec);

	const results = await Promise.all([
		edited("src/lib.rs", crate),
		edited("src/a.rs", crate),
		edited("src/b.rs", crate),
	]);
	const checks = calls.filter((call) => call.cmd === "cargo").length;
	assert.ok(checks <= 2, `expected at most 2 cargo runs for a 3-file burst, got ${checks}`);
	assert.ok(results.filter(Boolean).length <= 2, "the batch reports once, not once per file");
});

test("generatedPath maps a .templ file to its generated Go sibling", () => {
	assert.equal(generatedPath("page.templ"), "page_templ.go");
	assert.equal(generatedPath("web/components/nav.templ"), "web/components/nav_templ.go");
	assert.equal(generatedPath("page.templ.go"), "page.templ.go");
});

test("parseTemplGenerate keeps the .templ path in templ's own errors", () => {
	const output = [
		"generating code: web/nav.templ:12:3: unexpected token",
		"web/nav.templ:20:1: expected end of block",
		"templ: some banner",
	].join("\n");
	assert.deepEqual(parseTemplGenerate(output), [
		"web/nav.templ:12:3 unexpected token",
		"web/nav.templ:20:1 expected end of block",
	]);
});

test("templSourceHint finds the nearest templ.Error in the generated file", () => {
	const root = tree({
		"page_templ.go": [
			"package ui",
			"",
			"func render() {",
			'\ttempl.Error{Err: nil, FileName: "page.templ", Line: 12, Col: 3}',
			"}",
			"",
		].join("\n"),
	});
	const file = join(root, "page_templ.go");
	assert.equal(templSourceHint(file, 3), "page.templ:12");
	assert.equal(templSourceHint(file, 40), undefined, "no error struct in the window");
	assert.equal(templSourceHint(join(root, "missing_templ.go"), 1), undefined);
});

test("a .templ edit runs templ generate then gopls check and annotates the source", async () => {
	const module = tree({
		"go.mod": "module example.com/ui\n",
		"web/nav.templ": "package ui\n",
		"web/nav_templ.go": [
			"package ui",
			"",
			"func render() {",
			'\ttempl.Error{Err: nil, FileName: "web/nav.templ", Line: 7, Col: 2}',
			"}",
			"",
		].join("\n"),
	});
	const { calls, exec } = recorder((call) => {
		if (call.cmd === "templ") return ok("generated web/nav_templ.go\n");
		return failed("web/nav_templ.go:3:2: undefined: render\n");
	});
	const { edited } = harness(exec);

	const text = summary(await edited("web/nav.templ", module));

	assert.deepEqual(
		calls.map((call) => call.cmd),
		["templ", "gopls"],
	);
	assert.deepEqual(calls[0]?.args.slice(0, 2), ["generate", "-f"]);
	assert.ok(calls[0]?.args.includes("web/nav.templ"), "generate targets the edited template");
	assert.ok(calls[1]?.args.includes("web/nav_templ.go"), "gopls checks the generated file");
	assert.match(text, /web\/nav_templ\.go:3:2 undefined: render/);
	assert.match(text, /near web\/nav\.templ:7, approximate/);
});

test("a missing templ binary is reported once, without a gopls run", async () => {
	const module = tree({ "go.mod": "module example.com/ui\n", "page.templ": "package ui\n" });
	const { calls, exec } = recorder(() => failed());
	const { edited } = harness(exec);

	const text = summary(await edited("page.templ", module));

	assert.equal(calls.filter((call) => call.cmd === "gopls").length, 0);
	assert.match(text, /templ not installed/);
});
