import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonPointer, OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { openOperationView, pageSubjectDrifted, reseedOperationView, runCreatedIn, type View } from "../src/widget/view.ts";

function operation(id: string): OperationSummary {
  return {
    id,
    revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    label: id,
    featureId: "feature",
    availability: { state: "available" },
  } as OperationSummary;
}

const first: PageSubject = { type: "agency-application", values: { applicationId: "1" } };
const second: PageSubject = { type: "agency-application", values: { applicationId: "2" } };
const firstBindings = [{ pointer: "/applicationId" as JsonPointer, value: "1" }];
const secondBindings = [{ pointer: "/applicationId" as JsonPointer, value: "2" }];

describe("runCreatedIn", () => {
  const view = openOperationView("portal", operation("b"), first, firstBindings);

  it("marks the open operation's view as showing a run", () => {
    const next = runCreatedIn(view, "portal", "b");
    assert.equal(next.kind === "operation" && next.runShown, true);
  });

  it("ignores a late run for an operation the user already left", () => {
    assert.equal(runCreatedIn(view, "portal", "a"), view);
  });

  it("ignores a late run for the same operation id on another target", () => {
    assert.equal(runCreatedIn(view, "other", "b"), view);
  });

  it("ignores a run when the lists or a recent run are shown", () => {
    const lists: View = { kind: "lists" };
    assert.equal(runCreatedIn(lists, "portal", "b"), lists);
  });
});

describe("openOperationView / reseedOperationView", () => {
  it("freezes the subject and bindings the operation was opened with", () => {
    const view = openOperationView("portal", operation("b"), first, firstBindings);
    assert.deepEqual(view, {
      kind: "operation", targetId: "portal", operation: operation("b"), subject: first, bindings: firstBindings, runShown: false,
    });
  });

  it("re-seeds only the subject and bindings, keeping runShown", () => {
    const view = { ...openOperationView("portal", operation("b"), first, firstBindings), runShown: true };
    const next = reseedOperationView(view, second, secondBindings);
    assert.deepEqual(next, { ...view, subject: second, bindings: secondBindings });
  });
});

describe("pageSubjectDrifted", () => {
  it("is false while the page still shows the frozen subject", () => {
    assert.equal(pageSubjectDrifted(first, { type: "agency-application", values: { applicationId: "1" } }, firstBindings), false);
  });

  it("is true when the page now shows another subject with bindings", () => {
    assert.equal(pageSubjectDrifted(first, second, secondBindings), true);
  });

  it("is true when the operation was opened without a subject and the page now has one", () => {
    assert.equal(pageSubjectDrifted(undefined, second, secondBindings), true);
  });

  it("is false when the page has no subject for the operation or nothing to bind", () => {
    assert.equal(pageSubjectDrifted(first, undefined, undefined), false);
    assert.equal(pageSubjectDrifted(first, second, []), false);
  });

  it("compares subject values regardless of key order", () => {
    const a: PageSubject = { type: "t", values: { x: "1", y: "2" } };
    const b: PageSubject = { type: "t", values: { y: "2", x: "1" } };
    assert.equal(pageSubjectDrifted(a, b, firstBindings), false);
  });
});
