import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationDefinition, OperationSummary } from "@8lines/gauntlet-protocol";
import { filterOperations, impactBreakdown, impactCounts, policySummary } from "../src/catalog.ts";

function definition(execution: Partial<OperationDefinition["execution"]>, presets = 0): OperationDefinition {
  return {
    execution: {
      impact: "write", dryRunSupported: false, cancellationSupported: false,
      confirmationRequired: false, concurrency: "allow", idempotency: "none", ...execution,
    },
    presets: Array.from({ length: presets }, (_, i) => ({ id: `p${i}`, label: `P${i}` })),
  } as unknown as OperationDefinition;
}

test("policy summary lists what matters before a run, in a fixed order", () => {
  assert.equal(
    policySummary(definition({ dryRunSupported: true, cancellationSupported: true }, 2)),
    "Dry run, can cancel, 2 presets",
  );
  assert.equal(
    policySummary(definition({ impact: "destructive", confirmationRequired: true })),
    "Asks you to confirm, cannot be cancelled",
  );
  assert.equal(
    policySummary(definition({ concurrency: "queue", cancellationSupported: true }, 1)),
    "Waits in a queue, can cancel, 1 preset",
  );
});

test("impact counts and their sentence", () => {
  const counts = impactCounts([
    definition({ impact: "read" }), definition({ impact: "read" }),
    definition({ impact: "write" }), definition({ impact: "destructive" }),
  ]);
  assert.deepEqual(counts, { read: 2, write: 1, destructive: 1 });
  assert.equal(impactBreakdown(counts), "2 read only, 1 changes data, 1 deletes data");
  assert.equal(impactBreakdown({ read: 0, write: 3, destructive: 2 }), "3 change data, 2 delete data");
  assert.equal(impactBreakdown({ read: 0, write: 0, destructive: 0 }), "");
});

test("filter matches label or id, ignoring case and surrounding spaces", () => {
  const operations = [
    { id: "customers.create", label: "Create test customer" },
    { id: "search.reset", label: "Reset search index" },
  ] as unknown as OperationSummary[];
  assert.deepEqual(filterOperations(operations, "  CUSTOMER ").map((o) => o.id), ["customers.create"]);
  assert.deepEqual(filterOperations(operations, "search.").map((o) => o.id), ["search.reset"]);
  assert.deepEqual(filterOperations(operations, "nothing"), []);
  assert.equal(filterOperations(operations, "").length, 2);
});
