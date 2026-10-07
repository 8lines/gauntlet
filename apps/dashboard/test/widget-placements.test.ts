import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageContext, PageSubject } from "@8lines/gauntlet-widget-channel";
import { applyPins, panelLists, subjectChip } from "../src/widget/placements.ts";

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

function context(subjects: readonly PageSubject[]): PageContext {
  return { target: "portal", subjects };
}

const orderSubject: PageSubject = { type: "order", values: { orderId: "123" } };

describe("panelLists", () => {
  it("matches a subject-placed operation only when the context has that subject type", () => {
    const op = operation({ placements: [{ kind: "subject", subjectType: "order" }] });

    const matching = panelLists([op], context([orderSubject]));
    assert.deepEqual(matching.contextual, [{ operation: op, subject: orderSubject }]);
    assert.deepEqual(matching.global, []);

    const nonMatching = panelLists([op], context([{ type: "customer", values: {} }]));
    assert.deepEqual(nonMatching.contextual, []);
    assert.deepEqual(nonMatching.global, []);
  });

  it("puts a global-only operation in the global list", () => {
    const op = operation({ placements: [{ kind: "global" }] });
    const result = panelLists([op], context([]));
    assert.deepEqual(result.contextual, []);
    assert.deepEqual(result.global, [op]);
  });

  it("lists an operation with both global and subject placements as contextual only on a matching page", () => {
    const op = operation({ placements: [{ kind: "global" }, { kind: "subject", subjectType: "order" }] });
    const result = panelLists([op], context([orderSubject]));
    assert.deepEqual(result.contextual, [{ operation: op, subject: orderSubject }]);
    assert.deepEqual(result.global, []);
  });

  it("lists the same both-placement operation as global on a non-matching page", () => {
    const op = operation({ placements: [{ kind: "global" }, { kind: "subject", subjectType: "order" }] });
    const result = panelLists([op], context([{ type: "customer", values: {} }]));
    assert.deepEqual(result.contextual, []);
    assert.deepEqual(result.global, [op]);
  });

  it("puts operations without placements in neither list", () => {
    const op = operation();
    const result = panelLists([op], context([orderSubject]));
    assert.deepEqual(result.contextual, []);
    assert.deepEqual(result.global, []);
  });

  it("yields no contextual entries for an undefined context", () => {
    const subjectOnly = operation({ placements: [{ kind: "subject", subjectType: "order" }] });
    const global = operation({ id: "op-2", placements: [{ kind: "global" }] });
    const result = panelLists([subjectOnly, global], undefined);
    assert.deepEqual(result.contextual, []);
    assert.deepEqual(result.global, [global]);
  });
});

describe("subjectChip", () => {
  it('renders "order 123" for a single-value order subject', () => {
    assert.equal(subjectChip({ type: "order", values: { orderId: "123" } }), "order 123");
  });
});

describe("applyPins", () => {
  const contextualOp = operation({ id: "contextual", placements: [{ kind: "subject", subjectType: "order" }] });
  const otherContextual = operation({ id: "other-contextual", placements: [{ kind: "subject", subjectType: "order" }] });
  const globalOp = operation({ id: "global", placements: [{ kind: "global" }] });
  const lists = {
    contextual: [{ operation: contextualOp, subject: orderSubject }, { operation: otherContextual, subject: orderSubject }],
    global: [globalOp],
  };

  it("leaves the lists as they are without pins", () => {
    assert.deepEqual(applyPins(lists, undefined), { pinned: [], ...lists });
    assert.deepEqual(applyPins(lists, []), { pinned: [], ...lists });
  });

  it("moves pinned operations into pinned, in pin order, keeping the page subject", () => {
    const result = applyPins(lists, ["global", "contextual"]);
    assert.deepEqual(result.pinned, [
      { operation: globalOp, subject: undefined },
      { operation: contextualOp, subject: orderSubject },
    ]);
    assert.deepEqual(result.contextual, [{ operation: otherContextual, subject: orderSubject }]);
    assert.deepEqual(result.global, []);
  });

  it("ignores pinned operations that are in neither list", () => {
    const result = applyPins(lists, ["unplaced", "not-on-this-page", "contextual"]);
    assert.deepEqual(result.pinned, [{ operation: contextualOp, subject: orderSubject }]);
    assert.deepEqual(result.contextual, [{ operation: otherContextual, subject: orderSubject }]);
    assert.deepEqual(result.global, [globalOp]);
  });
});
