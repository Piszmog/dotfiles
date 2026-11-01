/**
 * Tests for the shell-gate extension. Run from the pi config directory:
 *
 *   node --test 'tests/*.test.ts'
 *
 * These pin the two things that are easy to get wrong: the order in which rules resolve, and
 * splitting a compound command without cutting through quoted arguments.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, decide, hasNoVerifyFlag, isLoopHeader, loadRules, matches, splitCommands, stripKeywords } from "../extensions/shell-gate.ts";

test("splitCommands keeps quoted separators inside one command", () => {
	assert.deepEqual(splitCommands('git commit -m "a; b"'), ['git commit -m "a; b"']);
	assert.deepEqual(splitCommands("git commit -m 'x | y' && git push"), ["git commit -m 'x | y'", "git push"]);
	assert.deepEqual(splitCommands('echo "a && b"'), ['echo "a && b"']);
});

test("splitCommands splits on &&, ||, ;, | and newlines", () => {
	assert.deepEqual(splitCommands("a && b || c; d | e"), ["a", "b", "c", "d", "e"]);
	assert.deepEqual(splitCommands("go test ./...\ngit status"), ["go test ./...", "git status"]);
	assert.deepEqual(splitCommands("   "), []);
});

test("splitCommands joins a wrapped for/select header until its do", () => {
	assert.deepEqual(splitCommands("for b in a b\n  c d\ndo printf %s $b\ndone"), [
		"for b in a b c d do printf %s $b",
		"done",
	]);
	assert.deepEqual(splitCommands("for f in *\nrm -rf /"), ["for f in * rm -rf /"]);
});

test("isLoopHeader only excuses a header whose next part opens the body", () => {
	const wrapped = splitCommands("for b in a b\n  c d\ndo printf %s $b\ndone");
	assert.equal(isLoopHeader(wrapped, 0), false);
	const inline = splitCommands("for b in a b; do printf %s $b; done");
	assert.equal(isLoopHeader(inline, 0), true);
	assert.equal(isLoopHeader(splitCommands("for f in *\nrm -rf /"), 0), false);
	assert.equal(isLoopHeader(splitCommands("for f in *"), 0), false);
});

test("stripKeywords judges the command behind a keyword", () => {
	assert.equal(stripKeywords("do printf %s $b"), "printf %s $b");
	assert.equal(stripKeywords("then rm -rf /"), "rm -rf /");
	assert.equal(stripKeywords("! git status"), "git status");
	assert.equal(stripKeywords("time cargo test"), "cargo test");
	assert.equal(stripKeywords("for f in * do rm -rf /"), "rm -rf /");
	assert.equal(stripKeywords("git status"), "git status");
	assert.equal(stripKeywords("done"), "done");
});

test("matches treats a trailing ' *' as optional arguments", () => {
	assert.ok(matches("git status *", "git status"));
	assert.ok(matches("git status *", "git status --short"));
	assert.ok(!matches("git status *", "git statuses"));
	assert.ok(matches("cargo build *", "cargo build"));
});

test("allows resolve last for the routine case", () => {
	assert.equal(decide(DEFAULT_RULES, "git status"), "allow");
	assert.equal(decide(DEFAULT_RULES, "git branch"), "allow");
	assert.equal(decide(DEFAULT_RULES, "go test ./..."), "allow");
	assert.equal(decide(DEFAULT_RULES, "cargo build"), "allow");
	assert.equal(decide(DEFAULT_RULES, "ls -la"), "allow");
	assert.equal(decide(DEFAULT_RULES, "templ generate -f page.templ"), "allow");
});

test("asks carve out of a broader allow", () => {
	assert.equal(decide(DEFAULT_RULES, "git branch -D feat"), "ask");
	assert.equal(decide(DEFAULT_RULES, "git branch -d feat"), "ask");
	assert.equal(decide(DEFAULT_RULES, "git branch --delete feat"), "ask");
	assert.equal(decide(DEFAULT_RULES, "git branch -m old new"), "ask");
	assert.equal(decide(DEFAULT_RULES, "git push origin feat"), "ask");
});

test("denies carve out of a broader ask", () => {
	assert.equal(decide(DEFAULT_RULES, "git push --force origin feat"), "deny");
	assert.equal(decide(DEFAULT_RULES, "git push -f origin feat"), "deny");
	assert.equal(decide(DEFAULT_RULES, "git push origin main"), "deny");
	assert.equal(decide(DEFAULT_RULES, "git push origin master"), "deny");
});

test("rm -rf asks, except for the roots", () => {
	assert.equal(decide(DEFAULT_RULES, "rm -rf /tmp/build"), "ask");
	assert.equal(decide(DEFAULT_RULES, "rm -rf ~/Documents/dev/.worktrees/x"), "ask");
	assert.equal(decide(DEFAULT_RULES, "rm -rf /"), "deny");
	assert.equal(decide(DEFAULT_RULES, "rm -rf ~"), "deny");
	assert.equal(decide(DEFAULT_RULES, "rm -rf ~/"), "deny");
	assert.equal(decide(DEFAULT_RULES, "rm -rf $HOME"), "deny");
});

test("broad staging and hook skipping are denied", () => {
	assert.equal(decide(DEFAULT_RULES, "git add -A"), "deny");
	assert.equal(decide(DEFAULT_RULES, "git add --all"), "deny");
	assert.equal(decide(DEFAULT_RULES, "git add ."), "deny");
	assert.equal(decide(DEFAULT_RULES, "git commit --no-verify -m x"), "deny");
	assert.equal(decide(DEFAULT_RULES, "sudo ls"), "deny");
});

test("anything unlisted asks", () => {
	assert.equal(decide(DEFAULT_RULES, "cargo install ripgrep"), "ask");
	assert.equal(decide(DEFAULT_RULES, "cargo publish"), "ask");
	assert.equal(decide(DEFAULT_RULES, "gh pr create --fill"), "ask");
	assert.equal(decide(DEFAULT_RULES, "git rebase -i HEAD~3"), "ask");
	assert.equal(decide(DEFAULT_RULES, "git rebase origin/main"), "allow");
});

test("hasNoVerifyFlag finds the short form without false positives", () => {
	assert.ok(hasNoVerifyFlag("git commit -n"));
	assert.ok(hasNoVerifyFlag("git commit -n -m x"));
	assert.ok(hasNoVerifyFlag("git commit -an -m x"));
	assert.ok(hasNoVerifyFlag("git commit -amn 'msg'"));
	assert.ok(!hasNoVerifyFlag('git commit -m "fix -n handling"'));
	assert.ok(!hasNoVerifyFlag("git log -n 5"));
	assert.ok(!hasNoVerifyFlag("git commit --no-verify"));
	assert.ok(!hasNoVerifyFlag("git status"));
});

test("loadRules falls back to defaults when the file is missing", () => {
	const loaded = loadRules("/nonexistent/shell-gate.json");
	assert.equal(loaded.source, "defaults");
	assert.equal(loaded.rules.length, DEFAULT_RULES.length);
});
