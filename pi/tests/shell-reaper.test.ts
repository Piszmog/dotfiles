/**
 * Tests for the shell reaper. Run from the pi config directory:
 *
 *   node --test 'tests/*.test.ts'
 *
 * The reap test spawns a real detached shell and kills it, because the whole mechanism is the
 * claim that `$$` is the process-group id and that signalling the negative pid reaches children
 * that outlived the shell. Nothing else catches that being wrong.
 *
 * `settings.json` is read straight from this directory: the extension is inert when the
 * `shellCommandPrefix` line drifts, and that failure is otherwise invisible.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import shellReaper, {
	SHELL_PREFIX,
	clearRegistry,
	isGroupAlive,
	parsePids,
	prefixWired,
	reap,
	reapRegistry,
	reapTargets,
	registryPath,
} from "../extensions/shell-reaper.ts";

test("parsePids keeps whole pids and drops everything else", () => {
	assert.deepEqual(parsePids("123\n"), [123]);
	assert.deepEqual(parsePids(" 123 \n\n456\n"), [123, 456]);
	assert.deepEqual(parsePids("123\n123\n"), [123]);
	assert.deepEqual(parsePids(""), []);
	assert.deepEqual(parsePids("0\n1\n-5\nabc\n12x\n"), []);
});

test("reapTargets never returns pid 0, pid 1, or pi itself", () => {
	assert.deepEqual(reapTargets([0, 1, 4242, 4242, Number.NaN], 4242), []);
	assert.deepEqual(reapTargets([0, 1, 4242, 99], 4242), [99]);
});

test("registryPath matches the file name the shell writes", () => {
	assert.equal(registryPath(4242, "/tmp/probe"), "/tmp/probe/pi-shells-4242.log");
	assert.match(SHELL_PREFIX, /pi-shells-\$PPID\.log/);
});

test("settings.json still carries the recording line", () => {
	const settings = JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8")) as {
		shellCommandPrefix?: string;
	};
	assert.ok(
		prefixWired(settings.shellCommandPrefix),
		"settings.json shellCommandPrefix must contain SHELL_PREFIX, or the reaper records nothing",
	);
});

test("reap kills a group that outlived its shell", async () => {
	const dir = mkdtempSync(join(tmpdir(), "shell-reaper-"));
	const child = spawn("/bin/bash", ["-c", `${SHELL_PREFIX}\nsleep 30 & echo started`], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, TMPDIR: dir },
	});
	const pid = Number(child.pid);
	try {
		await once(child, "exit");

		const registry = registryPath(process.pid, dir);
		assert.ok(existsSync(registry), "the prefix must record the shell pid");
		assert.deepEqual(parsePids(readFileSync(registry, "utf8")), [pid]);
		assert.ok(isGroupAlive(pid), "the backgrounded child keeps the group alive");

		const result = reap(parsePids(readFileSync(registry, "utf8")));
		assert.equal(result.targeted, 1);
		assert.equal(isGroupAlive(pid), false, "SIGTERM must reach the backgrounded child");
	} finally {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

test("the factory registers both session hooks and one command", () => {
	const hooks: string[] = [];
	const commands: string[] = [];
	const pi = {
		on: (name: string) => {
			hooks.push(name);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		getSettings: () => ({ shellCommandPrefix: SHELL_PREFIX }),
	};

	shellReaper(pi as never);

	assert.deepEqual(hooks, ["session_start", "session_shutdown"]);
	assert.deepEqual(commands, ["shell-reaper"]);
});

test("reapRegistry deletes the file and ignores dead groups", () => {
	const dir = mkdtempSync(join(tmpdir(), "shell-reaper-"));
	const file = join(dir, "registry.log");
	const dead = spawnSync("/bin/bash", ["-c", "exit 0"]);
	writeFileSync(file, `${dead.pid}\n0\n1\n`);

	const result = reapRegistry(file, { graceMs: 0 });
	assert.equal(result.targeted, 0, "a dead group is not a target");
	assert.equal(existsSync(file), false);
});

test("clearRegistry empties the list without touching processes", () => {
	const dir = mkdtempSync(join(tmpdir(), "shell-reaper-"));
	const file = join(dir, "registry.log");
	writeFileSync(file, "4242\n");
	clearRegistry(file);
	assert.deepEqual(parsePids(readFileSync(file, "utf8")), []);
});
