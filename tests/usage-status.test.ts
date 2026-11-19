import assert from "node:assert/strict";
import test from "node:test";
import {
  composeStatus,
  formatStatusLine,
  parseRateLimit,
  parseSpend,
  severityOf,
  SPEND_MAX_BACKOFF_MS,
  SPEND_POLL_MS,
  spendPollDelay,
} from "../src/usage-status.ts";

test("parseRateLimit converts unifiedWindows utilization to labelled percentages", () => {
  const windows = parseRateLimit({
    unifiedWindows: {
      five_hour: { utilization: 0.194, status: "allowed" },
      seven_day: { utilization: 1, status: "rejected" },
      seven_day_new: { utilization: 0.5 },
      broken: { status: "allowed" },
    },
  });
  assert.deepEqual(windows, [
    { label: "5h", percent: 19 },
    { label: "wk", percent: 100 },
    { label: "seven_day_new", percent: 50 },
  ]);
});

test("parseRateLimit returns nothing when unifiedWindows is absent", () => {
  assert.deepEqual(parseRateLimit({ rateLimitType: "overage" }), []);
});

test("formatStatusLine matches the connector's format", () => {
  const windows = [
    { label: "5h", percent: 19 },
    { label: "wk", percent: 24 },
  ];
  assert.equal(formatStatusLine(windows), "🧠 5h 19% · wk 24%");
  assert.equal(formatStatusLine(windows, true), "🧠 5h 19% · wk 24% ⚠ extra usage");
  assert.equal(formatStatusLine([]), "🧠 usage n/a");
});

test("severityOf uses 70/90 thresholds and the overage alarm", () => {
  assert.equal(severityOf([{ label: "5h", percent: 69 }]), "ok");
  assert.equal(severityOf([{ label: "5h", percent: 70 }]), "warn");
  assert.equal(severityOf([{ label: "5h", percent: 90 }]), "critical");
  assert.equal(severityOf([{ label: "5h", percent: 0 }], true), "critical");
});

test("composeStatus is dim until the first rate-limit event and red on overage", () => {
  assert.deepEqual(composeStatus(undefined), { text: "🧠 …", color: "dim" });
  assert.deepEqual(
    composeStatus({ isUsingOverage: true, unifiedWindows: { five_hour: { utilization: 0 } } }),
    { text: "🧠 5h 0% ⚠ extra usage", color: "error" },
  );
});

// Shape observed from /api/oauth/usage on 2026-11-19, with no cap set.
const uncapped = {
  extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 66006, currency: "USD", decimal_places: 2 },
  spend: { used: { amount_minor: 66006, currency: "USD", exponent: 2 }, limit: null, balance: null },
};

test("parseSpend reads used spend without inventing a limit", () => {
  assert.deepEqual(parseSpend(uncapped), { used: 660.06, currency: "USD" });
});

test("parseSpend takes the limit from spend.limit or extra_usage.monthly_limit", () => {
  const withSpendLimit = { ...uncapped, spend: { ...uncapped.spend, limit: { amount_minor: 25000, currency: "USD", exponent: 2 } } };
  assert.deepEqual(parseSpend(withSpendLimit), { used: 660.06, limit: 250, currency: "USD" });
  const withMonthly = { extra_usage: { ...uncapped.extra_usage, monthly_limit: 25000, used_credits: 18500 } };
  assert.deepEqual(parseSpend(withMonthly), { used: 185, limit: 250, currency: "USD" });
});

test("parseSpend returns nothing when the response has no spend", () => {
  assert.equal(parseSpend({ five_hour: { utilization: 0 } }), undefined);
  assert.equal(parseSpend(null), undefined);
});

test("formatStatusLine replaces the extra-usage marker with spend", () => {
  const windows = [{ label: "wk", percent: 100 }];
  assert.equal(
    formatStatusLine(windows, true, { spend: { used: 185, limit: 250, currency: "USD" }, stale: false }),
    "🧠 wk 100% ⚠ $185/$250 74%",
  );
  assert.equal(
    formatStatusLine(windows, true, { spend: { used: 660.06, currency: "USD" }, stale: true }),
    "🧠 wk 100% ⚠ $660 used (stale)",
  );
  assert.equal(formatStatusLine(windows, true, { stale: true }), "🧠 wk 100% ⚠ extra usage $?");
  assert.equal(formatStatusLine(windows, false, { spend: { used: 1, currency: "USD" }, stale: false }), "🧠 wk 100%");
});

test("spendPollDelay backs off per failure up to the cap", () => {
  assert.equal(spendPollDelay(0), SPEND_POLL_MS);
  assert.equal(spendPollDelay(1), 2 * SPEND_POLL_MS);
  assert.equal(spendPollDelay(10), SPEND_MAX_BACKOFF_MS);
});
