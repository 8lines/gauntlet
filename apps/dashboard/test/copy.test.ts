import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionPolicy, Problem, RunState } from "@8lines/gauntlet-protocol";
import { describeProblem, impactLabel, policyEffects, runStateLabel } from "../src/copy.ts";

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
