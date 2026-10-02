import assert from "node:assert/strict";
import { test } from "node:test";
import type { Problem } from "@8lines/gauntlet-protocol";
import type { TargetSnapshot } from "../src/api.ts";
import { applyTargetsResult } from "../src/useTargets.ts";

const target = { id: "a", label: "A", tags: [], state: "online", refreshedAt: "2026-09-03T12:00:00Z" } as TargetSnapshot;
const problem: Problem = { type: "urn:gauntlet:problem:network-unreachable", title: "Could not connect", status: 0 };

test("a failed first load reports the problem and no environments", () => {
  assert.deepEqual(applyTargetsResult({}, { ok: false, problem }), { problem });
});

test("a failed refresh keeps the last environments and reports the problem", () => {
  assert.deepEqual(applyTargetsResult({ targets: [target] }, { ok: false, problem }), { targets: [target], problem });
  assert.deepEqual(applyTargetsResult({ targets: [target], problem }, { ok: false, problem }), { targets: [target], problem });
});

test("a successful load replaces the environments and clears the problem", () => {
  assert.deepEqual(applyTargetsResult({ targets: [target], problem }, { ok: true, data: [] }), { targets: [] });
});
