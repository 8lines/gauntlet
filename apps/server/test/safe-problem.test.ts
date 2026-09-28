import assert from "node:assert/strict";
import { test } from "node:test";
import { safeProblem } from "../src/safe-problem.js";

test("execution-policy Problems retain fixed safe titles and statuses", () => {
  const cases = [
    ["urn:gauntlet:problem:operation-busy", "Operation busy", 409],
    ["urn:gauntlet:problem:run-not-cancellable", "Run is not cancellable", 409],
    ["urn:gauntlet:problem:run-cancelled", "Run cancelled", 409],
    ["urn:gauntlet:problem:run-timed-out", "Run timed out", 504],
  ] as const;

  for (const [type, title, status] of cases) {
    assert.deepEqual(safeProblem({
      type,
      title: "hostile adapter title",
      status: status === 504 ? 409 : 599,
      detail: "hostile adapter detail",
    }), { type, title, status });
  }
});

test("target environment mismatch retains only its fixed safe contract", () => {
  assert.deepEqual(safeProblem({
    type: "urn:gauntlet:problem:target-environment-mismatch",
    title: "Mismatch at https://private.internal with secret",
    status: 599,
    detail: "secret",
  }), {
    type: "urn:gauntlet:problem:target-environment-mismatch",
    title: "Target environment mismatch",
    status: 503,
  });
});
