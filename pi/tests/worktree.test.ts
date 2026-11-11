/**
 * Tests for the worktree extension. Run from the pi config directory:
 *
 *   node --test 'tests/*.test.ts'
 *
 * The git calls are not stubbed here: these tests pin the pure helpers — the location formula
 * shared with the `gwt` fish function, porcelain parsing, and branch matching.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	canonicalPath,
	cleanGitError,
	emptySessionHeader,
	findWorktreeForBranch,
	flattenBranch,
	parseWorktreePorcelain,
	repoRootFrom,
	resolveRoot,
	samePath,
	worktreePath,
} from "../extensions/worktree.ts";

const DEFAULT_ROOT = join(homedir(), "Documents/dev/.worktrees");

test("resolveRoot prefers GWT_ROOT", () => {
	assert.equal(resolveRoot({ GWT_ROOT: "/work/wt" }), "/work/wt");
});

test("resolveRoot ignores an empty or blank GWT_ROOT", () => {
	assert.equal(resolveRoot({ GWT_ROOT: "" }), DEFAULT_ROOT);
	assert.equal(resolveRoot({ GWT_ROOT: "   " }), DEFAULT_ROOT);
	assert.equal(resolveRoot({}), DEFAULT_ROOT);
});

test("flattenBranch turns separators into dashes", () => {
	assert.equal(flattenBranch("main"), "main");
	assert.equal(flattenBranch("fix/login-timeout"), "fix-login-timeout");
	assert.equal(flattenBranch("feat/a/b/c"), "feat-a-b-c");
});

test("worktreePath is <root>/<repo>/<flattened branch>", () => {
	const root = "/work/wt";
	assert.equal(worktreePath(root, "/code/mealwise", "main"), "/work/wt/mealwise/main");
	assert.equal(worktreePath(root, "/code/mealwise", "fix/x"), "/work/wt/mealwise/fix-x");
});

test("parseWorktreePorcelain reads path, branch and detached", () => {
	const text = [
		"worktree /code/repo",
		"HEAD 1111111111111111111111111111111111111111",
		"branch refs/heads/main",
		"",
		"worktree /work/wt/repo/fix-x",
		"HEAD 2222222222222222222222222222222222222222",
		"branch refs/heads/fix/x",
		"",
		"worktree /work/wt/repo/detached",
		"HEAD 3333333333333333333333333333333333333333",
		"detached",
		"",
	].join("\n");

	const entries = parseWorktreePorcelain(text);
	assert.equal(entries.length, 3);
	assert.deepEqual(entries[0], { path: "/code/repo", branch: "main", detached: false });
	assert.deepEqual(entries[1], { path: "/work/wt/repo/fix-x", branch: "fix/x", detached: false });
	assert.deepEqual(entries[2], { path: "/work/wt/repo/detached", branch: undefined, detached: true });
});

test("parseWorktreePorcelain tolerates a missing trailing blank line", () => {
	const entries = parseWorktreePorcelain("worktree /code/repo\nbranch refs/heads/main");
	assert.deepEqual(entries, [{ path: "/code/repo", branch: "main", detached: false }]);
});

test("parseWorktreePorcelain returns nothing for empty input", () => {
	assert.deepEqual(parseWorktreePorcelain(""), []);
});

test("findWorktreeForBranch matches the branch name exactly", () => {
	const entries = parseWorktreePorcelain(
		["worktree /code/repo", "branch refs/heads/main", "", "worktree /w/fix-x", "branch refs/heads/fix/x", ""].join(
			"\n",
		),
	);
	assert.equal(findWorktreeForBranch(entries, "fix/x")?.path, "/w/fix-x");
	assert.equal(findWorktreeForBranch(entries, "fix-x"), undefined);
	assert.equal(findWorktreeForBranch(entries, "main")?.path, "/code/repo");
});

test("emptySessionHeader is a pi session header for the target cwd", () => {
	const line = emptySessionHeader(3, "01a1c0de-0000-7000-8000-000000000000", "/work/wt/r/b", "2026-01-01T00:00:00.000Z");
	assert.equal(line.endsWith("\n"), true);
	assert.deepEqual(JSON.parse(line), {
		type: "session",
		version: 3,
		id: "01a1c0de-0000-7000-8000-000000000000",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/work/wt/r/b",
	});
});

test("canonicalPath resolves symlinks so the session dir matches pi's cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-wt-"));
	const real = join(root, "real");
	const link = join(root, "link");
	mkdirSync(real);
	symlinkSync(real, link);
	assert.equal(canonicalPath(link), canonicalPath(real));
	assert.equal(samePath(link, real), true);
	assert.equal(samePath(link, join(root, "missing")), false);
});

test("canonicalPath returns the input when the path does not exist", () => {
	assert.equal(canonicalPath("/definitely/not/here"), "/definitely/not/here");
});

test("repoRootFrom names the main checkout, not the current worktree", () => {
	assert.equal(repoRootFrom("/code/repo/.git"), "/code/repo");
	assert.equal(repoRootFrom("/code/bare.git"), "/code/bare.git");
	assert.equal(repoRootFrom("/code/repo/.git/modules/sub"), "/code/repo/.git/modules/sub");
});

test("cleanGitError keeps only the diagnostic line", () => {
	const stderr = "Preparing worktree (new branch 'x')\nfatal: '/tmp/wt/x' already exists\n";
	assert.equal(cleanGitError(stderr), "fatal: '/tmp/wt/x' already exists");
});

test("cleanGitError falls back to every line when nothing is marked", () => {
	assert.equal(cleanGitError("first\nsecond"), "first; second");
	assert.equal(cleanGitError(""), "");
});
