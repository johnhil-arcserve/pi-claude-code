import assert from "node:assert/strict";
import test from "node:test";
import { composeStatus, formatStatusLine, parseRateLimit, severityOf } from "../src/usage-status.ts";

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
