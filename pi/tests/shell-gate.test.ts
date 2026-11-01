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
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES, currentBranch, decide, decideRule, hasNoVerifyFlag, heredocOpener, isLoopHeader, loadRules, matches, normalizeSpacing, pushVerdict, splitCommands, stripKeywords } from "../extensions/shell-gate.ts";

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

test("splitCommands lexes a heredoc body as data, not as quotes", () => {
	assert.deepEqual(splitCommands("cat > /tmp/body.md <<'BODY'\nevery today's row\nBODY"), [
		"cat > /tmp/body.md <<'BODY'",
		"every today's row",
		"BODY",
	]);
	// A command after the terminator is split as usual.
	assert.deepEqual(splitCommands("cat <<'EOF'\nsome text\nEOF\ngit status"), [
		"cat <<'EOF'",
		"some text",
		"EOF",
		"git status",
	]);
	// The body of `bash <<'EOF'` is still judged, so it cannot smuggle a denied command.
	const body = splitCommands("bash <<'EOF'\necho it's fine\nrm -rf ~\nEOF");
	assert.deepEqual(body.slice(1), ["echo it's fine", "rm -rf ~", "EOF"]);
	assert.equal(decide(DEFAULT_RULES, stripKeywords(body[2] ?? "")), "deny");
});

test("heredocOpener rejects the here-string form", () => {
	assert.deepEqual(heredocOpener("cat <<'EOF'"), { delim: "EOF", stripTabs: false });
	assert.deepEqual(heredocOpener("cat <<-EOF"), { delim: "EOF", stripTabs: true });
	assert.equal(heredocOpener("wc -l <<< 'a b'"), undefined);
	assert.equal(heredocOpener("ls -la"), undefined);
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

test("matches spans newlines inside a quoted argument", () => {
	assert.ok(matches("*", "- a line\n- another line"));
	assert.ok(matches("git commit *", 'git commit -m "subject\n\nbody"'));
	assert.equal(decide([{ pattern: "*", effect: "allow" }], "- a line\n- another line"), "allow");
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

test("decideRule names the winning rule", () => {
	assert.deepEqual(decideRule(DEFAULT_RULES, "git push origin main"), { effect: "deny", pattern: "git push * main" });
	assert.deepEqual(decideRule(DEFAULT_RULES, "git push origin feat"), { effect: "ask", pattern: "git push *" });
	assert.deepEqual(decideRule(DEFAULT_RULES, "rm -rf ~/x"), { effect: "ask", pattern: "rm -rf *" });
	// Nothing matches on the built-in defaults, so the effect comes from the default.
	assert.deepEqual(decideRule(DEFAULT_RULES, "cargo publish"), { effect: "ask", pattern: undefined });
	assert.deepEqual(decideRule([{ pattern: "*", effect: "allow" }], "cargo publish"), { effect: "allow", pattern: "*" });
});

test("whitespace runs cannot dodge a rule", () => {
	assert.equal(decide(DEFAULT_RULES, "git  push --force origin main"), "deny");
	assert.equal(decide(DEFAULT_RULES, "git  push origin main"), "deny");
	assert.equal(decide(DEFAULT_RULES, "rm  -rf ~"), "deny");
	assert.equal(decide(DEFAULT_RULES, "rm\t-rf\t~"), "deny");
	assert.equal(decide(DEFAULT_RULES, "git\tstatus"), "allow");
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

test("pushVerdict allows a push that names a branch other than main/master", () => {
	const onFeat = () => "feat";
	assert.equal(pushVerdict("git push -u origin feat", onFeat), "allow");
	assert.equal(pushVerdict("git push origin HEAD:feat", onFeat), "allow");
	assert.equal(pushVerdict("git push origin feat:refs/heads/feat", onFeat), "allow");
	assert.equal(pushVerdict("git push origin v1.0.0", onFeat), "allow");
});

test("pushVerdict reads the checked-out branch when no refspec names one", () => {
	assert.equal(pushVerdict("git push", () => "feat"), "allow");
	assert.equal(pushVerdict("git push origin", () => "feat"), "allow");
	assert.equal(pushVerdict("git push -u origin HEAD", () => "feat"), "allow");
	assert.equal(pushVerdict("git push", () => "main"), "deny");
	assert.equal(pushVerdict("git push origin", () => "master"), "deny");
	assert.equal(pushVerdict("git push -u origin HEAD", () => "main"), "deny");
});

test("pushVerdict blocks a refspec that lands on main/master or forces", () => {
	const onFeat = () => "feat";
	assert.equal(pushVerdict("git push origin feat:main", onFeat), "deny");
	assert.equal(pushVerdict("git push origin HEAD:master", onFeat), "deny");
	assert.equal(pushVerdict("git push origin +feat", onFeat), "deny");
	assert.equal(pushVerdict("git push --force-with-lease origin feat", onFeat), "deny");
});

test("pushVerdict asks when the target cannot be pinned to one branch", () => {
	assert.equal(pushVerdict("git push", () => undefined), "ask");
	assert.equal(pushVerdict("git push origin --all", () => "feat"), "ask");
	assert.equal(pushVerdict("git push origin --delete feat", () => "feat"), "ask");
	assert.equal(pushVerdict("git push origin --mirror", () => "feat"), "ask");
	assert.equal(pushVerdict("git push -d origin feat", () => "feat"), "ask");
	assert.equal(pushVerdict("git push origin 'refs/heads/*:refs/heads/*'", () => "feat"), "ask");
});

test("pushVerdict leaves non-push commands to the rules", () => {
	assert.equal(pushVerdict("git status", () => "feat"), undefined);
	assert.equal(pushVerdict("git pushish", () => "feat"), undefined);
	assert.equal(pushVerdict("npm publish", () => "feat"), undefined);
});

test("currentBranch reads the branch, and nothing outside a repository", () => {
	const repo = mkdtempSync(join(tmpdir(), "shell-gate-branch-"));
	execFileSync("git", ["init", "-b", "feat", repo], { stdio: "ignore" });
	assert.equal(currentBranch(repo), "feat");
	assert.equal(currentBranch(undefined), undefined);
	assert.equal(currentBranch(mkdtempSync(join(tmpdir(), "shell-gate-norepo-"))), undefined);
});
