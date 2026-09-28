import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonPointer } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { applyBindings, bindingValues, prefillForPreset, restoreSkippedBindings } from "../src/widget/prefill.ts";

const subject: PageSubject = {
  type: "order",
  values: { orderId: "123", quantity: "12.5", isRush: "true", note: "abc" },
};

describe("bindingValues", () => {
  it("maps a pointer to the subject value at the bound key", () => {
    const result = bindingValues({ "/customer/id": "orderId" }, subject);
    assert.deepEqual(result, [{ pointer: "/customer/id", value: "123" }]);
  });

  it("drops bindings whose key is missing from the subject", () => {
    const result = bindingValues({ "/customer/id": "missingKey" }, subject);
    assert.deepEqual(result, []);
  });

  it("returns an empty list when there are no placement bindings", () => {
    assert.deepEqual(bindingValues(undefined, subject), []);
  });

  it('drops a binding keyed "constructor" instead of resolving Object.prototype.constructor', () => {
    const result = bindingValues({ "/customer/id": "constructor" }, subject);
    assert.deepEqual(result, []);
  });
});

describe("applyBindings", () => {
  const schema = {
    type: "object",
    properties: {
      customer: {
        type: "object",
        properties: {
          id: { type: "integer" },
          quantity: { type: "number" },
          rush: { type: "boolean" },
          note: { type: "integer" },
        },
      },
      other: { type: "string" },
    },
  };

  it("writes nested pointers without clobbering sibling fields", () => {
    const base = { customer: { id: 0, other: "kept" }, other: "sibling" };
    const bindings = [{ pointer: "/customer/id" as JsonPointer, value: "123" }];
    const result = applyBindings(base, schema, bindings, []);
    assert.deepEqual(result.values, { customer: { id: 123, other: "kept" }, other: "sibling" });
  });

  it("skips locked pointers and reports them in skipped", () => {
    const base = { customer: { id: 0 } };
    const bindings = [{ pointer: "/customer/id" as JsonPointer, value: "123" }];
    const result = applyBindings(base, schema, bindings, ["/customer/id"]);
    assert.deepEqual(result.values, { customer: { id: 0 } });
    assert.deepEqual(result.skipped, ["/customer/id"]);
  });

  it('coerces "123" to 123 for an integer leaf', () => {
    const result = applyBindings({}, schema, [{ pointer: "/customer/id" as JsonPointer, value: "123" }], []);
    assert.equal((result.values as { customer: { id: unknown } }).customer.id, 123);
  });

  it('keeps "12.5" as a string for an integer leaf', () => {
    const result = applyBindings({}, schema, [{ pointer: "/customer/note" as JsonPointer, value: "12.5" }], []);
    assert.equal((result.values as { customer: { note: unknown } }).customer.note, "12.5");
  });

  it('coerces "12.5" to 12.5 for a number leaf', () => {
    const result = applyBindings({}, schema, [{ pointer: "/customer/quantity" as JsonPointer, value: "12.5" }], []);
    assert.equal((result.values as { customer: { quantity: unknown } }).customer.quantity, 12.5);
  });

  it('coerces "true" to true for a boolean leaf', () => {
    const result = applyBindings({}, schema, [{ pointer: "/customer/rush" as JsonPointer, value: "true" }], []);
    assert.equal((result.values as { customer: { rush: unknown } }).customer.rush, true);
  });

  it('keeps "abc" as a string for an integer leaf', () => {
    const result = applyBindings({}, schema, [{ pointer: "/customer/id" as JsonPointer, value: "abc" }], []);
    assert.equal((result.values as { customer: { id: unknown } }).customer.id, "abc");
  });

  it("finds the leaf schema through an escaped pointer segment", () => {
    const schemaWithEscapedProperty = {
      type: "object",
      properties: { "a/b": { type: "integer" } },
    };
    const result = applyBindings({}, schemaWithEscapedProperty, [{ pointer: "/a~1b" as JsonPointer, value: "42" }], []);
    assert.deepEqual(result.values, { "a/b": 42 });
  });

  it("does not mutate base", () => {
    const base = { customer: { id: 0 } };
    const snapshot = JSON.parse(JSON.stringify(base));
    applyBindings(base, schema, [{ pointer: "/customer/id" as JsonPointer, value: "123" }], []);
    assert.deepEqual(base, snapshot);
  });

  it("turns number and boolean subject values into strings for a string leaf", () => {
    const bindings = [
      { pointer: "/other" as JsonPointer, value: 42 },
      { pointer: "/label" as JsonPointer, value: true },
    ];
    const schemaWithLabel = { type: "object", properties: { other: { type: "string" }, label: { type: "string" } } };
    const result = applyBindings({}, schemaWithLabel, bindings, []);
    assert.deepEqual(result.values, { other: "42", label: "true" });
  });

  it("keeps number and boolean subject values for number and boolean leaves", () => {
    const bindings = [
      { pointer: "/customer/quantity" as JsonPointer, value: 7 },
      { pointer: "/customer/rush" as JsonPointer, value: false },
    ];
    const result = applyBindings({}, schema, bindings, []);
    assert.deepEqual(result.values, { customer: { quantity: 7, rush: false } });
  });
});

describe("prefillForPreset", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string" }, y: { type: "string" } },
  };
  const defaults = { x: "", y: "" };
  const presetA = { input: { x: "from A", y: "a" }, lockedPointers: ["/x" as JsonPointer] };
  const presetB = { input: { x: "from B", y: "b" } };
  const bindings = [{ pointer: "/x" as JsonPointer, value: "from page" }];

  it("applies bindings over the defaults when no preset is selected", () => {
    assert.deepEqual(prefillForPreset(schema, defaults, undefined, bindings), {
      values: { x: "from page", y: "" },
      skipped: [],
    });
  });

  it("leaves the base untouched when the page has no bindings", () => {
    assert.deepEqual(prefillForPreset(schema, defaults, presetB, undefined), {
      values: { x: "from B", y: "b" },
      skipped: [],
    });
  });

  it("keeps a preset lock across switching presets back and forth", () => {
    const first = prefillForPreset(schema, defaults, presetA, bindings);
    assert.deepEqual(first, { values: { x: "from A", y: "a" }, skipped: ["/x"] });

    // B locks nothing, so the page value wins.
    const second = prefillForPreset(schema, defaults, presetB, bindings);
    assert.deepEqual(second, { values: { x: "from page", y: "b" }, skipped: [] });

    const third = prefillForPreset(schema, defaults, presetA, bindings);
    assert.deepEqual(third, { values: { x: "from A", y: "a" }, skipped: ["/x"] });
  });
});

describe("restoreSkippedBindings", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "integer" }, y: { type: "string" }, z: { type: "string" } },
  };
  const bindings = [
    { pointer: "/x" as JsonPointer, value: "7" },
    { pointer: "/y" as JsonPointer, value: "from page" },
  ];

  it("re-applies the page values only for the pointers a preset lock skipped", () => {
    // The user edited /y after the page value was applied; unlocking must not undo that.
    const current = { x: 1, y: "edited", z: "kept" };
    const restored = restoreSkippedBindings(current, schema, bindings, ["/x" as JsonPointer]);
    assert.deepEqual(restored, { x: 7, y: "edited", z: "kept" });
  });

  it("returns the values unchanged when nothing was skipped or the page has no bindings", () => {
    const current = { x: 1, y: "edited" };
    assert.equal(restoreSkippedBindings(current, schema, bindings, []), current);
    assert.equal(restoreSkippedBindings(current, schema, undefined, ["/x" as JsonPointer]), current);
  });
});
