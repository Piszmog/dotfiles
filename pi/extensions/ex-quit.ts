/**
 * Ex Quit
 *
 * `:q` and friends exit Pi, vim-style. The prompt submits as a whole, so a
 * quit command has to be the entire prompt — there is no draft left behind
 * to protect, which is the one thing that makes this simpler than vim.
 *
 *   :q   :quit  :qa  :qall  :quitall    quit (refuses while the agent works)
 *   :q!  :quit! :qa! :qall!             quit anyway
 *   :wq  :wqa   :x   :xa                also quit; sessions save themselves
 *
 * `/q` is registered as a command for the same thing, since it is the same
 * number of keystrokes as `:q`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** :q family, with vim's own abbreviations and an optional bang. */
const QUIT = /^:(?:q|qu|qui|quit|qa|qall|quitall|wq|wqa|x|xa)(!?)$/;

export default function exQuit(pi: ExtensionAPI) {
	/**
	 * Quit if `text` is a quit command. Returns true when it was consumed,
	 * so callers can skip the normal submit path.
	 */
	function handle(text: string, ctx: ExtensionContext): boolean {
		const match = QUIT.exec(text.trim());
		if (!match) return false;

		if (match[1] !== "!" && !ctx.isIdle()) {
			ctx.ui.notify("Pi is still working — :q! to quit anyway", "warning");
			return true;
		}

		ctx.shutdown();
		return true;
	}

	pi.on("input", async (event, ctx) => {
		// Extension-injected messages never mean "quit".
		if (event.source === "extension") return { action: "continue" };
		if (handle(event.text, ctx)) return { action: "handled" };

		// A quit command on its own line inside a longer prompt. Say so rather
		// than shipping ":q" to the model and getting an apology back.
		const firstLine = (event.text.trimStart().split("\n", 1)[0] ?? "").trim();
		if (QUIT.test(firstLine)) {
			ctx.ui.notify("`:q` has to be the whole prompt to quit", "warning");
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	// Typed on purpose, so it quits rather than arguing with you.
	pi.registerCommand("q", {
		description: "Quit Pi",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
