/**
 * Hook-level tests for the shell gate.
 *
 * The helper tests in `shell-gate.test.ts` never exercise the `tool_call` hook, which is where
 * every user-visible decision is made: whether a prompt appears at all, what it says, and what a
 * blocked command reports. The heredoc regression lived on this seam — the rules were fine, the
 * hook asked anyway — so the seam gets its own tests.
 *
 * `HOME` is pointed at a temp directory holding a small `shell-gate.json` in the same shape as the
 * real one (catch-all allow, then the asks and denies that carve out of it), so the tests exercise
 * the allow-by-default behaviour without reading the user's live config.
 *
 * @see file:./shell-gate-corpus.test.ts for the command corpus these cases draw from.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import shellGate from "../extensions/shell-gate.ts";

type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;
type Verdict = { block?: boolean; reason?: string } | undefined;

interface Harness {
	run(command: string, options?: { hasUI?: boolean; choice?: string; toolName?: string }): Promise<{ verdict: Verdict; prompts: string[] }>;
}

/** The shape of the real config: allow everything, then carve out asks and denies. */
const TEST_RULES = [
	{ pattern: "*", effect: "allow" },
	{ pattern: "git push *", effect: "ask" },
	{ pattern: "rm *", effect: "ask" },
	{ pattern: "*--no-verify*", effect: "deny" },
	{ pattern: "rm -rf ~", effect: "deny" },
] as const;

function harness(rules: readonly { pattern: string; effect: string }[] = TEST_RULES): Harness {
	const handlers: Handler[] = [];
	const pi = {
		on: (name: string, handler: Handler) => {
			if (name === "tool_call") handlers.push(handler);
		},
		registerCommand: () => {},
	};
	const home = process.env.HOME;
	const fakeHome = mkdtempSync(join(tmpdir(), "shell-gate-test-"));
	mkdirSync(join(fakeHome, ".config", "pi"), { recursive: true });
	writeFileSync(join(fakeHome, ".config", "pi", "shell-gate.json"), JSON.stringify({ rules }));
	process.env.HOME = fakeHome;
	try {
		shellGate(pi as never);
	} finally {
		process.env.HOME = home;
	}
	const handler = handlers[0];
	assert.ok(handler, "the extension must register a tool_call handler");

	return {
		async run(command, { hasUI = true, choice = "Allow once", toolName = "bash" } = {}) {
			const prompts: string[] = [];
			const ctx = {
				hasUI,
				ui: {
					select: async (title: string) => {
						prompts.push(title);
						return choice;
					},
					notify: () => {},
				},
			};
			const verdict = (await handler({ toolName, input: { command } }, ctx)) as Verdict;
			return { verdict, prompts };
		},
	};
}

test("a benign heredoc command runs with no prompt", async () => {
	const gate = harness();
	const command = "cat > /tmp/body.md <<'BODY'\n- today's column is the raw weekday number.\nBODY";
	const { verdict, prompts } = await gate.run(command);
	assert.equal(verdict, undefined);
	assert.deepEqual(prompts, []);
});

test("an ask prompt names the winning rule and the part it judged", async () => {
	const gate = harness();
	const { verdict, prompts } = await gate.run("git push -u origin feat");
	assert.equal(verdict, undefined);
	assert.equal(prompts.length, 1);
	assert.match(prompts[0] ?? "", /Run this command\?/);
	assert.match(prompts[0] ?? "", /part 1 of 1/);
	assert.match(prompts[0] ?? "", /last matching rule: `git push \*`/);
});

test("a deny blocks without prompting", async () => {
	const gate = harness();
	const { verdict, prompts } = await gate.run("rm -rf ~");
	assert.deepEqual(prompts, []);
	assert.equal(verdict?.block, true);
	assert.match(verdict?.reason ?? "", /`rm -rf ~` is denied by shell-gate/);
	assert.match(verdict?.reason ?? "", /last matching rule: `rm -rf ~`/);
});

test("an ask with no UI blocks instead of hanging", async () => {
	const gate = harness();
	const { verdict, prompts } = await gate.run("git push -u origin feat", { hasUI: false });
	assert.deepEqual(prompts, []);
	assert.equal(verdict?.block, true);
	assert.match(verdict?.reason ?? "", /needs approval and there is no UI to ask/);
});

test("blocking one part blocks the whole compound command", async () => {
	const gate = harness();
	const { verdict } = await gate.run("git status && git commit -n -m x");
	assert.equal(verdict?.block, true);
	assert.match(verdict?.reason ?? "", /--no-verify/);
});

test("a session approval suppresses the next prompt for the same part", async () => {
	const gate = harness();
	const first = await gate.run("git push -u origin feat", { choice: "Allow for this session" });
	assert.equal(first.prompts.length, 1);
	const second = await gate.run("git push -u origin feat", { choice: "Allow for this session" });
	assert.deepEqual(second.prompts, []);
});

test("blocking a prompt reports the part and asks for a report", async () => {
	const gate = harness();
	const { verdict } = await gate.run("git push -u origin feat", { choice: "Block" });
	assert.equal(verdict?.block, true);
	assert.match(verdict?.reason ?? "", /was not approved/);
});

test("non-shell tools and empty commands pass straight through", async () => {
	const gate = harness();
	assert.deepEqual((await gate.run("   ")).prompts, []);
	const read = await gate.run("cat /etc/hosts", { toolName: "read" });
	assert.equal(read.verdict, undefined);
	assert.deepEqual(read.prompts, []);
});

test("an unmatched command asks and says the default decided it", async () => {
	// No catch-all in the config, so nothing claims the command.
	const gate = harness([]);
	const { verdict, prompts } = await gate.run("cargo publish");
	assert.equal(verdict, undefined);
	assert.match(prompts[0] ?? "", /no rule matched, so the default is ask/);
});
