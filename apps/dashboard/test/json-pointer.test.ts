import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readPointer, conditionHolds, initialValues, writePointer } from "../src/json-pointer.ts";

describe("JSON pointers", () => {
  it("reads a value from a nested structure", () => {
    assert.equal(readPointer({ options: { mode: "preview" } }, "/options/mode"), "preview");
  });

  it("returns undefined instead of throwing on a missing branch", () => {
    assert.equal(readPointer({}, "/options/mode"), undefined);
  });

  it("decodes ~0 and ~1 sequences per RFC 6901", () => {
    assert.equal(readPointer({ "a/b": 1, "c~d": 2 }, "/a~1b"), 1);
    assert.equal(readPointer({ "a/b": 1, "c~d": 2 }, "/c~0d"), 2);
  });

  it("writes without mutating the input", () => {
    const before = { options: { mode: "preview" } };
    const after = writePointer(before, "/options/mode", "apply");
    assert.equal(after.options.mode, "apply");
    assert.equal(before.options.mode, "preview", "the original must stay untouched");
  });

  it("creates missing branches on write", () => {
    assert.deepEqual(writePointer({}, "/a/b/c", 1), { a: { b: { c: 1 } } });
  });
});

describe("visibility conditions", () => {
  const data = { notify: true, mode: "preview", empty: "" };

  it("present requires a value other than an empty string", () => {
    assert.equal(conditionHolds({ op: "present", pointer: "/mode" }, data), true);
    assert.equal(conditionHolds({ op: "present", pointer: "/empty" }, data), false);
    assert.equal(conditionHolds({ op: "present", pointer: "/missing" }, data), false);
  });

  it("equals also compares structures", () => {
    assert.equal(conditionHolds({ op: "equals", pointer: "/notify", value: true }, data), true);
    assert.equal(conditionHolds({ op: "equals", pointer: "/mode", value: "apply" }, data), false);
  });

  it("in, all, any and not compose recursively", () => {
    assert.equal(conditionHolds({ op: "in", pointer: "/mode", values: ["preview", "apply"] }, data), true);
    assert.equal(conditionHolds({
      op: "all",
      conditions: [{ op: "equals", pointer: "/notify", value: true }, { op: "present", pointer: "/mode" }],
    }, data), true);
    assert.equal(conditionHolds({
      op: "any",
      conditions: [{ op: "equals", pointer: "/mode", value: "apply" }, { op: "present", pointer: "/missing" }],
    }, data), false);
    assert.equal(conditionHolds({ op: "not", condition: { op: "present", pointer: "/missing" } }, data), true);
  });

  it("no condition means \"visible\"", () => {
    assert.equal(conditionHolds(undefined, data), true);
  });
});

describe("initial values from the schema", () => {
  it("takes default fields, including nested ones", () => {
    const schema = {
      type: "object",
      properties: {
        notify: { type: "boolean", default: true },
        options: { type: "object", properties: { includeInactive: { type: "boolean", default: false } } },
        withoutDefault: { type: "string" },
      },
    };
    assert.deepEqual(initialValues(schema), { notify: true, options: { includeInactive: false } });
  });
});
