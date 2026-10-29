/**
 * Language Check
 *
 * After a successful edit/write of a `.go` or `.rs` file, format the file, run a fast compile
 * check, and append only the problems to the tool result. The model gets `file:line:col`
 * diagnostics in the same turn instead of having to remember to run a build.
 *
 * - Go: `goimports -w` (adds missing imports, which `gofmt` cannot), then
 *   `gopls check -severity=error <files>` in the module root (uses gopls' cache, no rebuild).
 *   One invocation covers every edited file; gopls reports each file it was given.
 * - Rust: `rustfmt` on the edited file only, then `cargo check --all-targets --message-format=json`
 *   in the crate directory. `--all-targets` is required: plain `cargo check` does not type-check
 *   `tests/`, `benches/`, or `#[cfg(test)]` modules. The first check of a crate in this process is
 *   the expensive cold build, so it covers the library only and every later check gets the full
 *   target set; a timed-out cold build still leaves the cache warm for the next one.
 *
 * Two things are deliberately not the obvious choice:
 *
 * - `rustfmt <file>` cannot read the edition from `Cargo.toml`; it parses as Rust 2015 and fails
 *   outright on `async fn`, so formatting would silently never happen. The edition is resolved
 *   from the crate manifest (falling back to `[workspace.package]`) and passed explicitly.
 * - `cargo fmt -- <file>` formats the *whole crate*, including files the model never touched.
 *   `rustfmt` with `skip_children` stays scoped to the edited file.
 *
 * `cargo check` type-checks the whole crate, so errors in other files would otherwise be reported
 * on every edit. Only errors in the files edited in this turn are shown; the rest are counted.
 *
 * Edits that land together are coalesced: the first edit of a burst starts a check immediately,
 * later edits join the next one, so a five-file change costs two checks instead of five, and the
 * second summary reflects the state after all of them.
 *
 * Clean results are silent. On errors, at most 15 are shown and the full output is written to
 * the system temp directory. A tool that fails to start is reported once per process, not on
 * every edit.
 *
 * Toggle at runtime: /lang-check off | on | status
 */

import { writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_DIAGNOSTICS = 15;
const FORMAT_TIMEOUT_MS = 60_000;
const GO_TIMEOUT_MS = 120_000;
const RUST_COLD_TIMEOUT_MS = 60_000;
const RUST_TIMEOUT_MS = 180_000;
const SKIP_SEGMENTS = ["/vendor/", "/target/", "/node_modules/", "/.git/"];

export interface CheckResult {
	/** Errors formatted as `location message`, in compiler order. */
	errors: string[];
	/** Formatting the file changed something (reported even when the check is clean). */
	notes?: string[];
	/** Errors the compiler reported in files that were not edited in this turn. */
	others?: number;
	/** Set when the check itself could not run (tool missing, timeout). */
	unavailable?: string;
	/** File holding the complete output when `errors` was truncated for display. */
	log?: string;
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

/** A command that exits non-zero without writing anything failed to start (binary not installed). */
function didNotStart(result: ExecResult): boolean {
	return !result.killed && result.code !== 0 && result.stdout.trim() === "" && result.stderr.trim() === "";
}

function firstLine(text: string, max = 160): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function localTo(root: string, file: string): string {
	const local = relative(root, file);
	return local && !local.startsWith("..") ? local : file;
}

/** `path:line:col[-col]: message` lines printed by `gopls check`. */
export function parseGoCheck(
	output: string,
	moduleRoots?: string | string[],
	alias?: (reported: string) => string | undefined,
): string[] {
	const roots = moduleRoots === undefined ? [] : Array.isArray(moduleRoots) ? moduleRoots : [moduleRoots];
	const errors: string[] = [];
	for (const raw of output.split("\n")) {
		const match = /^(.+?\.go):(\d+):(\d+)(?:-\d+)?:\s+(.+)$/.exec(raw.trim());
		if (!match) continue;
		const [, file = "", line = "", column = "", message = ""] = match;
		// gopls may print the path in the cwd form or the resolved (symlink-free) form.
		let shown = alias?.(file) ?? file;
		if (shown === file) {
			for (const root of roots) {
				const local = relative(root, file);
				if (local && !local.startsWith("..")) {
					shown = local;
					break;
				}
			}
		}
		errors.push(`${shown}:${line}:${column} ${message}`);
	}
	return dedupe(errors);
}

function realpathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
}

/** Whether the formatter ran, was skipped, or is not installed. */
export interface FormatOutcome {
	/** Note for the tool result (reformat happened, or formatting was skipped). */
	note?: string;
	/** The binary is not installed; callers report it once and stop trying. */
	missing?: boolean;
}

/** Format with goimports, which adds missing imports where gofmt only rewrites whitespace. */
async function formatGo(
	pi: ExtensionAPI,
	files: string[],
	moduleRoot: string,
	signal: AbortSignal | undefined,
): Promise<FormatOutcome> {
	const listed = await pi.exec("goimports", ["-l", ...files], { cwd: moduleRoot, timeout: FORMAT_TIMEOUT_MS, signal });
	if (listed.killed) return {};
	if (listed.code !== 0) {
		if (didNotStart(listed)) return { missing: true, note: "goimports: not installed" };
		return { note: `goimports: skipped (${firstLine(listed.stderr) || "parse error"})` };
	}
	const changed = listed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (changed.length === 0) return {};
	const written = await pi.exec("goimports", ["-w", ...changed], { cwd: moduleRoot, timeout: FORMAT_TIMEOUT_MS, signal });
	return { note: written.code === 0 ? "goimports: added imports or reformatted" : "goimports: rewrite failed" };
}

/** TOML allows single- or double-quoted strings; cargo writes double quotes but hand-edited manifests vary. */
function editionOf(manifest: string): string | undefined {
	const match = /^\s*edition\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(manifest);
	return match?.[1] ?? match?.[2];
}

/** Read the crate's edition, which `rustfmt` will not do on its own. */
export function cargoEdition(crateRoot: string): string | undefined {
	let manifest: string;
	try {
		manifest = readFileSync(join(crateRoot, "Cargo.toml"), "utf8");
	} catch {
		return undefined;
	}
	const direct = editionOf(manifest);
	if (direct) return direct;
	const inherited = /^\s*edition\s*(?:\.\s*workspace\s*=\s*true|\s*=\s*\{\s*workspace\s*=\s*true\s*\})/m.test(manifest);
	if (!inherited) return undefined;
	const workspace = workspaceRootFor(crateRoot);
	if (workspace === crateRoot) return undefined;
	try {
		return editionOf(readFileSync(join(workspace, "Cargo.toml"), "utf8"));
	} catch {
		return undefined;
	}
}

/** Format only the edited files with rustfmt, using the crate's edition. */
async function formatRust(
	pi: ExtensionAPI,
	files: string[],
	crateRoot: string,
	signal: AbortSignal | undefined,
): Promise<FormatOutcome> {
	const edition = cargoEdition(crateRoot);
	// skip_children keeps lib.rs/main.rs from pulling in the whole module tree.
	const base = [...(edition ? ["--edition", edition] : []), "--config", "skip_children=true"];
	const check = await pi.exec("rustfmt", [...base, "--check", ...files], {
		cwd: crateRoot,
		timeout: FORMAT_TIMEOUT_MS,
		signal,
	});
	// A file that needs formatting makes `--check` exit 1 and print a diff on stdout; a parse error
	// exits 1 with the compiler error on stderr and no diff, so the write below fails and is reported.
	if (check.killed || check.code === 0) return {};
	if (didNotStart(check)) return { missing: true, note: "rustfmt: not installed" };
	const written = await pi.exec("rustfmt", [...base, ...files], {
		cwd: crateRoot,
		timeout: FORMAT_TIMEOUT_MS,
		signal,
	});
	return written.code === 0 ? { note: "rustfmt: reformatted" } : { note: `rustfmt: skipped (${firstLine(check.stderr)})` };
}

export interface CargoCheckParse {
	/** Errors in the requested files, in compiler order. */
	errors: string[];
	/** How many errors the compiler reported in files that were not requested. */
	others: number;
}

/** Build diagnostics from a `cargo check --message-format=json` stream. */
export function parseCargoCheck(output: string, files?: string[]): CargoCheckParse {
	const wanted = files === undefined ? undefined : new Set(files.map((file) => file.replace(/^\.\//, "")));
	const errors: string[] = [];
	const seen = new Set<string>();
	let others = 0;
	for (const raw of output.split("\n")) {
		if (!raw.startsWith("{")) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		const record = entry as { reason?: string; message?: Record<string, unknown> };
		if (record?.reason !== "compiler-message" || !record.message) continue;
		const message = record.message as {
			level?: string;
			message?: string;
			code?: { code?: string } | null;
			spans?: { file_name?: string; line_start?: number; column_start?: number; is_primary?: boolean }[];
		};
		if (message.level !== "error") continue;
		const spans = message.spans ?? [];
		const span = spans.find((candidate) => candidate.is_primary) ?? spans[0];
		const code = message.code?.code ? `[${message.code.code}]` : "";
		const where = span?.file_name ? ` (${span.file_name}:${span.line_start}:${span.column_start})` : "";
		const text = `error${code}: ${message.message ?? "unknown error"}${where}`;
		if (seen.has(text)) continue;
		seen.add(text);
		const file = span?.file_name?.replace(/^\.\//, "");
		if (wanted && file !== undefined && !wanted.has(file)) {
			others += 1;
			continue;
		}
		errors.push(text);
	}
	return { errors, others };
}

/** Walk up from `start` to the nearest directory containing one of `names`. */
export function findUp(start: string, names: string[], exists: (path: string) => boolean = existsSync) {
	let dir = start;
	for (;;) {
		if (names.some((name) => exists(join(dir, name)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * The workspace root above a crate: cargo shares one target directory (and its build lock) across
 * every member, so checks have to be serialized at that level, not per crate. Workspaces commonly
 * nest members under directories without their own manifest (`crates/a`), so gaps are skipped, and
 * the walk stops at the repository root so a manifest above the checkout is never picked up.
 */
export function workspaceRootFor(crateRoot: string, exists: (path: string) => boolean = existsSync): string {
	let root = crateRoot;
	let dir = crateRoot;
	for (;;) {
		// Stop at the repository root before adopting a manifest above it. `exists` also sees files, so a
		// worktree or submodule (`.git` file) counts, and a stray manifest outside the checkout is ignored.
		if (exists(join(dir, ".git"))) return root;
		const parent = dirname(dir);
		if (parent === dir) return root;
		if (exists(join(parent, "Cargo.toml"))) root = parent;
		dir = parent;
	}
}

/** Paths a compiler may use for one of the edited files, relative or absolute. */
function wantedPaths(crateRoot: string, files: string[]): string[] {
	const workspace = workspaceRootFor(crateRoot);
	const wanted: string[] = [];
	for (const file of files) {
		const real = realpathOrUndefined(file);
		wanted.push(file, localTo(crateRoot, file), localTo(workspace, file));
		if (real) wanted.push(real, localTo(crateRoot, real));
	}
	return wanted;
}

function shouldSkip(file: string): boolean {
	return SKIP_SEGMENTS.some((segment) => file.includes(segment));
}

function writeLog(kind: string, output: string): string | undefined {
	try {
		const path = join(tmpdir(), `pi-lang-check-${kind}-${Date.now()}.log`);
		writeFileSync(path, output);
		return path;
	} catch {
		return undefined;
	}
}

function formatSummary(kind: string, result: CheckResult): string | undefined {
	const lines = [...(result.notes ?? [])];
	if (result.unavailable) lines.push(`unavailable: ${result.unavailable}`);
	if (result.errors.length > 0) {
		const shown = result.errors.slice(0, MAX_DIAGNOSTICS);
		lines.push(`${kind}: ${result.errors.length} error(s)`);
		for (const error of shown) lines.push(`  ${error}`);
		if (result.errors.length > shown.length) {
			const rest = result.errors.length - shown.length;
			lines.push(result.log ? `  … ${rest} more in ${result.log}` : `  … ${rest} more`);
		}
	}
	if (result.others) lines.push(`${result.others} error(s) in other files of this crate, not shown`);
	if (lines.length === 0) return undefined;
	return `[lang-check] ${lines.join("\n")}`;
}

interface Job {
	files: string[];
	signal: AbortSignal | undefined;
	resolvers: ((result: CheckResult | undefined) => void)[];
}

type BatchRunner = (files: string[], signal: AbortSignal | undefined) => Promise<CheckResult>;

const queues = new Map<string, Job>();
const draining = new Set<string>();

/**
 * Queue `file` for a check under `root`. Edits that arrive while a check is running are collected
 * into the next one; only the edit that closes a batch receives its summary, so a multi-file change
 * reports at most two results instead of the same diagnostics once per file.
 */
function enqueue(root: string, file: string, signal: AbortSignal | undefined, run: BatchRunner) {
	return new Promise<CheckResult | undefined>((resolve) => {
		const queued = queues.get(root);
		if (queued) {
			queued.files.push(file);
			queued.resolvers.push(resolve);
			queued.signal = signal;
			return;
		}
		queues.set(root, { files: [file], signal, resolvers: [resolve] });
		void drain(root, run);
	});
}

async function drain(root: string, run: BatchRunner): Promise<void> {
	if (draining.has(root)) return;
	draining.add(root);
	try {
		for (;;) {
			const job = queues.get(root);
			if (!job) break;
			queues.delete(root);
			let result: CheckResult | undefined;
			try {
				result = await run([...new Set(job.files)], job.signal);
			} catch (error) {
				result = { errors: [], unavailable: `check failed (${String(error)})` };
			}
			const last = job.resolvers.length - 1;
			job.resolvers.forEach((resolve, index) => resolve(index === last ? result : undefined));
		}
	} finally {
		draining.delete(root);
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	/** Binaries that failed to start; reported once, then not retried in this process. */
	const missing = new Set<string>();
	/** Crates whose cold build already ran, so checks may include tests, benches, and examples. */
	const warmCrates = new Set<string>();

	const runGoBatch = async (
		moduleRoot: string,
		files: string[],
		signal: AbortSignal | undefined,
	): Promise<CheckResult> => {
		const goFiles = files.filter((file) => file.endsWith(".go"));
		if (goFiles.length === 0) return { errors: [], notes: [] };
		let displayRoot = moduleRoot;
		try {
			displayRoot = realpathSync.native(moduleRoot);
		} catch {
			// Keep the unresolved root; parseGoCheck falls back to the absolute path.
		}
		const targets = goFiles.map((file) => localTo(moduleRoot, file));
		const notes: string[] = [];
		const errors: string[] = [];

		if (!missing.has("goimports")) {
			const formatted = await formatGo(pi, targets, moduleRoot, signal);
			if (formatted.missing) missing.add("goimports");
			if (formatted.note) notes.push(formatted.note);
		}

		if (missing.has("gopls")) return { errors, notes };

		const result = await pi.exec("gopls", ["check", "-severity=error", ...targets], {
			cwd: moduleRoot,
			timeout: GO_TIMEOUT_MS,
			signal,
		});
		if (signal?.aborted) return { errors: [], notes };
		if (result.killed) return { errors, notes, unavailable: "gopls check timed out" };
		if (didNotStart(result)) {
			missing.add("gopls");
			return { errors, notes, unavailable: "gopls not installed" };
		}

		// gopls prints an absolute path, before or after resolving symlinks. Map either form back to the
		// path the model edited; anything else is shown relative to the module by parseGoCheck.
		const aliases = new Map<string, string>();
		for (const [index, target] of targets.entries()) {
			const file = goFiles[index] ?? target;
			aliases.set(target, target);
			aliases.set(file, target);
			const real = realpathOrUndefined(file);
			if (real) aliases.set(real, target);
		}
		const output = `${result.stdout}\n${result.stderr}`;
		errors.push(...parseGoCheck(output, [moduleRoot, displayRoot], (reported) => aliases.get(reported)));

		const unique = dedupe(errors);
		if (unique.length > MAX_DIAGNOSTICS) return { errors: unique, notes, log: writeLog("go", output) };
		return { errors: unique, notes };
	};

	const runRustBatch = async (files: string[], signal: AbortSignal | undefined): Promise<CheckResult> => {
		const rustFiles = files.filter((file) => file.endsWith(".rs"));
		if (rustFiles.length === 0) return { errors: [], notes: [] };
		const byCrate = new Map<string, string[]>();
		for (const file of rustFiles) {
			const crateRoot = findUp(dirname(file), ["Cargo.toml"]);
			if (!crateRoot) continue;
			byCrate.set(crateRoot, [...(byCrate.get(crateRoot) ?? []), file]);
		}

		const notes: string[] = [];
		const errors: string[] = [];
		const outputs: string[] = [];
		let others = 0;
		let unavailable: string | undefined;

		for (const [crateRoot, crateFiles] of byCrate) {
			if (!missing.has("rustfmt")) {
				const formatted = await formatRust(pi, crateFiles.map((file) => localTo(crateRoot, file)), crateRoot, signal);
				if (formatted.missing) missing.add("rustfmt");
				if (formatted.note) notes.push(formatted.note);
			}
			if (missing.has("cargo")) continue;

			// The first check of a crate is the cold one: build the library only so the tool result is
			// not blocked for minutes, then give `--all-targets` the full budget on a warm cache.
			const allTargets = warmCrates.has(crateRoot);
			const result = await pi.exec(
				"cargo",
				["check", ...(allTargets ? ["--all-targets"] : []), "--message-format=json", "--quiet"],
				{ cwd: crateRoot, timeout: allTargets ? RUST_TIMEOUT_MS : RUST_COLD_TIMEOUT_MS, signal },
			);
			if (signal?.aborted) return { errors: [], notes };
			// A timed-out cold build still leaves the cache warm, so the next check gets the full budget.
			warmCrates.add(crateRoot);
			if (result.killed) {
				unavailable = "cargo check timed out (cold build?); the next edit re-runs it";
				continue;
			}
			if (didNotStart(result)) {
				missing.add("cargo");
				unavailable = "cargo not installed";
				continue;
			}

			const parsed = parseCargoCheck(result.stdout, wantedPaths(crateRoot, crateFiles));
			errors.push(...parsed.errors);
			others += parsed.others;
			outputs.push(`${result.stdout}\n${result.stderr}`);
			if (parsed.errors.length === 0 && parsed.others === 0 && result.code !== 0) {
				const tail = result.stderr
					.trim()
					.split("\n")
					.slice(-5)
					.filter(Boolean);
				errors.push(...tail.map((line) => `cargo: ${line}`));
			}
		}

		const unique = dedupe(errors);
		const summary: CheckResult = { errors: unique, notes };
		if (others > 0) summary.others = others;
		if (unavailable) summary.unavailable = unavailable;
		if (unique.length > MAX_DIAGNOSTICS) summary.log = writeLog("rust", outputs.join("\n"));
		return summary;
	};

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled || event.isError) return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
		if (event.input.path === undefined) return undefined;

		const file = resolve(ctx.cwd, String(event.input.path));
		if (shouldSkip(file) || !existsSync(file)) return undefined;

		let kind: string;
		let root: string;
		let run: BatchRunner;
		if (file.endsWith(".go")) {
			const moduleRoot = findUp(dirname(file), ["go.mod", "go.work"]);
			if (!moduleRoot) return undefined;
			kind = "gopls";
			root = `go:${moduleRoot}`;
			run = (files, signal) => runGoBatch(moduleRoot, files, signal);
		} else if (file.endsWith(".rs")) {
			const crateRoot = findUp(dirname(file), ["Cargo.toml"]);
			if (!crateRoot) return undefined;
			kind = "cargo check";
			// A Go module and a Cargo workspace can share a root, so the queue key carries the language.
			root = `rust:${workspaceRootFor(crateRoot)}`;
			run = (files, signal) => runRustBatch(files, signal);
		} else {
			return undefined;
		}

		const result = await enqueue(root, file, ctx.signal, run);
		if (!result) return undefined;
		const summary = formatSummary(kind, result);
		if (!summary) return undefined;

		return {
			content: [...event.content, { type: "text" as const, text: `\n${summary}` }],
		};
	});

	pi.registerCommand("lang-check", {
		description: "Show or toggle post-edit Go/Rust formatting and compile checks (on|off|status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off") enabled = false;
			else if (action === "on") enabled = true;
			else if (action && action !== "status") {
				ctx.ui.notify("Usage: /lang-check [on|off|status]", "warning");
				return;
			}
			ctx.ui.notify(
				`Language check ${enabled ? "on" : "off"} (Go: goimports + gopls check, Rust: rustfmt + cargo check --all-targets)`,
				enabled ? "info" : "warning",
			);
		},
	});
}
