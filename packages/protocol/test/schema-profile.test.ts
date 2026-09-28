import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isProtocolId, PROTOCOL_ID_PATTERN } from "../src/identifiers.js";
import { assertTcSchemaCore } from "../src/schema-profile.js";

interface PatternVector {
  readonly name: string;
  readonly sourceJson: string;
  readonly valid: boolean;
  readonly matches?: readonly string[];
  readonly nonMatches?: readonly string[];
}

interface PatternVectorFixture {
  readonly profile: string;
  readonly semantics: string;
  readonly instanceDomain: string;
  readonly vectors: readonly PatternVector[];
}

async function readPatternVectors(): Promise<{ readonly raw: string; readonly fixture: PatternVectorFixture }> {
  const raw = await readFile(
    new URL("../fixtures/v1/tc-schema-core-pattern-vectors.json", import.meta.url),
    "utf8",
  );
  return { raw, fixture: JSON.parse(raw) as PatternVectorFixture };
}

function schemaWithPattern(pattern: string): never {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      value: { type: "string", pattern },
    },
  } as never;
}

test("tc-schema-core pattern vectors freeze the portable one-pass profile", async () => {
  const { raw, fixture } = await readPatternVectors();
  assert.equal([...raw].every((character) => character.codePointAt(0)! < 0x80), true);
  assert.equal(fixture.profile, "tc-schema-core@1");
  assert.equal(fixture.semantics, "ecmascript-unicode-search");
  assert.equal(fixture.instanceDomain, "unicode-scalar-sequences");
  assert.equal(new Set(fixture.vectors.map(({ name }) => name)).size, fixture.vectors.length);

  for (const vector of fixture.vectors) {
    const pattern = JSON.parse(vector.sourceJson) as unknown;
    assert.equal(typeof pattern, "string", `${vector.name}: sourceJson must decode to a string`);

    if (vector.valid) {
      assert.ok(Array.isArray(vector.matches), `${vector.name}: matches missing`);
      assert.ok(Array.isArray(vector.nonMatches), `${vector.name}: nonMatches missing`);
      assert.doesNotThrow(
        () => assertTcSchemaCore(schemaWithPattern(pattern as string), { requireObjectRoot: true }),
        vector.name,
      );

      const expression = new RegExp(pattern as string, "u");
      for (const candidate of vector.matches!) {
        assert.equal(expression.test(candidate), true, `${vector.name}: expected match ${JSON.stringify(candidate)}`);
      }
      for (const candidate of vector.nonMatches!) {
        assert.equal(expression.test(candidate), false, `${vector.name}: expected non-match ${JSON.stringify(candidate)}`);
      }
      continue;
    }

    assert.equal(Object.hasOwn(vector, "matches"), false, `${vector.name}: invalid row has matches`);
    assert.equal(Object.hasOwn(vector, "nonMatches"), false, `${vector.name}: invalid row has nonMatches`);
    assert.throws(
      () => assertTcSchemaCore(schemaWithPattern(pattern as string), { requireObjectRoot: true }),
      {
        name: "TypeError",
        message: "At /properties/value/pattern: pattern is not in the tc-schema-core@1 portable profile",
      },
      vector.name,
    );
  }
});

test("tc-schema-core applies the portable scanner to patternProperties with an escaped pointer", () => {
  assert.throws(
    () => assertTcSchemaCore({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      patternProperties: { "a/b~c.": { type: "string" } },
    }),
    {
      name: "TypeError",
      message: "At /patternProperties/a~1b~0c.: pattern is not in the tc-schema-core@1 portable profile",
    },
  );
});

test("tc-schema-core accepts local refs and rejects remote or unsupported behavior", async () => {
  assert.doesNotThrow(() => assertTcSchemaCore({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: { id: { type: "string" } },
    properties: { id: { $ref: "#/$defs/id" } },
  }, { requireObjectRoot: true }));
  assert.throws(() => assertTcSchemaCore({ $schema: "https://json-schema.org/draft/2020-12/schema", $ref: "https://evil.invalid/schema" }), /non-fragment.*\$ref/i);
  assert.throws(() => assertTcSchemaCore({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", transform: ["trim"] }), /unsupported keyword.*transform/i);

  const remote = JSON.parse(await readFile(new URL("../fixtures/v1/operation.invalid-remote-ref.json", import.meta.url), "utf8"));
  const unsupported = JSON.parse(await readFile(new URL("../fixtures/v1/operation.invalid-schema-profile.json", import.meta.url), "utf8"));
  assert.throws(() => assertTcSchemaCore(remote.inputSchema, { requireObjectRoot: true }), /non-fragment.*\$ref/i);
  assert.throws(() => assertTcSchemaCore(unsupported.inputSchema, { requireObjectRoot: true }), /unsupported keyword/i);
});

test("tc-schema-core reports portable pointers for dialect, root, format, pattern, and cycle failures", () => {
  assert.throws(
    () => assertTcSchemaCore({ $schema: "https://json-schema.org/draft/2019-09/schema", type: "object" }),
    /\/\$schema.*2020-12/i,
  );
  assert.throws(
    () => assertTcSchemaCore({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, { requireObjectRoot: true }),
    /\/type.*object/i,
  );
  assert.throws(
    () => assertTcSchemaCore({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { email: { type: "string", format: "regex" } },
    }),
    /\/properties\/email\/format.*unsupported/i,
  );
  assert.throws(
    () => assertTcSchemaCore({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      patternProperties: { "[": { type: "string" } },
    }),
    /\/patternProperties\/\[.*portable profile/i,
  );

  const cyclic: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
  };
  (cyclic.properties as Record<string, unknown>).self = cyclic;
  assert.throws(() => assertTcSchemaCore(cyclic as never), /\/properties\/self.*cycle/i);
});

test("Protocol IDs use one shared portable safe-segment profile", () => {
  assert.equal(PROTOCOL_ID_PATTERN.source, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
  assert.equal(isProtocolId("operation:review_1.0"), true);
  assert.equal(isProtocolId(`a${"b".repeat(127)}`), true);
  assert.equal(isProtocolId(`a${"b".repeat(128)}`), false);
  assert.equal(isProtocolId("unsafe/id"), false);
  assert.equal(isProtocolId(42), false);
});

test("tc-schema-core rejects malformed supported keyword values at exact pointers", () => {
  const malformed = [
    [
      { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: "id" },
      /At \/required:/,
    ],
    [
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { id: { type: 17 } },
      },
      /At \/properties\/id\/type:/,
    ],
    [
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { id: { type: "string", minLength: -1 } },
      },
      /At \/properties\/id\/minLength:/,
    ],
  ] as const;

  for (const [schema, expectedPointer] of malformed) {
    assert.throws(() => assertTcSchemaCore(schema as never), expectedPointer);
  }
});

test("tc-schema-core accepts and validates productive properties/items recursion plus boolean refs", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: {
      allowed: true,
      forbidden: false,
      node: {
        type: "object",
        properties: {
          next: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] },
          children: { type: "array", items: { $ref: "#/$defs/node" } },
        },
        additionalProperties: false,
      },
    },
    properties: {
      enabled: { $ref: "#/$defs/allowed" },
      forbidden: { $ref: "#/$defs/forbidden" },
      root: { $ref: "#/$defs/node" },
    },
  } as const;

  assert.doesNotThrow(() => assertTcSchemaCore(schema, { requireObjectRoot: true }));

  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate({ enabled: "any value", root: { next: null, children: [] } }), true);
  assert.equal(validate({ root: { next: { children: [] }, children: [{ next: null }] } }), true);
  assert.equal(validate({ forbidden: null }), false);
});

test("tc-schema-core rejects a direct non-productive root reference at the ref pointer", () => {
  assert.throws(() => assertTcSchemaCore({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#",
  }), /At \/\$ref:.*non-productive same-instance cycle/i);
});

test("tc-schema-core rejects a reachable annotation-target cycle at its closing ref", () => {
  assert.throws(() => assertTcSchemaCore({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { value: { $ref: "#/default" } },
    default: { $ref: "#/examples/0" },
    examples: [{ $ref: "#/default" }],
  }), /At \/examples\/0\/\$ref:.*non-productive same-instance cycle/i);
});

test("tc-schema-core rejects unresolved local refs at the ref pointer", () => {
  assert.throws(() => assertTcSchemaCore({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $ref: "#/$defs/missing",
    $defs: { present: { type: "string" } },
  }, { requireObjectRoot: true }), /At \/\$ref:.*unresolved/i);
});

const referencedAnnotationVectors = [
  {
    name: "external refs",
    target: { $ref: "https://evil.invalid/schema" },
    pointer: /At \/default\/\$ref:.*non-fragment/i,
  },
  {
    name: "unsupported keywords",
    target: { transform: ["trim"] },
    pointer: /At \/default\/transform:.*unsupported keyword/i,
  },
  {
    name: "malformed keyword values",
    target: { type: 17 },
    pointer: /At \/default\/type:.*invalid Draft 2020-12/i,
  },
] as const;

for (const { name, target, pointer } of referencedAnnotationVectors) {
  test(`tc-schema-core rejects ${name} exposed by a local ref into annotation data`, () => {
    assert.throws(() => assertTcSchemaCore({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      default: target,
      properties: { value: { $ref: "#/default" } },
    } as never), pointer);
  });
}

test("tc-schema-core leaves identical unreferenced annotation objects as JSON instance data", () => {
  const [external, unsupported, malformed] = referencedAnnotationVectors;
  assert.doesNotThrow(() => assertTcSchemaCore({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    default: external.target,
    const: unsupported.target,
    enum: [malformed.target],
    examples: [external.target, unsupported.target, malformed.target],
  } as never));
});
