/**
 * model.ts — pure data logic for the Claude Code Usage extension.
 *
 * This module deliberately imports nothing from `vscode`, so it can be unit
 * tested in plain Node. It owns the status-line schema types, session parsing,
 * multi-session aggregation, and all the formatting helpers.
 *
 * Schema reference (verified against https://code.claude.com/docs/en/statusline):
 *   - context_window.current_usage.{input_tokens, output_tokens,
 *       cache_creation_input_tokens, cache_read_input_tokens}
 *       -> null before the first API call and again right after /compact.
 *   - context_window.used_percentage -> may be null early; can exceed 100 after
 *       auto-compact, so we treat it as indicative only.
 *   - cost.total_cost_usd -> estimated, client-side; "may differ from your
 *       actual bill". On Pro/Max you are not billed it, hence "API-equivalent".
 *   - rate_limits.{five_hour,seven_day}.used_percentage (0..100) and
 *       .resets_at (Unix epoch SECONDS). Present only for Pro/Max after the
 *       first API response; each window may be independently absent.
 */

export interface CurrentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ContextWindow {
  total_input_tokens?: number;
  total_output_tokens?: number;
  context_window_size?: number;
  used_percentage?: number | null;
  remaining_percentage?: number | null;
  current_usage?: CurrentUsage | null;
}

export interface Cost {
  total_cost_usd?: number;
  total_duration_ms?: number;
  total_api_duration_ms?: number;
  total_lines_added?: number;
  total_lines_removed?: number;
}

export interface RateWindow {
  used_percentage?: number;
  resets_at?: number; // Unix epoch SECONDS
}

export interface RateLimits {
  five_hour?: RateWindow;
  seven_day?: RateWindow;
}

export interface StatusLinePayload {
  session_id?: string;
  session_name?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: Cost;
  context_window?: ContextWindow;
  rate_limits?: RateLimits;
  version?: string;
  [k: string]: unknown;
}

/** On-disk record written by the bridge. */
export interface SessionRecord {
  received_at: number; // epoch ms
  pid?: number;
  payload: StatusLinePayload | null;
}

/** A session enriched with freshness info, derived at read/render time. */
export interface SessionInfo {
  id: string;
  receivedAt: number;
  ageMs: number;
  stale: boolean;
  payload: StatusLinePayload | null;
}

export interface AggregateOptions {
  activeWindowMs: number;
  staleMs: number;
}

export interface Aggregate {
  activeCount: number;
  totalCount: number;
  costUsd: number; // summed over active sessions
  fiveHour?: RateWindow; // shared across the account — read once
  sevenDay?: RateWindow;
  rateFromSessionId?: string;
  freshestAgeMs: number; // Infinity when there are no sessions
  stale: boolean; // nothing updated within staleMs
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseSessionRecord(jsonText: string): SessionRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.received_at !== "number") return null;
  return {
    received_at: rec.received_at,
    pid: typeof rec.pid === "number" ? rec.pid : undefined,
    payload: (rec.payload as StatusLinePayload | null) ?? null,
  };
}

export function toSessionInfo(
  id: string,
  rec: SessionRecord,
  now: number,
  staleMs: number
): SessionInfo {
  const ageMs = Math.max(0, now - rec.received_at);
  return {
    id,
    receivedAt: rec.received_at,
    ageMs,
    stale: ageMs > staleMs,
    payload: rec.payload,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregate(
  sessions: SessionInfo[],
  now: number,
  opts: AggregateOptions
): Aggregate {
  const byFreshest = [...sessions].sort((a, b) => b.receivedAt - a.receivedAt);

  let costUsd = 0;
  let activeCount = 0;
  for (const s of sessions) {
    if (s.ageMs <= opts.activeWindowMs) {
      activeCount++;
      const c = s.payload?.cost?.total_cost_usd;
      if (typeof c === "number" && isFinite(c)) costUsd += c;
    }
  }

  // The rate limit is shared across all sessions on the account — read it once,
  // from the freshest session that actually carries it.
  let fiveHour: RateWindow | undefined;
  let sevenDay: RateWindow | undefined;
  let rateFromSessionId: string | undefined;
  for (const s of byFreshest) {
    const rl = s.payload?.rate_limits;
    if (rl && (rl.five_hour || rl.seven_day)) {
      fiveHour = rl.five_hour;
      sevenDay = rl.seven_day;
      rateFromSessionId = s.id;
      break;
    }
  }

  const freshestAgeMs = byFreshest.length ? byFreshest[0].ageMs : Infinity;

  return {
    activeCount,
    totalCount: sessions.length,
    costUsd,
    fiveHour,
    sevenDay,
    rateFromSessionId,
    freshestAgeMs,
    stale: freshestAgeMs > opts.staleMs,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatCost(n: number | undefined | null): string {
  if (typeof n !== "number" || !isFinite(n)) return "$0.00";
  return "$" + n.toFixed(2);
}

/** Countdown label from now to a Unix-epoch-SECONDS reset time. */
export function formatCountdown(resetsAtSec: number | undefined, now: number): string {
  if (typeof resetsAtSec !== "number" || !isFinite(resetsAtSec)) return "—";
  const ms = resetsAtSec * 1000 - now;
  if (ms <= 0) return "now";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatAge(ageMs: number): string {
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Short text for the status-bar item. */
export function formatStatusBarText(agg: Aggregate, now: number): string {
  if (agg.totalCount === 0) {
    return "$(graph) cc-usage: no data";
  }
  const segs: string[] = [];
  const pct = agg.fiveHour?.used_percentage;
  if (typeof pct === "number") {
    let s = `5h ${Math.round(pct)}%`;
    const cd = formatCountdown(agg.fiveHour?.resets_at, now);
    if (cd !== "—") s += ` (${cd})`;
    segs.push(s);
  } else {
    segs.push("5h —");
  }
  segs.push(formatCost(agg.costUsd));
  if (agg.activeCount > 1) segs.push(`${agg.activeCount} sess`);
  return `$(graph) ${segs.join(" · ")}`;
}

/** Markdown body for the status-bar tooltip (returned as a plain string). */
export function buildTooltipMarkdown(
  agg: Aggregate,
  sessions: SessionInfo[],
  now: number
): string {
  const lines: string[] = [];
  lines.push("**Claude Code Usage**");
  lines.push("");

  if (agg.fiveHour && typeof agg.fiveHour.used_percentage === "number") {
    lines.push(
      `**5-hour limit:** ${Math.round(agg.fiveHour.used_percentage)}% · resets in ${formatCountdown(
        agg.fiveHour.resets_at,
        now
      )}`
    );
  } else {
    lines.push("**5-hour limit:** waiting for first API response…");
  }
  if (agg.sevenDay && typeof agg.sevenDay.used_percentage === "number") {
    lines.push(
      `**7-day limit:** ${Math.round(agg.sevenDay.used_percentage)}% · resets in ${formatCountdown(
        agg.sevenDay.resets_at,
        now
      )}`
    );
  }
  lines.push("");
  lines.push(
    `**Cost (API-equivalent):** ${formatCost(agg.costUsd)} across ${agg.activeCount} active session${
      agg.activeCount === 1 ? "" : "s"
    }`
  );
  lines.push("<sub>Not billed on Pro/Max — this is the estimated API cost.</sub>");

  if (agg.stale) {
    lines.push("");
    lines.push("_No active session — readout is stale. Countdown keeps ticking._");
  }

  if (sessions.length) {
    lines.push("");
    lines.push("| Session | Model | Cost | Ctx | Updated |");
    lines.push("| --- | --- | ---: | ---: | --- |");
    const byFreshest = [...sessions].sort((a, b) => a.ageMs - b.ageMs);
    for (const s of byFreshest) {
      const p = s.payload;
      const id8 = s.id.slice(0, 8);
      const model = p?.model?.display_name ?? "—";
      const cost = formatCost(p?.cost?.total_cost_usd ?? 0);
      const ctxRaw = p?.context_window?.used_percentage;
      const ctx = typeof ctxRaw === "number" ? `${Math.round(ctxRaw)}%` : "—";
      lines.push(`| \`${id8}\` | ${model} | ${cost} | ${ctx} | ${formatAge(s.ageMs)} |`);
    }
  }

  return lines.join("\n");
}
