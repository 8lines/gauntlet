import assert from "node:assert/strict";
import { test } from "node:test";
import { computeRevision, type JsonObject } from "@8lines/gauntlet-protocol";
import {
  defineOperation,
  OperationRegistry,
  type OperationDefinitionDraft,
  type RegisteredOperation,
} from "../src/index.js";
import { feature, operation } from "./support/operation.js";

test("registry rejects duplicate operation IDs without replacing the original", () => {
  const registry = new OperationRegistry();
  registry.registerFeature(feature("agency"));
  registry.register(operation("agency.demote"));
  assert.throws(() => registry.register(operation("agency.demote")), /duplicate operation id/i);
  assert.equal(registry.require("agency.demote").definition.label, "First");
});

test("registry rejects an operation whose feature is not registered", () => {
  const registry = new OperationRegistry();
  assert.throws(() => registry.register(operation("agency.demote")), /unknown feature/i);
});

test("defineOperation derives the revision from definition content", () => {
  const first = operation("agency.demote");
  const second = operation("agency.demote", { label: "Changed" });
  assert.match(first.definition.revision, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(first.definition.revision, second.definition.revision);
});

test("defineOperation rejects definitions that violate shared protocol semantics", () => {
  const cases: readonly {
    readonly id: string;
    readonly overrides: Partial<OperationDefinitionDraft>;
  }[] = [
    {
      id: "agency.duplicate-data-sources",
      overrides: {
        dataSources: [
          { id: "catalog", inputPointer: "/first", dependencyPointers: [] },
          { id: "catalog", inputPointer: "/second", dependencyPointers: [] },
        ],
      },
    },
    {
      id: "agency.duplicate-presets",
      overrides: {
        presets: [
          { id: "same", label: "First", input: {} },
          { id: "same", label: "Second", input: {} },
        ],
      },
    },
    {
      id: "agency.secret-bearing-preset",
      overrides: {
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { apiToken: { type: "string" } },
        },
        inputHandling: {
          rules: [{
            kind: "secret",
            schemaPointer: "/properties/apiToken",
            retention: "none",
          }],
        },
        presets: [{
          id: "seeded",
          label: "Seeded",
          input: { apiToken: "adapter-supplied-secret" },
        }],
      },
    },
    {
      id: "agency.undeclared-ui-data-source",
      overrides: {
        dataSources: [],
        uiSchema: {
          profile: "tc-rich-forms@1",
          root: {
            type: "field",
            pointer: "/applicationId",
            widget: "autocomplete",
            dataSourceId: "missing-catalog",
          },
        },
      },
    },
  ];

  for (const { id, overrides } of cases) {
    assert.throws(
      () => operation(id, overrides),
      /shared protocol semantics/i,
      `expected ${id} to be rejected`,
    );
  }
});

test("defineOperation preserves detailed output schema profile diagnostics", () => {
  assert.throws(
    () => operation("agency.remote-output", {
      presets: [
        { id: "same", label: "First", input: {} },
        { id: "same", label: "Second", input: {} },
      ],
      output: {
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $ref: "https://example.invalid/output.schema.json",
        },
      },
    }),
    /non-fragment.*\$ref/i,
  );
});

test("defineOperation rejects secret schema references with multiple instance origins", () => {
  const sharedReference = { $ref: "#/$defs/secretValue" } as const;

  assert.throws(
    () => operation("agency.ambiguous-secret-reference", {
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          first: sharedReference,
          second: sharedReference,
        },
        $defs: { secretValue: { type: "string" } },
      },
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: "/$defs/secretValue",
          retention: "none",
        }],
      },
    }),
    /shared protocol semantics/i,
  );
});

test("defineOperation reports dynamic secret locations with a value-free diagnostic", () => {
  const sentinel = "sensitive-pattern-key-8391";
  assert.throws(
    () => operation("agency.dynamic-secret-location", {
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        patternProperties: { [`^${sentinel}$`]: { type: "string" } },
      },
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: `/patternProperties/^${sentinel}$`,
          retention: "none",
        }],
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /shared protocol semantics/i);
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

test("registry rejects unsafe IDs without replacing registered entries", () => {
  const registry = new OperationRegistry();
  registry.registerFeature(feature("agency"));
  registry.register(operation("agency.demote"));

  assert.throws(() => registry.registerFeature(feature("unsafe/feature")), /invalid feature id/i);
  assert.throws(() => registry.register(operation("unsafe/operation")), /invalid operation id/i);
  assert.equal(registry.require("agency.demote").definition.id, "agency.demote");
});

test("registry validates feature parents and returns stable ID-sorted arrays", () => {
  const registry = new OperationRegistry();
  assert.throws(
    () => registry.registerFeature({ id: "child", label: "Child", parentId: "missing" }),
    /unknown parent feature/i,
  );

  registry.registerFeature(feature("zeta"));
  registry.registerFeature(feature("alpha"));
  registry.register(operation("zeta.second"));
  registry.register(operation("alpha.first"));

  assert.deepEqual(registry.features().map(({ id }) => id), ["alpha", "zeta"]);
  assert.deepEqual(registry.operations().map(({ definition }) => definition.id), [
    "alpha.first",
    "zeta.second",
  ]);
});

test("registry rejects duplicate feature IDs without replacing the original", () => {
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "agency", label: "Original" });

  assert.throws(
    () => registry.registerFeature({ id: "agency", label: "Replacement" }),
    /duplicate feature id/i,
  );
  assert.equal(registry.features()[0]?.label, "Original");
});

test("definitions and features retain deeply frozen canonical content after source mutation", () => {
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { token: { type: "string" } },
  } as const;
  const contextSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { target: { type: "string" } },
  } as const;
  const rules = [{
    kind: "secret",
    schemaPointer: "/properties/token",
    retention: "none",
  }] as const;
  const execution = {
    impact: "read",
    confirmationRequired: false,
    dryRunSupported: false,
    idempotency: "optional",
    cancellationSupported: false,
  } as const;
  const tags = ["safe"];
  const presets = [{ id: "default", label: "Default", input: { target: "original" } }];
  const output = {
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { result: { type: "string" } },
    },
  } as const;
  const extensions = { "urn:test:meta": { nested: "original" } } as const;
  const draft: OperationDefinitionDraft = {
    id: "agency.deep",
    label: "Deep",
    featureId: "agency",
    order: 0,
    tags,
    inputSchema,
    contextSchema,
    inputHandling: { rules },
    dataSources: [],
    presets,
    execution,
    output,
    extensions,
  };

  const defined = defineOperation(draft, () => ({ output: {} }));
  (inputSchema.properties.token as { type: string }).type = "number";
  (contextSchema.properties.target as { type: string }).type = "number";
  (rules as unknown as { schemaPointer: string }[])[0]!.schemaPointer = "/properties/changed";
  (execution as { dryRunSupported: boolean }).dryRunSupported = true;
  tags.push("mutated");
  presets[0]!.input.target = "mutated";
  (output.schema.properties.result as { type: string }).type = "number";
  (extensions["urn:test:meta"] as { nested: string }).nested = "mutated";

  assert.equal(defined.definition.inputSchema.properties?.token?.type, "string");
  assert.equal(defined.definition.contextSchema?.properties?.target?.type, "string");
  assert.equal(defined.definition.inputHandling?.rules[0]?.schemaPointer, "/properties/token");
  assert.equal(defined.definition.execution.dryRunSupported, false);
  assert.deepEqual(defined.definition.tags, ["safe"]);
  assert.equal(defined.definition.presets[0]?.input.target, "original");
  assert.equal(defined.definition.output.schema.properties?.result?.type, "string");
  assert.deepEqual(defined.definition.extensions?.["urn:test:meta"], { nested: "original" });
  assert.equal(computeRevision(defined.definition as unknown as JsonObject), defined.definition.revision);
  assert.equal(Object.isFrozen(defined.definition.inputSchema.properties?.token), true);
  assert.equal(Object.isFrozen(defined.definition.inputHandling?.rules), true);
  assert.equal(Object.isFrozen(defined.definition.execution), true);

  const featureExtensions = { "urn:test:meta": { nested: "feature-original" } } as const;
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "agency", label: "Agency", extensions: featureExtensions });
  (featureExtensions["urn:test:meta"] as { nested: string }).nested = "feature-mutated";
  assert.deepEqual(registry.features()[0]?.extensions?.["urn:test:meta"], { nested: "feature-original" });
  assert.equal(Object.isFrozen(registry.features()[0]?.extensions?.["urn:test:meta"]), true);
});

test("registry rejects a hand-built stale operation without changing prior entries", () => {
  const registry = new OperationRegistry();
  registry.registerFeature(feature("agency"));
  const original = operation("agency.original");
  registry.register(original);
  const forged = {
    definition: {
      ...original.definition,
      id: "agency.forged",
      revision: original.definition.revision,
    },
    handler: original.handler,
  } as RegisteredOperation;

  assert.throws(() => registry.register(forged), /defineOperation|revision integrity/i);
  assert.deepEqual(registry.operations().map(({ definition }) => definition.id), ["agency.original"]);
});
