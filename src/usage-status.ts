/**
 * Claude plan usage in Pi's footer, in the same format as
 * pi-claude-subscription-connector's usage-status. Fed by Claude Code's
 * `rate_limit_event` rather than the OAuth usage endpoint, because Claude Code
 * keeps the subscription token to itself.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { RateLimitInfo } from "./billing.ts";

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

/** "🧠 5h 19% · wk 24%" (+ " ⚠ extra usage" when billed to usage credits). */
export function formatStatusLine(windows: UsageWindow[], alarm = false): string {
  const body = windows.length > 0 ? windows.map((w) => `${w.label} ${w.percent}%`).join(" · ") : "usage n/a";
  return `🧠 ${body}${alarm ? " ⚠ extra usage" : ""}`;
}

/** Green below 70%, yellow at 70–89%, red at 90%+ or whenever the alarm is on. */
export function severityOf(windows: UsageWindow[], alarm = false): Severity {
  if (alarm) return "critical";
  const max = windows.reduce((acc, w) => Math.max(acc, w.percent), 0);
  if (max >= 90) return "critical";
  if (max >= 70) return "warn";
  return "ok";
}

export function composeStatus(info: RateLimitInfo | undefined): { text: string; color: ThemeColor } {
  if (!info) return { text: "🧠 …", color: "dim" };
  const windows = parseRateLimit(info);
  const alarm = info.isUsingOverage === true;
  return { text: formatStatusLine(windows, alarm), color: SEVERITY_COLOR[severityOf(windows, alarm)] };
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
