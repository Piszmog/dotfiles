/**
 * Regression corpus for the shell gate.
 *
 * Every prompt the user sees for a harmless command is a parser bug, not a policy choice: the
 * config is allow-by-default, so the catch-all `*` rule is supposed to swallow anything no
 * narrower rule claims. A part that reaches the default `ask` therefore means the splitter or the
 * matcher lost track of the command — which is exactly what happened when `<<'BODY'` bodies were
 * quote-lexed and `*` could not span a newline.
 *
 * The commands below are taken from real sessions. They must all resolve to `allow` under the
 * allow-by-default shape of `~/.config/pi/shell-gate.json`, both as a whole and part by part.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, type Rule, decide, decideRule, isLoopHeader, splitCommands, stripKeywords } from "../extensions/shell-gate.ts";

/** The user's config shape: defaults, a catch-all allow, then the defaults again to re-carve asks. */
const ALLOW_BY_DEFAULT: Rule[] = [...DEFAULT_RULES, { pattern: "*", effect: "allow" }, ...DEFAULT_RULES];

/** The narrowest possible rule set: nothing but the catch-all. */
const CATCH_ALL: Rule[] = [{ pattern: "*", effect: "allow" }];

const BENIGN: string[] = [
	// Heredoc body with an apostrophe: the case that used to prompt.
	"cat > /tmp/pr-body.md <<'BODY'\n## What changed\n\n- `Month` rows now run Sunday to Saturday, and today's column is the raw weekday number.\nBODY",
	// A heredoc whose body mentions a denied command. The body is data here, `cat` writes it.
	"cat > /tmp/notes.md <<'EOF'\nrm -rf ~ is the example we avoid\nEOF",
	// Commit message through a quoted command substitution.
	'git commit -m "$(cat <<\'EOF\'\nfix: keep today\'s column raw\n\nBody line.\nEOF\n)"',
	// Python heredoc into an interpreter.
	"cd /tmp && python3 - <<'EOF'\nimport json\nd = json.load(open('/tmp/schema.json'))\nprint(\"it's fine\", sorted(d))\nEOF",
	// Tabs-stripped heredoc.
	"cat <<-SQL > /tmp/q.sql\n\tselect * from plan_recipes where substr(week_start,1,10) = '2026-11-01';\n\tSQL",
	// for loop with a quoted pipeline inside the body.
	'for p in mcp lsp plugins; do echo "=== $p ==="; git status --short | wc -l; done',
	// Quoted multi-line python one-liner.
	'jq -r \'.items[] | "\\(.number) \\(.title)"\' /tmp/issues.json | head -20',
	// Multi-line script with a trap.
	'set -e\nF=/Users/randell/.config/pi/extensions/pretty-footer.ts\ncp "$F" /tmp/footer.bak\ntrap \'cp /tmp/footer.bak "$F"\' EXIT\nprintf "throw new Error(\\"PROBE\\");\\n" > "$F"',
	// Wrapped for header.
	"for b in a b\n  c d\ndo printf %s $b\ndone",
	// Semicolon-joined reads.
	"cd /Users/randell/Documents/dev/mealwise; git status; git diff --stat; ls -la",
	// sqlite migration with newlines inside a quoted -cmd.
	"sqlite3 -batch db.sqlite \"\nselect count(*) from plan_recipes;\nselect min(week_start) from plan_recipes;\n\"",
	// Here-string is not a heredoc.
	"wc -l <<< 'a b c'",
	// Nested quoting.
	'rg -n "today\'s|week_start" --glob "*.ts" src | head -30',
];

test("benign real commands resolve to allow under allow-by-default", () => {
	for (const command of BENIGN) {
		assert.equal(decide(ALLOW_BY_DEFAULT, command), "allow", `whole command asked: ${JSON.stringify(command)}`);
	}
});

test("no part of a benign command falls through to the ask default", () => {
	for (const command of BENIGN) {
		const parts = splitCommands(command);
		for (let index = 0; index < parts.length; index += 1) {
			const part = stripKeywords(parts[index] ?? "");
			if (!part || isLoopHeader(parts, index)) continue;
			// The catch-all alone must claim every part. When it does not, the part still
			// carries a newline or an unclosed quote, and the gate asks with no rule to blame.
			const { pattern, effect } = decideRule(CATCH_ALL, part);
			assert.notEqual(pattern, undefined, `no rule matched part ${JSON.stringify(part)} of ${JSON.stringify(command)}`);
			assert.equal(effect, "allow", `part asked: ${JSON.stringify(part)}`);
		}
	}
});

test("a denied command inside a heredoc body is still denied", () => {
	// `bash` runs its stdin, so the body is commands, not data.
	const parts = splitCommands("bash <<'EOF'\necho it's fine\nrm -rf ~\nEOF");
	assert.deepEqual(parts, ["bash <<'EOF'", "echo it's fine", "rm -rf ~", "EOF"]);
	assert.equal(decide(ALLOW_BY_DEFAULT, stripKeywords(parts[2] ?? "")), "deny");
});

test("policy asks survive the catch-all", () => {
	// Deliberate carve-outs, not parser noise: they must keep asking with the catch-all present.
	assert.equal(decide(ALLOW_BY_DEFAULT, "git push -u origin feat"), "ask");
	assert.equal(decide(ALLOW_BY_DEFAULT, "rm -rf build"), "ask");
	assert.equal(decide(ALLOW_BY_DEFAULT, "git branch -D feat"), "ask");
	assert.equal(decide(ALLOW_BY_DEFAULT, "git push origin main"), "deny");
	assert.equal(decide(ALLOW_BY_DEFAULT, "rm -rf ~"), "deny");
});
