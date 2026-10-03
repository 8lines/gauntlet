import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionPolicy, Problem, RunState } from "@8lines/gauntlet-protocol";
import {
  describeProblem,
  elapsedMilliseconds,
  formatElapsed,
  formatRelativeTime,
  impactLabel,
  policyEffects,
  runStateLabel,
} from "../src/copy.ts";

const policies: ExecutionPolicy[] = (["read", "write", "destructive"] as const).flatMap((impact) =>
  [true, false].map((flag) => ({
    impact, dryRunSupported: flag, cancellationSupported: flag, confirmationRequired: flag,
    concurrency: flag ? "queue" : "forbid", idempotency: flag ? "required" : "none", timeoutSeconds: 120,
  }) as unknown as ExecutionPolicy),
);
const states: RunState[] = ["queued", "running", "succeeded", "failed", "partial", "cancelled", "timed_out", "expired"];
const problemTypes = [
  "validation-failed", "unsupported-capability", "target-not-found",
  "adapter-protocol-incompatible", "network-unreachable", "unknown",
].map((name) => ({ type: `urn:gauntlet:problem:${name}`, title: "Title", status: 400 }) as Problem);

test("user-facing copy contains no em dash", () => {
  const strings = [
    ...policies.flatMap((p) => policyEffects(p).map((e) => e.text)),
    ...states.map((s) => runStateLabel(s).label),
    ...problemTypes.flatMap((p) => Object.values(describeProblem(p))),
    ...(["read", "write", "destructive"] as const).map(impactLabel),
  ];
  for (const text of strings) assert.ok(!text.includes("—"), text);
});

test("relative time steps from seconds through minutes and hours to days", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const ago = (seconds: number) => formatRelativeTime(new Date(now.getTime() - seconds * 1000).toISOString(), now);
  assert.equal(ago(2), "just now");
  assert.equal(ago(-30), "just now");
  assert.equal(ago(12), "12 s ago");
  assert.equal(ago(5 * 60), "5 min ago");
  assert.equal(ago(3 * 3600), "3 h ago");
  assert.equal(ago(23 * 3600), "23 h ago");
  assert.equal(ago(24 * 3600), "1 d ago");
  assert.equal(ago(2 * 86_400 + 3600), "2 d ago");
  assert.equal(ago(30 * 86_400), "30 d ago");
});

test("relative time of an unparsable timestamp is unknown, never NaN", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  for (const timestamp of ["", "not a date", "2026-13-45T99:00:00Z"]) {
    const text = formatRelativeTime(timestamp, now);
    assert.equal(text, "at an unknown time");
    assert.ok(!text.includes("NaN"), text);
  }
  assert.equal(formatRelativeTime("2026-10-02T11:00:00Z", new Date(Number.NaN)), "at an unknown time");
});

test("elapsed time reads in the largest sensible unit", () => {
  assert.equal(formatElapsed(0), "0 ms");
  assert.equal(formatElapsed(850), "850 ms");
  assert.equal(formatElapsed(999.4), "999 ms");
  assert.equal(formatElapsed(999.6), "1 s");
  assert.equal(formatElapsed(1000), "1 s");
  assert.equal(formatElapsed(3400), "3.4 s");
  assert.equal(formatElapsed(9960), "10 s");
  assert.equal(formatElapsed(42_300), "42 s");
  assert.equal(formatElapsed(59_600), "1 min");
  assert.equal(formatElapsed(125_000), "2 min 5 s");
  assert.equal(formatElapsed(3_600_000), "1 h");
  assert.equal(formatElapsed(3_900_000), "1 h 5 min");
  assert.equal(formatElapsed(Number.NaN), "an unknown time");
  assert.equal(formatElapsed(-1), "an unknown time");
});

test("elapsed milliseconds need both timestamps in order", () => {
  assert.equal(elapsedMilliseconds("2026-09-03T12:00:01Z", "2026-09-03T12:00:03.400Z"), 2400);
  assert.equal(elapsedMilliseconds(undefined, "2026-09-03T12:00:03Z"), undefined);
  assert.equal(elapsedMilliseconds("2026-09-03T12:00:01Z", undefined), undefined);
  assert.equal(elapsedMilliseconds("2026-09-03T12:00:03Z", "2026-09-03T12:00:01Z"), undefined);
  assert.equal(elapsedMilliseconds("not a date", "2026-09-03T12:00:01Z"), undefined);
});
