/**
 * Claude plan usage in Pi's footer, in the same format as
 * pi-claude-subscription-connector's usage-status. Fed by Claude Code's
 * `rate_limit_event` rather than the OAuth usage endpoint, because Claude Code
 * keeps the subscription token to itself.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { RateLimitInfo } from "./billing.ts";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const SPEND_POLL_MS = 5 * 60_000;
export const SPEND_MAX_BACKOFF_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// "0" sorts before every letter in Pi's footer. Distinct from the connector's
// "0-claude-max", which that extension clears whenever the model is not `anthropic`.
export const STATUS_KEY = "0-claude-code";

export interface UsageWindow {
  label: string;
  percent: number;
}

export type Severity = "ok" | "warn" | "critical";

export const SEVERITY_COLOR: Record<Severity, ThemeColor> = { ok: "success", warn: "warning", critical: "error" };

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "wk",
  seven_day_opus: "opus",
  seven_day_sonnet: "sonnet",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `unifiedWindows` utilizations (0..1) as display percentages. */
export function parseRateLimit(info: RateLimitInfo): UsageWindow[] {
  const windows = info.unifiedWindows;
  if (!isRecord(windows)) return [];
  const result: UsageWindow[] = [];
  for (const [key, window] of Object.entries(windows)) {
    if (!isRecord(window)) continue;
    const utilization = window.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    result.push({ label: WINDOW_LABELS[key] ?? key, percent: Math.round(utilization * 100) });
  }
  return result;
}

/** Usage-credit spend in major units. `limit` is absent when the account reports no cap. */
export interface Spend {
  used: number;
  limit?: number;
  currency: string;
}

function money(value: unknown): { amount: number; currency?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const minor = value.amount_minor;
  const exponent = typeof value.exponent === "number" ? value.exponent : 2;
  if (typeof minor !== "number" || !Number.isFinite(minor)) return undefined;
  return { amount: minor / 10 ** exponent, currency: typeof value.currency === "string" ? value.currency : undefined };
}

/** Spend from `spend`, falling back to `extra_usage` (minor units, `decimal_places`). */
export function parseSpend(json: unknown): Spend | undefined {
  if (!isRecord(json)) return undefined;
  const spend = isRecord(json.spend) ? json.spend : {};
  const extra = isRecord(json.extra_usage) ? json.extra_usage : {};
  const places = typeof extra.decimal_places === "number" ? extra.decimal_places : 2;
  const fromMinor = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v / 10 ** places : undefined);

  const usedMoney = money(spend.used);
  const used = usedMoney?.amount ?? fromMinor(extra.used_credits);
  if (used === undefined) return undefined;
  const limit = money(spend.limit)?.amount ?? fromMinor(extra.monthly_limit);
  const currency = usedMoney?.currency ?? (typeof extra.currency === "string" ? extra.currency : "USD");
  return limit !== undefined && limit > 0 ? { used, limit, currency } : { used, currency };
}

function amount(value: number, currency: string): string {
  const whole = Math.round(value).toString();
  return currency === "USD" ? `$${whole}` : `${whole} ${currency}`;
}

/** "$660/$1000 66%" with a cap, "$660 used" without one. */
export function formatSpend(spend: Spend): string {
  if (spend.limit === undefined) return `${amount(spend.used, spend.currency)} used`;
  const percent = Math.round((spend.used / spend.limit) * 100);
  return `${amount(spend.used, spend.currency)}/${amount(spend.limit, spend.currency)} ${percent}%`;
}

export interface SpendState {
  spend?: Spend;
  /** The most recent fetch failed; `spend` (if any) is the last good reading. */
  stale: boolean;
}

/** "🧠 5h 19% · wk 24%" (+ " ⚠ <spend>" when billed to usage credits). */
export function formatStatusLine(windows: UsageWindow[], alarm = false, spend: SpendState = { stale: false }): string {
  const body = windows.length > 0 ? windows.map((w) => `${w.label} ${w.percent}%`).join(" · ") : "usage n/a";
  if (!alarm) return `🧠 ${body}`;
  if (!spend.spend) return `🧠 ${body} ⚠ extra usage${spend.stale ? " $?" : ""}`;
  return `🧠 ${body} ⚠ ${formatSpend(spend.spend)}${spend.stale ? " (stale)" : ""}`;
}

/** Green below 70%, yellow at 70–89%, red at 90%+ or whenever the alarm is on. */
export function severityOf(windows: UsageWindow[], alarm = false): Severity {
  if (alarm) return "critical";
  const max = windows.reduce((acc, w) => Math.max(acc, w.percent), 0);
  if (max >= 90) return "critical";
  if (max >= 70) return "warn";
  return "ok";
}

export function composeStatus(
  info: RateLimitInfo | undefined,
  spend: SpendState = { stale: false },
): { text: string; color: ThemeColor } {
  if (!info) return { text: "🧠 …", color: "dim" };
  const windows = parseRateLimit(info);
  const alarm = info.isUsingOverage === true;
  return { text: formatStatusLine(windows, alarm, spend), color: SEVERITY_COLOR[severityOf(windows, alarm)] };
}

/** Interval before the next spend fetch: doubles per consecutive failure, capped. */
export function spendPollDelay(failures: number): number {
  return Math.min(SPEND_POLL_MS * 2 ** failures, SPEND_MAX_BACKOFF_MS);
}

/**
 * Read Claude Code's own OAuth token and fetch usage-credit spend. Throws a
 * token-free error on any failure; the token never leaves the request header.
 */
export async function fetchSpend(env: Record<string, string | undefined>): Promise<Spend> {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  let token: unknown;
  try {
    const creds: unknown = JSON.parse(await readFile(join(configDir, ".credentials.json"), "utf8"));
    token = isRecord(creds) && isRecord(creds.claudeAiOauth) ? creds.claudeAiOauth.accessToken : undefined;
  } catch {
    throw new Error("Claude Code credentials are unreadable");
  }
  if (typeof token !== "string" || token.length === 0) throw new Error("Claude Code has no OAuth token");

  const response = await fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`usage endpoint returned HTTP ${response.status}`);
  const spend = parseSpend(await response.json());
  if (!spend) throw new Error("usage endpoint returned no spend");
  return spend;
}

// Written by the Claude Code process reader, read on turn_end. Module-level
// because the billing guard throws before the info reaches the message.
let latest: RateLimitInfo | undefined;

export function recordRateLimit(info: RateLimitInfo): void {
  latest = info;
}

export function latestRateLimit(): RateLimitInfo | undefined {
  return latest;
}
