import assert from "node:assert/strict";
import { test } from "node:test";
import type { ValidationError } from "@8lines/gauntlet-protocol";
import { attachToFields, generalErrors } from "../src/operation-errors.ts";

const missing = { instancePath: "", keyword: "required", params: { missingProperty: "email" }, message: "must have required property 'email'" } as unknown as ValidationError;
const general = { instancePath: "", keyword: "anyOf", message: "must match a schema in anyOf" } as unknown as ValidationError;

test("a missing required field is attached to that field", () => {
  assert.equal(attachToFields([missing])[0]!.instancePath, "/email");
});

test("errors without a field stay general and are de-duplicated", () => {
  assert.deepEqual(generalErrors(attachToFields([missing, general, general])), ["must match a schema in anyOf"]);
});
