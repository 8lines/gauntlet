import assert from "node:assert/strict";
import test from "node:test";
import { createAjvSchemaValidator } from "../src/index.js";

test("public validator rejects an invalid tc-schema-core schema without retrieving refs", () => {
  const validator = createAjvSchemaValidator();
  assert.throws(() => validator.validate({ $schema: "https://json-schema.org/draft/2020-12/schema", $ref: "https://hostile.invalid/schema" }, {}), /non-fragment/i);
});

test("public validator owns input and returns deeply frozen diagnostics", () => {
  const validator = createAjvSchemaValidator();
  let reads = 0;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, "name", {
    enumerable: true,
    get() {
      reads += 1;
      return 42;
    },
  });
  assert.throws(() => validator.validate({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
  }, hostile as never), /canonical plain JSON/i);
  assert.equal(reads, 0);

  const diagnostics = validator.validate({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
    additionalProperties: false,
  }, {});
  assert.equal(diagnostics.length, 1);
  assert.equal(Object.isFrozen(diagnostics), true);
  assert.equal(Object.isFrozen(diagnostics[0]), true);
  assert.equal(Object.isFrozen(diagnostics[0]?.params), true);
});

test("public validator never reflects caller-controlled property names in diagnostics", () => {
  const validator = createAjvSchemaValidator();
  const sentinel = "SECRET_CALLER_FIELD";
  const diagnostics = validator.validate({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
  }, { [sentinel]: true });

  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes(sentinel), false);
  assert.deepEqual(diagnostics[0]?.params, {});
  assert.equal(diagnostics[0]?.message, "value does not satisfy schema");
});
