import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OperationSummary } from "@8lines/gauntlet-protocol";
import { searchOperations } from "../src/widget/search.ts";

function operation(overrides: Record<string, unknown> = {}): OperationSummary {
  return {
    id: "op-1",
    revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    label: "Operation",
    featureId: "feature",
    availability: { state: "available" },
    ...overrides,
  } as OperationSummary;
}

describe("searchOperations", () => {
  it("matches on label", () => {
    const sendInvoice = operation({ id: "op-1", label: "Send invoice" });
    const other = operation({ id: "op-2", label: "Close account" });
    assert.deepEqual(searchOperations([sendInvoice, other], "invoic"), [sendInvoice]);
  });

  it("matches on description", () => {
    const withDescription = operation({ id: "op-1", label: "Step 1", description: "Sends the invoice to the customer" });
    const other = operation({ id: "op-2", label: "Step 2", description: "Nothing related" });
    assert.deepEqual(searchOperations([withDescription, other], "invoic"), [withDescription]);
  });

  it("matches on tags", () => {
    const withTag = operation({ id: "op-1", label: "Step 1", tags: ["invoices", "finance"] });
    const other = operation({ id: "op-2", label: "Step 2", tags: ["logistics"] });
    assert.deepEqual(searchOperations([withTag, other], "invoic"), [withTag]);
  });

  it("is case-insensitive with non-ASCII letters", () => {
    const zurich = operation({ id: "op-1", label: "Zürich office" });
    assert.deepEqual(searchOperations([zurich], "ZÜRICH"), [zurich]);
  });

  it("returns an empty list for an empty or whitespace-only query", () => {
    const ops = [operation({ id: "op-1" }), operation({ id: "op-2" })];
    assert.deepEqual(searchOperations(ops, ""), []);
    assert.deepEqual(searchOperations(ops, "   "), []);
  });
});
