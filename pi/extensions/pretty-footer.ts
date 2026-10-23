/**
 * Pretty Footer
 *
 * One-line footer tuned for a narrow tiled terminal (16" laptop, 4 panes):
 *
 *   ~/dev/proj (main) · $0.014 · 2.10¢/turn · ctx 34% ███▍░░░░░░   fast-model
 *
 * Monochrome by default. Color marks anomalies only: context pressure and
 * unusually expensive turns. Composition is a pure function so it can be
 * previewed and reasoned about without a live session.
 *
 * Degrades in this order when narrow: model id → statuses → turn cost.
 * Commands: /footer toggles the custom footer, /footer-preview shows samples.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Context percentage thresholds. */
const CTX_WARN_PERCENT = 70;
const CTX_ERROR_PERCENT = 90;
/** Turn cost is "hot" at this multiple of the median of recent turns. */
const TURN_WARN_RATIO = 3;
const TURN_ERROR_RATIO = 8;
/** Floor so trivial turns never count as expensive. */
const TURN_MIN_HOT_USD = 0.005;
/** Without turn history, only an absolute outlier is flagged. */
const TURN_FALLBACK_HOT_USD = 0.05;
/** How many completed turns form the baseline. */
const TURN_HISTORY = 10;
/** Share of the line the working directory may occupy. */
const PATH_SHARE = 0.45;
/** Recompute the cost walk at most this often while the branch leaf is unchanged. */
const COST_RECOMPUTE_MS = 250;

const GAUGE_CELLS = 10;
const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
const SEPARATOR = " · ";

export type FooterColor = "accent" | "dim" | "text" | "muted" | "warning" | "error";

/** Structural subset of the theme, so composition stays testable. */
export interface FooterTheme {
	fg(color: FooterColor, text: string): string;
}

export interface FooterState {
	/** Absolute working directory. */
	cwd: string;
	/** Git branch, or null outside a repo. */
	branch: string | null;
	/** Session spend so far, in USD. */
	sessionCost: number;
	/** Cost of the turn in progress, in USD. */
	turnCost: number;
	/** Completed turn costs, oldest first, excluding the current turn. */
	previousTurnCosts: number[];
	/** Context usage percentage, or null when unknown (e.g. right after compaction). */
	ctxPercent: number | null;
	modelId: string | null;
	/** Other extensions' status texts, already ordered. */
	statuses: string[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Replace the home prefix with ~. */
function fitHome(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
	return cwd;
}

interface PathParts {
	prefix: string;
	base: string;
}

/** Split a path, keeping the deepest segments that fit within `budget` columns. */
function fitPath(dir: string, budget: number): PathParts {
	const isAbsolute = dir.startsWith("/");
	const segments = dir.split("/").filter(Boolean);
	if (segments.length === 0) return { prefix: "", base: dir };

	const base = segments[segments.length - 1]!;
	const joinPrefix = (kept: string[], shortened: boolean): string => {
		const lead = shortened ? "…/" : isAbsolute ? "/" : "";
		const middle = kept.length > 0 ? `${kept.join("/")}/` : "";
		return lead + middle;
	};

	if (budget > 0 && visibleWidth(dir) <= budget) {
		return { prefix: joinPrefix(segments.slice(0, -1), false), base };
	}

	// Shorten from the left, keeping the tail that identifies the directory.
	for (let count = segments.length - 1; count >= 1; count--) {
		const prefix = joinPrefix(segments.slice(-count, -1), true);
		if (budget > 0 && visibleWidth(prefix) + visibleWidth(base) <= budget) return { prefix, base };
	}

	// Only the leaf fits; keep its parent marker and truncate the leaf itself.
	const lead = isAbsolute ? "/" : "";
	return { prefix: lead, base: truncateToWidth(base, Math.max(0, budget - visibleWidth(lead))) };
}

/** Dollars, pinned to 6 columns so the field never jitters. */
function formatDollars(usd: number): string {
	return `$${usd >= 10 ? usd.toFixed(2) : usd.toFixed(3)}`;
}

/** Cents with a stable 5-column field (6 only above 100¢/turn). */
function formatCents(usd: number): string {
	const cents = usd * 100;
	return `${cents >= 10 ? cents.toFixed(1) : cents.toFixed(2)}¢`;
}

/** Integer percent — the sub-cell gauge fill carries the precision. */
function formatPercent(percent: number): string {
	return `${Math.round(percent)}%`;
}

/** Status text as the built-in footer renders it: one line, single spaces. */
function sanitizeStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 0 = normal, 1 = expensive, 2 = alarming. Relative to recent turns when known. */
export function turnHeat(turnCost: number, previousTurnCosts: number[]): 0 | 1 | 2 {
	const typical = median(previousTurnCosts.slice(-TURN_HISTORY));
	if (typical <= 0) return turnCost >= TURN_FALLBACK_HOT_USD ? 1 : 0;
	if (turnCost < TURN_MIN_HOT_USD) return 0;
	const ratio = turnCost / typical;
	if (ratio >= TURN_ERROR_RATIO) return 2;
	if (ratio >= TURN_WARN_RATIO) return 1;
	return 0;
}

/** 10-cell gauge with 1/8-cell fill, so it reads as a curve rather than 10 steps. */
function gauge(percent: number, paint: (s: string) => string, dim: (s: string) => string): string {
	const rounded = Math.round((Math.max(0, Math.min(100, percent)) * GAUGE_CELLS * 8) / 100);
	const full = Math.floor(rounded / 8);
	const rest = rounded % 8;
	const partial = rest > 0 ? PARTIALS[rest]! : "";
	const empty = GAUGE_CELLS - full - (partial ? 1 : 0);
	return paint("█".repeat(full) + partial) + dim("░".repeat(Math.max(0, empty)));
}

function fits(left: string, right: string, width: number): boolean {
	return visibleWidth(left) + 1 + visibleWidth(right) <= width;
}

/** Left-aligned content with a right-aligned anchor and at least one space between. */
function justify(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) return truncateToWidth(left, width);
	return left + " ".repeat(gap) + right;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function composeLocation(state: FooterState, width: number, theme: FooterTheme): string {
	const branchSuffix = state.branch ? theme.fg("muted", ` (${state.branch})`) : "";
	const budget = Math.max(10, Math.floor(width * PATH_SHARE) - visibleWidth(branchSuffix));
	const { prefix, base } = fitPath(fitHome(state.cwd), budget);
	return theme.fg("dim", prefix) + theme.fg("text", base) + branchSuffix;
}

function composeContext(percent: number | null, theme: FooterTheme): string {
	if (percent === null) return theme.fg("dim", "ctx ?");
	const color: FooterColor =
		percent > CTX_ERROR_PERCENT ? "error" : percent > CTX_WARN_PERCENT ? "warning" : "accent";
	const paint = (text: string) => theme.fg(color, text);
	return (
		theme.fg("dim", "ctx ") + paint(`${formatPercent(percent)} `) + gauge(percent, paint, (s) => theme.fg("dim", s))
	);
}

function composeTurn(state: FooterState, theme: FooterTheme): string {
	const heat = turnHeat(state.turnCost, state.previousTurnCosts);
	const color: FooterColor = heat === 2 ? "error" : heat === 1 ? "warning" : "dim";
	return theme.fg(color, formatCents(state.turnCost)) + theme.fg("dim", "/turn");
}

/**
 * Compose the footer line. Always returns exactly one line, never wider than `width`.
 * Left side (location, cost, context) is protected; the right block degrades first.
 */
export function composeFooter(state: FooterState, width: number, theme: FooterTheme): string[] {
	const separator = theme.fg("dim", SEPARATOR);
	const location = composeLocation(state, width, theme);
	const cost = theme.fg("text", formatDollars(state.sessionCost));
	const turn = composeTurn(state, theme);
	const context = composeContext(state.ctxPercent, theme);

	const statuses = state.statuses.map(sanitizeStatus).filter(Boolean).join("  ");
	const model = state.modelId ? theme.fg("muted", state.modelId) : "";
	const withModel = [statuses, model].filter(Boolean).join(separator);

	const buildLeft = (includeTurn: boolean) =>
		[location, cost, ...(includeTurn ? [turn] : []), context].join(separator);

	let left = buildLeft(true);

	// 1. Everything fits.
	if (fits(left, withModel, width)) return [justify(left, withModel, width)];

	// 2. Drop the model id, keep statuses.
	if (statuses && fits(left, statuses, width)) return [justify(left, statuses, width)];

	// 3. Truncate statuses into whatever space is left.
	if (statuses) {
		const available = width - visibleWidth(left) - 1;
		if (available >= 8) {
			return [justify(left, truncateToWidth(statuses, available, theme.fg("dim", "…")), width)];
		}
		if (fits(left, "", width)) return [justify(left, "", width)];
	}

	// 4. Drop the turn cost.
	left = buildLeft(false);
	if (fits(left, "", width)) return [justify(left, "", width)];

	// 5. Give up and truncate the protected fields.
	return [truncateToWidth(left, width)];
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

interface CostState {
	sessionCost: number;
	turnCost: number;
	previousTurnCosts: number[];
}

/** Cache keyed on the branch leaf, so new entries recompute immediately and
 * in-place usage updates recompute at most four times a second. */
let costCache: { leafId: string | null; computedAt: number; state: CostState } | null = null;

function computeCosts(ctx: ExtensionContext): CostState {
	let sessionCost = 0;
	const turnCosts: number[] = [];
	const addToTurn = (usd: number) => {
		if (turnCosts.length === 0) turnCosts.push(0);
		turnCosts[turnCosts.length - 1]! += usd;
	};

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "usage") {
			sessionCost += entry.usage.cost.total;
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") {
				turnCosts.push(0);
			} else if (message.role === "assistant") {
				sessionCost += message.usage.cost.total;
				addToTurn(message.usage.cost.total);
			} else if (message.role === "toolResult") {
				sessionCost += message.usage?.cost.total ?? 0;
			}
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			sessionCost += entry.usage?.cost.total ?? 0;
		}
	}

	const turnCost = turnCosts.length > 0 ? turnCosts[turnCosts.length - 1]! : 0;
	const previousTurnCosts = turnCosts.slice(0, -1).filter((cost) => cost > 0);
	return { sessionCost, turnCost, previousTurnCosts };
}

function getCosts(ctx: ExtensionContext): CostState {
	const now = Date.now();
	const leafId = ctx.sessionManager.getLeafId();
	if (costCache && leafId === costCache.leafId && now - costCache.computedAt < COST_RECOMPUTE_MS) {
		return costCache.state;
	}

	const state = computeCosts(ctx);
	costCache = { leafId, computedAt: now, state };
	return state;
}

function readState(ctx: ExtensionContext, branch: string | null, statuses: ReadonlyMap<string, string>): FooterState {
	const { sessionCost, turnCost, previousTurnCosts } = getCosts(ctx);
	const usage = ctx.getContextUsage();
	const ordered = Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text);

	return {
		cwd: ctx.cwd,
		branch,
		sessionCost,
		turnCost,
		previousTurnCosts,
		ctxPercent: usage?.percent ?? null,
		modelId: ctx.model?.id ?? null,
		statuses: ordered,
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function previewStates(): FooterState[] {
	const home = process.env.HOME ?? "/home/user";
	const typical = [0.0121, 0.031, 0.008, 0.0224, 0.017];
	return [
		{
			cwd: `${home}/dev/proj`,
			branch: "main",
			sessionCost: 0.0143,
			turnCost: 0.021,
			previousTurnCosts: typical,
			ctxPercent: 34,
			modelId: "fast-model",
			statuses: [],
		},
		{
			cwd: `${home}/code/work/monorepo/packages/api/src/handlers/v2/billing`,
			branch: "feature/long-name",
			sessionCost: 0.428,
			turnCost: 0.031,
			previousTurnCosts: typical,
			ctxPercent: 34,
			modelId: "deepseek-v4.1-flash",
			statuses: ["quota 72%", "lint clean"],
		},
		{
			cwd: `${home}/dev/proj`,
			branch: "main",
			sessionCost: 12.41,
			turnCost: 0.42,
			previousTurnCosts: typical,
			ctxPercent: 78,
			modelId: "deepseek-v4.1-flash",
			statuses: ["quota 86%", "5h window ok", "cache warm", "tests 42", "queue 2"],
		},
	];
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let previewing = false;

	function install(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const state = readState(ctx, footerData.getGitBranch(), footerData.getExtensionStatuses());
					return composeFooter(state, width, theme);
				},
			};
		});
	}

	function installPreview(ctx: ExtensionContext) {
		ctx.ui.setFooter((_tui, theme) => ({
			dispose() {},
			invalidate() {},
			render(width: number): string[] {
				return previewStates().map((state) => composeFooter(state, width, theme)[0]!);
			},
		}));
	}

	pi.on("session_start", async (_event, ctx) => {
		costCache = null;
		if (ctx.mode !== "tui") return;
		previewing = false;
		if (enabled) install(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle the pretty custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			previewing = false;
			if (enabled) {
				install(ctx);
				ctx.ui.notify("Pretty footer on", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Built-in footer restored", "info");
			}
		},
	});

	pi.registerCommand("footer-preview", {
		description: "Show sample footer lines (normal, long path, anomalies)",
		handler: async (_args, ctx) => {
			previewing = !previewing;
			if (previewing) {
				installPreview(ctx);
				ctx.ui.notify("Footer preview on — run /footer-preview again to restore", "info");
			} else if (enabled) {
				install(ctx);
				ctx.ui.notify("Footer preview off", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Footer preview off, built-in footer restored", "info");
			}
		},
	});
}
