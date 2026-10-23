/**
 * Secrets Guard
 *
 * Blocks model tool calls from reading `.env` files and `secrets/` directories.
 * Ports the Claude Code deny rules to Pi's built-in tools plus bash.
 *
 * Covered: read, edit, write, grep, find, ls, bash, powershell.
 * Not covered: MCP servers that read files (add a guard in the server config)
 * and codemode scripts that call tools other than the covered ones.
 *
 * Toggle at runtime: /secrets-guard off | on | status
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Names that are safe to read even though they match `.env*`. */
const ALLOWED_ENV_NAMES = new Set([
	".env.example",
	".env.sample",
	".env.template",
	".env.dist",
	".envrc.example",
]);

/** Directory names whose contents are always protected. */
const SECRET_DIRS = new Set(["secrets", ".secrets"]);

/** `.env`, `.envrc`, `.env.local`, `.env.production.local`, ... */
const ENV_NAME = /^\.env(?:rc)?(?:\.[A-Za-z0-9_-]+)*$/i;

/** Inline match for an `.env*` name inside a larger command string. */
const ENV_INLINE = /(?:^|[^\w.-])\.env(?:rc)?(?:\.[A-Za-z0-9_-]+)*(?=$|[^\w.-])/gi;

/** Inline match for a path segment named secrets/ or .secrets/. */
const SECRET_DIR_INLINE = /(?:^|[\s"'`=<>|;&(){}\[\]])(?:[^\s"'`|;&(){}<>]*\/)?\.?secrets\//i;

/** Commands that can print file contents. */
const READ_COMMAND =
	/(?:^|[|;&(){}\s])(cat|bat|batcat|head|tail|less|more|most|grep|egrep|fgrep|rg|ag|ack|sed|awk|cut|sort|uniq|strings|xxd|od|hexdump|base64|jq|yq|source|\.|python[0-9.]*|node|ruby|perl|php|deno|bun|git|diff|cmp|tar|zip|unzip|open|pbcopy|xclip|wl-copy|code|vim|nvim|nano|emacs)(?=\s|$)/;

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

function splitSegments(value: string): string[] {
	return value.split(/[\\/]+/).filter(Boolean);
}

function isEnvName(name: string): boolean {
	return ENV_NAME.test(name) && !ALLOWED_ENV_NAMES.has(name.toLowerCase());
}

function expandHome(value: string): string {
	if (!value.startsWith("~")) return value;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
	return home + value.slice(1);
}

/** True when `raw` names a protected file or a file inside a protected directory. */
export function isProtectedPath(raw: string, cwd: string): boolean {
	if (!raw) return false;

	const cleaned = expandHome(raw.replace(/^file:\/\//, ""));
	const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);

	let resolved = absolute;
	try {
		resolved = fs.realpathSync.native(absolute);
	} catch {
		// Path does not exist yet (write) or is a glob; match the unresolved form.
	}

	for (const candidate of new Set([absolute, resolved])) {
		const parts = splitSegments(candidate);
		if (parts.length === 0) continue;

		const base = parts[parts.length - 1]!;
		if (isEnvName(base)) return true;
		if (SECRET_DIRS.has(base.toLowerCase())) return true;
		if (parts.slice(0, -1).some((part) => SECRET_DIRS.has(part.toLowerCase()))) return true;
	}

	return false;
}

/** Strip surrounding quotes and a leading `./` so tokens compare cleanly. */
function normalizeToken(token: string): string {
	return token.replace(/^['"]+|['"]+$/g, "").replace(/^\.\//, "");
}

/** True when a bash/powershell command would print a protected file. */
export function bashReadsSecret(command: string, cwd: string): boolean {
	if (!command) return false;

	const canRead =
		READ_COMMAND.test(command) || command.includes("<") || command.includes("$(") || command.includes("`");

	if (!canRead) return false;

	for (const match of command.matchAll(ENV_INLINE)) {
		const name = match[0].replace(/^[^\w.]+/, "");
		if (isEnvName(name)) return true;
	}

	if (SECRET_DIR_INLINE.test(command)) return true;

	for (const rawToken of command.split(/[\s|;&(){}<>]+/)) {
		const token = normalizeToken(rawToken);
		if (!token) continue;

		// Check both the token and its glob-stripped form: `.env*`, `secrets/*`.
		for (const candidate of new Set([token, token.replace(/[*?[\]]/g, "")])) {
			if (isProtectedPath(candidate, cwd)) return true;
		}
	}

	return false;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;

		const input = event.input as Record<string, unknown>;
		let target: string | undefined;

		if (SHELL_TOOLS.has(event.toolName)) {
			const command = typeof input.command === "string" ? input.command : "";
			if (bashReadsSecret(command, ctx.cwd)) target = "a shell command that reads secrets";
		} else if (PATH_TOOLS.has(event.toolName)) {
			const requested = input.path;
			const targetPath =
				typeof requested === "string"
					? requested
					: event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls"
						? ctx.cwd
						: undefined;
			if (targetPath && isProtectedPath(targetPath, ctx.cwd)) target = targetPath;
		}

		if (!target) return undefined;

		if (ctx.hasUI) ctx.ui.notify(`Blocked access to ${target}`, "warning");
		return {
			block: true,
			reason: `Blocked: ${target} is a protected secret path. Do not try to read it another way; ask the user if it is genuinely needed.`,
		};
	});

	pi.registerCommand("secrets-guard", {
		description: "Show or toggle the secrets guard (on|off|status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off") enabled = false;
			else if (action === "on") enabled = true;
			else if (action && action !== "status") {
				ctx.ui.notify("Usage: /secrets-guard [on|off|status]", "warning");
				return;
			}
			ctx.ui.notify(`Secrets guard ${enabled ? "on" : "off"}`, enabled ? "info" : "warning");
		},
	});
}
