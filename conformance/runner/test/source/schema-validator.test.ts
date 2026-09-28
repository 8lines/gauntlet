import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  computeRevision,
  type AdapterManifest,
  type DataSourceResolveRequest,
  type JsonObject,
  type OperationDefinition,
} from "@8lines/gauntlet-protocol";
import {
  assertCanonicalJson,
  assertEndpointDocument,
  compileDeclaredSchema,
  validateManifest,
  validateOperation,
  validateResolve,
} from "../../src/schema-validator.js";

const fixtureRoot = new URL("../../../../packages/protocol/fixtures/v1/", import.meta.url);

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8")) as T;
}

test("every P0 endpoint validator accepts its canonical fixture", async () => {
  const cases = [
    ["health", "health.valid.json"],
    ["manifest", "manifest.valid.json"],
    ["operation", "operation.valid.json"],
    ["createRunRequest", "create-run-request.valid.json"],
    ["run", "run.succeeded.valid.json"],
    ["dataSourceQuery", "data-source-query.valid.json"],
    ["dataSourcePage", "data-source-page.valid.json"],
    ["dataSourceResolveRequest", "data-source-resolve-request.valid.json"],
    ["dataSourceResolveResponse", "data-source-resolve-response.valid.json"],
    ["sessionLaunch", "session-launch.valid.json"],
    ["problem", "problem.valid.json"],
  ] as const;
  for (const [endpoint, file] of cases) {
    assert.throws(() => assertEndpointDocument(endpoint, undefined));
    assert.throws(() => assertEndpointDocument(endpoint, null));
    const value = await fixture<unknown>(file);
    assert.equal(assertEndpointDocument(endpoint, value), value);
  }
});

test("endpoint schema failures name the canonical schema and a normalized leaf pointer", async () => {
  const problem = await fixture<Record<string, unknown>>("problem.valid.json");
  delete problem.status;
  assert.throws(
    () => assertEndpointDocument("problem", problem),
    /https:\/\/schemas\.8lines\.dev\/gauntlet\/v1\/problem\.schema\.json.*\/status/,
  );

  const failed = await fixture<Record<string, unknown>>("run.failed.valid.json");
  delete failed.problem;
  assert.throws(
    () => assertEndpointDocument("run", failed),
    /https:\/\/schemas\.8lines\.dev\/gauntlet\/v1\/run\.schema\.json.*\/problem/,
  );
});

test("canonical scalar and ownership checks run before Ajv", () => {
  const vectors: unknown[] = [
    { status: "wrong", value: "\ud800" },
    JSON.parse('{"status":"wrong","\\udc00":"x"}') as unknown,
  ];
  for (const value of vectors) {
    assert.throws(
      () => assertEndpointDocument("problem", value),
      (error: unknown) => {
        assert.equal((error as Error).message, "Response is not canonical JSON");
        assert.doesNotMatch((error as Error).message, /status|surrogate|\\u/);
        return true;
      },
    );
  }

  assert.doesNotThrow(() => assertCanonicalJson({ supplementary: "🚀" }, "Request is not canonical JSON"));
});

test("manifest and operation endpoint envelopes precede their accepted public semantic predicates", async () => {
  const manifest = await fixture<AdapterManifest>("manifest.valid.json");
  const operation = await fixture<OperationDefinition>("operation.valid.json");
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(validateOperation(operation), operation);

  const duplicateManifest = structuredClone(manifest) as unknown as Record<string, unknown>;
  duplicateManifest.operations = [
    ...(duplicateManifest.operations as readonly unknown[]),
    structuredClone((duplicateManifest.operations as readonly unknown[])[0]),
  ];
  duplicateManifest.manifestRevision = computeRevision(duplicateManifest as JsonObject, "manifestRevision");
  assert.throws(() => validateManifest(duplicateManifest), /manifest semantics/i);

  const unsupportedPattern = structuredClone(operation) as unknown as Record<string, unknown>;
  const inputSchema = unsupportedPattern.inputSchema as Record<string, unknown>;
  inputSchema.patternProperties = { "(?=unsafe)": { type: "string" } };
  unsupportedPattern.revision = computeRevision(unsupportedPattern as JsonObject);
  assert.throws(() => validateOperation(unsupportedPattern), /operation semantics/i);
});

test("resolve envelope validation precedes shared exact order and item identity semantics", async () => {
  const request = await fixture<DataSourceResolveRequest>("data-source-resolve-request.valid.json");
  const response = await fixture<Record<string, unknown>>("data-source-resolve-response.valid.json");
  assert.equal(validateResolve(request, response), response);

  const reversed = structuredClone(response);
  reversed.results = [...(reversed.results as readonly unknown[])].reverse();
  assert.throws(() => validateResolve(request, reversed), /resolve semantics/i);
});

test("declared data-source schemas consume raw pointer maps and complete contexts", async () => {
  const manifest = await fixture<AdapterManifest>("manifest.valid.json");
  const query = await fixture<Record<string, unknown>>("data-source-query.valid.json");
  const resolve = await fixture<Record<string, unknown>>("data-source-resolve-request.valid.json");
  const source = manifest.dataSources.find(({ id }) => id === "application-catalog");
  assert.ok(source?.dependencySchema);
  assert.ok(source.contextSchema);

  const dependencies = compileDeclaredSchema(source.dependencySchema, "dependency");
  const context = compileDeclaredSchema(source.contextSchema, "context");
  for (const request of [query, resolve]) {
    assert.doesNotThrow(() => dependencies(request.dependencies));
    assert.doesNotThrow(() => context(request.context));
  }
  assert.throws(() => dependencies({ includeInactive: false }), /declared dependency schema/i);
  assert.throws(() => context({ requestId: "request-only" }), /declared context schema/i);
});

test("candidate scalar validation precedes adapter-supplied pattern evaluation", () => {
  const declared = compileDeclaredSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      value: { type: "string", pattern: "^[A-Z]+$" },
      supplementary: { type: "string" },
    },
    additionalProperties: false,
  }, "context");
  assert.doesNotThrow(() => declared({ value: "ROCKET", supplementary: "🚀" }));
  assert.throws(
    () => declared({ value: "\ud800" }),
    (error: unknown) => (error as Error).message === "Declared schema candidate is not canonical JSON",
  );
});
