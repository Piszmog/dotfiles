/**
 * Shell Gate
 *
 * Decides whether a shell command may run: `allow`, `ask`, or `deny`. Modelled on Pi's
 * `examples/extensions/permission-gate.ts`: a `tool_call` hook, `ctx.ui.select` for prompts,
 * and a hard block when there is no UI (print/RPC mode has nobody to ask).
 *
 * Rules are ordered `{ pattern, effect }` entries, first to last, and the last match wins. That
 * ordering is what makes exceptions possible: a broad `allow` comes first, then the narrower
 * `ask` that carves out of it (deleting branches), then the `deny` that carves out of both
 * (force-pushing). A pattern ending in ` *` also matches the command without arguments, the same
 * way OpenCode treats `git status *`.
 *
 * Compound commands are split on `&&`, `||`, `;`, and `|` outside quotes, and every part is
 * checked. `git commit -m "a; b"` stays one command.
 *
 * A heredoc body is split line by line and never quote-lexed, because the shell does not lex it
 * either: `cat <<'EOF'` followed by `echo it's fine` must not leave a quote open over the rest of
 * the script. Body lines are still judged as commands, so `bash <<'EOF'` cannot smuggle one.
 * Line breaks inside a real quote stay in one part, so `*` matches across them (`s` flag).
 *
 * `--no-verify` is also denied through its short form. The flag cluster is parsed rather than
 * pattern-matched, because `git log -n 5` and `git commit -m "fix -n handling"` both contain `-n`
 * without meaning it.
 *
 * Rules come from `~/.config/pi/shell-gate.json` (`{ "rules": [...] }`), appended after the
 * built-in defaults so they win. Editing that file needs `/reload`.
 *
 * Toggle at runtime: /shell-gate off | on | status
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Effect = "allow" | "ask" | "deny";

export interface Rule {
	pattern: string;
	effect: Effect;
}

/**
 * Built-in defaults. Order matters: broad allows, then narrow asks that carve out of them, then
 * broad asks that leave room for the denies below, then the denies themselves.
 */
export const DEFAULT_RULES: Rule[] = [
	// Reads and routine Git.
	{ pattern: "git status *", effect: "allow" },
	{ pattern: "git diff *", effect: "allow" },
	{ pattern: "git log *", effect: "allow" },
	{ pattern: "git show *", effect: "allow" },
	{ pattern: "git branch *", effect: "allow" },
	{ pattern: "git fetch *", effect: "allow" },
	{ pattern: "git add *", effect: "allow" },
	{ pattern: "git commit *", effect: "allow" },
	// Rebase onto a remote-tracking ref, plus conflict recovery. Any other rebase asks.
	{ pattern: "git rebase origin/*", effect: "allow" },
	{ pattern: "git rebase --continue", effect: "allow" },
	{ pattern: "git rebase --abort", effect: "allow" },
	{ pattern: "git rebase --skip", effect: "allow" },
	// Toolchains.
	{ pattern: "go test *", effect: "allow" },
	{ pattern: "go vet *", effect: "allow" },
	{ pattern: "go build *", effect: "allow" },
	{ pattern: "go doc *", effect: "allow" },
	{ pattern: "gopls *", effect: "allow" },
	{ pattern: "templ generate *", effect: "allow" },
	{ pattern: "cargo build *", effect: "allow" },
	{ pattern: "cargo check *", effect: "allow" },
	{ pattern: "cargo test *", effect: "allow" },
	{ pattern: "cargo clippy *", effect: "allow" },
	{ pattern: "cargo fmt *", effect: "allow" },
	{ pattern: "cargo run *", effect: "allow" },
	{ pattern: "cargo doc *", effect: "allow" },
	{ pattern: "cargo nextest *", effect: "allow" },
	{ pattern: "just *", effect: "allow" },
	{ pattern: "make *", effect: "allow" },
	// Inspection.
	{ pattern: "ls *", effect: "allow" },
	{ pattern: "cat *", effect: "allow" },
	{ pattern: "head *", effect: "allow" },
	{ pattern: "wc *", effect: "allow" },
	{ pattern: "fd *", effect: "allow" },
	{ pattern: "rg *", effect: "allow" },
	{ pattern: "jq *", effect: "allow" },
	{ pattern: "gh pr view *", effect: "allow" },
	{ pattern: "gh issue view *", effect: "allow" },

	// Exceptions to `git branch *`: deleting or renaming a branch is not routine.
	{ pattern: "git branch -D *", effect: "ask" },
	{ pattern: "git branch -d *", effect: "ask" },
	{ pattern: "git branch --delete *", effect: "ask" },
	{ pattern: "git branch -m *", effect: "ask" },

	// Broad asks that leave the specific denies below room to win.
	{ pattern: "git push *", effect: "ask" },
	{ pattern: "rm -rf *", effect: "ask" },

	// Hard denies: irreversible or hostile.
	{ pattern: "git push --force*", effect: "deny" },
	{ pattern: "git push -f*", effect: "deny" },
	{ pattern: "git push * main", effect: "deny" },
	{ pattern: "git push * master", effect: "deny" },
	{ pattern: "*--no-verify*", effect: "deny" },
	{ pattern: "git add -A*", effect: "deny" },
	{ pattern: "git add --all*", effect: "deny" },
	{ pattern: "git add .", effect: "deny" },
	{ pattern: "sudo *", effect: "deny" },
	{ pattern: "rm -rf /", effect: "deny" },
	{ pattern: "rm -rf ~", effect: "deny" },
	{ pattern: "rm -rf ~/", effect: "deny" },
	{ pattern: "rm -rf $HOME", effect: "deny" },
];

/** Split a command on `&&`, `||`, `;`, and `|` outside single and double quotes. */
/** A heredoc opener on a line: `<<EOF`, `<<-'EOF'`. `<<<` is a here-string, not a heredoc. */
export function heredocOpener(line: string): { delim: string; stripTabs: boolean } | undefined {
	const match = /<<(?![<])(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
	if (!match) return undefined;
	return { delim: match[3] ?? "", stripTabs: match[1] === "-" };
}

export function splitCommands(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let skipSpace = false;
	let quote: '"' | "'" | undefined;
	let heredoc: { delim: string; stripTabs: boolean } | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index] ?? "";
		if (heredoc) {
			if (char !== "\n") {
				current += char;
				continue;
			}
			const line = heredoc.stripTabs ? current.replace(/^\t+/, "") : current;
			parts.push(line);
			current = "";
			if (line.trim() === heredoc.delim) heredoc = undefined;
			continue;
		}
		if (skipSpace) {
			if (char === " " || char === "\t") continue;
			skipSpace = false;
		}
		if (quote) {
			current += char;
			if (char === "\\" && quote === '"') {
				// Keep the escaped character with its backslash so the text is unchanged.
				const next = command[index + 1];
				if (next !== undefined) {
					current += next;
					index += 1;
				}
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "\n") {
			// A `for`/`select` header can wrap: keep joining until `do` closes it.
			if (headerOpen(current)) {
				current = `${current.trimEnd()} `;
				skipSpace = true;
				continue;
			}
			parts.push(current);
			heredoc = heredocOpener(current);
			current = "";
			continue;
		}
		const pair = command.slice(index, index + 2);
		if (pair === "&&" || pair === "||") {
			parts.push(current);
			current = "";
			index += 1;
			continue;
		}
		if (char === ";" || char === "|") {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

/** True while a wrapped `for`/`select` header is still waiting for its `do`. */
function headerOpen(part: string): boolean {
	return /^(?:for|select)\b/.test(part) && !/\bdo\b/.test(part);
}

/** Reserved words that prefix a command on the same line. */
const PREFIX_WORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time"]);

/**
 * Strip leading shell keywords so `do rm -rf x` is judged as `rm -rf x`.
 * `for x in a b do cmd` collapses to `cmd`, so the loop body is still checked.
 */
export function stripKeywords(command: string): string {
	let rest = command.trim();
	for (;;) {
		const header = /^(?:for|select)\b[\s\S]*?\bdo\s+([\s\S]+)$/.exec(rest);
		if (header) {
			rest = (header[1] ?? "").trim();
			continue;
		}
		const match = /^(\S+)\s+([\s\S]+)$/.exec(rest);
		if (!match || !PREFIX_WORDS.has(match[1] ?? "")) return rest;
		rest = (match[2] ?? "").trim();
	}
}

/**
 * A `for`/`select` header that is only a word list. Its body is checked on the next part, so
 * allowing the header cannot smuggle a command.
 */
export function isLoopHeader(parts: string[], index: number): boolean {
	const part = stripKeywords(parts[index] ?? "");
	if (!/^(?:for|select)\b/.test(part) || /\bdo\b/.test(part)) return false;
	return /^do\b/.test((parts[index + 1] ?? "").trim());
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-command glob: `*` matches any run of characters. A trailing ` *` also matches bare. */
export function matches(pattern: string, command: string): boolean {
	// `s` so `*` spans newlines: a quoted multi-line argument is still one command.
	const toRegExp = (source: string) => new RegExp(`^${source.split("*").map(escapeRegExp).join(".*")}$`, "s");
	if (toRegExp(pattern).test(command)) return true;
	if (pattern.endsWith(" *")) return toRegExp(pattern.slice(0, -2)).test(command);
	return false;
}

/**
 * Collapse whitespace runs and trim. The shell treats `rm  -rf` and `rm -rf` as the same command,
 * so a pattern that misses the padded form would let it dodge the rule.
 */
export function normalizeSpacing(command: string): string {
	return command.replace(/[ \t]+/g, " ").trim();
}

/** Last matching rule wins; a command nothing matches on asks. */
export function decideRule(rules: Rule[], command: string): { effect: Effect; pattern?: string } {
	let effect: Effect = "ask";
	let pattern: string | undefined;
	const subject = normalizeSpacing(command);
	for (const rule of rules) {
		if (matches(rule.pattern, subject)) {
			effect = rule.effect;
			pattern = rule.pattern;
		}
	}
	return { effect, pattern };
}

export function decide(rules: Rule[], command: string): Effect {
	return decideRule(rules, command).effect;
}

/** Why a part got its effect: the winning rule, or the default when nothing matched. */
function because(pattern: string | undefined): string {
	return pattern === undefined ? "no rule matched, so the default is ask" : `last matching rule: \`${pattern}\``;
}

/** Whitespace split that keeps quoted arguments whole and drops the quotes. */
function tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;
	for (const char of command) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			current += char;
			started = true;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}
	if (started) tokens.push(current);
	return tokens;
}

/**
 * True when a `git commit` passes `-n` (the short form of `--no-verify`) in its flag cluster.
 * Stops after a message flag so `git commit -m "fix -n handling"` is not mistaken for the flag.
 */
export function hasNoVerifyFlag(command: string): boolean {
	const tokens = tokenize(command);
	const at = tokens.indexOf("commit");
	if (at === -1) return false;
	for (let index = at + 1; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token === "--") break;
		if (token === "-m" || token === "--message" || token.startsWith("--message=")) {
			if (!token.includes("=")) index += 1;
			continue;
		}
		if (!token.startsWith("-") || token.startsWith("--")) continue;
		// A short flag cluster: `-n`, `-an`, `-amn`. `m` consumes the next token as its value.
		const cluster = token.slice(1);
		if (cluster.includes("n")) return true;
		if (cluster.includes("m")) index += 1;
	}
	return false;
}

interface LoadedRules {
	rules: Rule[];
	source: "defaults" | "file" | "defaults+file";
	error?: string;
}

function isRule(value: unknown): value is Rule {
	if (typeof value !== "object" || value === null) return false;
	const rule = value as Record<string, unknown>;
	return typeof rule.pattern === "string" && (rule.effect === "allow" || rule.effect === "ask" || rule.effect === "deny");
}

/** Built-in defaults, with `~/.config/pi/shell-gate.json` entries appended so they win. */
export function loadRules(path = join(homedir(), ".config", "pi", "shell-gate.json")): LoadedRules {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { rules: DEFAULT_RULES, source: "defaults" };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		const list = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown } | null)?.rules;
		if (!Array.isArray(list)) {
			return { rules: DEFAULT_RULES, source: "defaults", error: `${path}: no "rules" array` };
		}
		const accepted = list.filter(isRule);
		const rejected = list.length - accepted.length;
		return {
			rules: [...DEFAULT_RULES, ...accepted],
			source: accepted.length > 0 ? "defaults+file" : "defaults",
			error: rejected > 0 ? `${path}: ${rejected} invalid rule(s) ignored` : undefined,
		};
	} catch (error) {
		return { rules: DEFAULT_RULES, source: "defaults", error: `${path}: ${String(error)}` };
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	const loaded = loadRules();
	/** Commands approved with "allow this session". */
	const approved = new Set<string>();

	const firstLine = (text: string, max = 200) => {
		const line = text.trim().split("\n")[0] ?? "";
		return line.length > max ? `${line.slice(0, max)}…` : line;
	};

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const input = event.input as Record<string, unknown>;
		const command = typeof input.command === "string" ? input.command : "";
		if (!command.trim()) return undefined;

		if (hasNoVerifyFlag(command)) {
			return {
				block: true,
				reason:
					"Blocked: `-n` is `--no-verify`, which skips pre-commit hooks. Fix the hook failure instead, or ask the user to run it.",
			};
		}

		const raw = splitCommands(command);
		for (let index = 0; index < raw.length; index += 1) {
			const part = stripKeywords(raw[index] ?? "");
			if (!part) continue;
			if (isLoopHeader(raw, index)) continue;
			if (approved.has(raw[index] ?? "") || approved.has(part)) continue;
			const { effect, pattern } = decideRule(loaded.rules, part);
			if (effect === "allow") continue;
			if (effect === "deny") {
				return {
					block: true,
					reason: `Blocked: \`${firstLine(part)}\` is denied by shell-gate (${because(pattern)}). Do not retry it another way; report the blocked command to the user.`,
				};
			}
			// effect === "ask"
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `Blocked: \`${firstLine(part)}\` needs approval and there is no UI to ask (${because(pattern)}). Run it yourself, or pass --tools to drop bash.`,
				};
			}
			const choice = await ctx.ui.select(
				`Run this command?\n\n  ${firstLine(raw[index] ?? "", 400)}\n\n  part ${index + 1} of ${raw.length} · ${because(pattern)}\n`,
				["Allow once", "Allow for this session", "Block"],
			);
			if (choice === "Allow for this session") {
				approved.add(part);
				continue;
			}
			if (choice !== "Allow once") {
				return {
					block: true,
					reason: `Blocked: \`${firstLine(part)}\` was not approved. Report it to the user instead of trying another route.`,
				};
			}
		}
		return undefined;
	});

	pi.registerCommand("shell-gate", {
		description: "Show or toggle the shell command gate (on|off|status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off") enabled = false;
			else if (action === "on") enabled = true;
			else if (action && action !== "status") {
				ctx.ui.notify("Usage: /shell-gate [on|off|status]", "warning");
				return;
			}
			const notes = [`Shell gate ${enabled ? "on" : "off"} (${loaded.rules.length} rules, ${loaded.source})`];
			if (loaded.error) notes.push(loaded.error);
			if (approved.size > 0) notes.push(`${approved.size} command(s) approved this session`);
			ctx.ui.notify(notes.join("\n"), enabled ? "info" : "warning");
		},
	});
}
