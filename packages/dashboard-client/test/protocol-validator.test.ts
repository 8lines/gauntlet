import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeRevision,
  type AdapterManifest,
  type JsonObject,
  type OperationDefinition,
  type Run,
} from "@8lines/gauntlet-protocol";
import invalidSchemaProfileDocument from "@8lines/gauntlet-protocol/fixtures/v1/operation.invalid-schema-profile.json" with { type: "json" };
import succeededRunDocument from "@8lines/gauntlet-protocol/fixtures/v1/run.succeeded.valid.json" with { type: "json" };
import {
  canonicalRunIsValid,
  createAdapterClient,
  operationActionInputIsValid,
  operationRunIsValid,
  validateCreateRunRequest,
} from "../src/index.js";
import {
  jsonResponse,
  target,
  validDataSourcePage,
  validHealth,
  validCreateRunRequest,
  validManifest,
  validMinorForwardManifest,
  validOperation,
  validResolveRequest,
  validResolveResponse,
  validRun,
  validSessionLaunch,
} from "./support/fixtures.js";

const invalidResponseProblem = {
  type: "urn:gauntlet:problem:adapter-invalid-response",
  title: "Invalid adapter response",
  status: 502,
} as const;

function changedManifest(change: (manifest: Record<string, any>) => void): AdapterManifest {
  const manifest = structuredClone(validMinorForwardManifest) as unknown as Record<string, any>;
  change(manifest);
  manifest.manifestRevision = computeRevision(manifest as JsonObject, "manifestRevision");
  return manifest as unknown as AdapterManifest;
}

function clientReturningManifest(manifest: AdapterManifest) {
  return createAdapterClient({ fetch: async () => jsonResponse(manifest) });
}

test("owns a revision-bound confirmation acknowledgement", () => {
  const source = structuredClone(validCreateRunRequest);
  const result = validateCreateRunRequest(source);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(JSON.parse(JSON.stringify(result.value.confirmation)), {
    operationId: validOperation.id,
    operationRevision: validOperation.revision,
    impact: validOperation.execution.impact,
  });
  assert.notEqual(result.value.confirmation, source.confirmation);
});

test("rejects a schema-valid manifest with a production-like name", async () => {
  const manifest = structuredClone(validManifest) as unknown as Record<string, any>;
  manifest.application.environment.name = "client-prod";
  manifest.manifestRevision = computeRevision(manifest as JsonObject, "manifestRevision");
  const result = await clientReturningManifest(manifest as AdapterManifest).getManifest(target);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
});

test("a future 1.x manifest with an unknown optional extension remains valid", async () => {
  const client = createAdapterClient({ fetch: async () => Response.json(validMinorForwardManifest) });
  const result = await client.getManifest(target);
  assert.equal(result.ok, true);
});

test("an unavailable summary keeps unmet requirements and an omitted-operation diagnostic", async () => {
  const manifest = changedManifest((document) => {
    document.profiles = document.profiles.filter(
      (profile: string) => profile !== "tc-rich-results@1",
    );
    document.capabilities = document.capabilities.filter(
      (capability: string) => capability !== "tc-session-launch@1",
    );
    document.operations[0].availability = {
      state: "unavailable",
      problem: {
        type: "urn:gauntlet:problem:unsupported-capability",
        title: "Operation requirements are unavailable",
        status: 501,
      },
    };
    document.diagnostics = [{
      severity: "error",
      code: "invalid-operation-binding",
      message: "The operation binding is invalid.",
      operationId: "omitted-operation",
    }];
  });
  const client = createAdapterClient({ fetch: async () => jsonResponse(manifest) });

  const result = await client.getManifest(target);

  assert.equal(result.ok, true);
  if (result.ok && !result.value.notModified) {
    assert.deepEqual(result.value.manifest.operations[0]?.requirements, {
      profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
      capabilities: ["tc-uploads@1", "tc-session-launch@1"],
    });
    assert.equal(result.value.manifest.diagnostics?.[0]?.operationId, "omitted-operation");
  }
});

test("a malformed unavailable Problem remains a fixed safe 502", async () => {
  const manifest = changedManifest((document) => {
    document.operations[0].availability = {
      state: "unavailable",
      problem: {
        type: "urn:gauntlet:problem:unsupported-capability",
        title: "Operation requirements are unavailable",
        status: 501,
        stack: "adapter-internal-secret",
      },
    };
  });
  const client = createAdapterClient({ fetch: async () => jsonResponse(manifest) });

  const result = await client.getManifest(target);

  assert.deepEqual(result, { ok: false, problem: invalidResponseProblem });
  assert.equal(JSON.stringify(result).includes("adapter-internal-secret"), false);
});

test("each response is validated only against its endpoint-specific canonical schema", async () => {
  const wrongDocuments = [
    ["health", validRun],
    ["manifest", validHealth],
    ["operation", validDataSourcePage],
    ["run", validOperation],
    ["page", validResolveResponse],
    ["resolve", validDataSourcePage],
    ["launch", validRun],
  ] as const;

  for (const [endpoint, document] of wrongDocuments) {
    const client = createAdapterClient({ fetch: async () => jsonResponse(document) });
    const result = endpoint === "health" ? await client.health(target)
      : endpoint === "manifest" ? await client.getManifest(target)
      : endpoint === "operation" ? await client.getOperation(target, validOperation.id)
      : endpoint === "run" ? await client.getRun(target, validRun.id)
      : endpoint === "page" ? await client.queryDataSource(target, "application-catalog", {})
      : endpoint === "resolve" ? await client.resolveDataSource(target, "application-catalog", validResolveRequest)
      : await client.createSessionLaunch(target, validRun.id, "launch-1");
    assert.equal(result.ok, false, `${endpoint} accepted a different endpoint document`);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("schema-profile-invalid operation semantics map to the fixed safe 502", async () => {
  const operation = invalidSchemaProfileDocument as unknown as OperationDefinition;
  const client = createAdapterClient({ fetch: async () => jsonResponse(operation) });
  const result = await client.getOperation(target, operation.id);

  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
});

test("secret-bearing preset semantics map to the fixed safe 502", async () => {
  const operation = structuredClone(validOperation) as unknown as {
    revision: string;
    presets: { input: Record<string, unknown> }[];
  };
  operation.presets[0]!.input.apiToken = "adapter-supplied-secret";
  operation.revision = computeRevision(operation as unknown as JsonObject);
  const client = createAdapterClient({ fetch: async () => jsonResponse(operation) });

  const result = await client.getOperation(target, validOperation.id);

  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
});

test("stale manifest and operation revisions map to the fixed safe 502", async () => {
  const staleManifest = {
    ...validMinorForwardManifest,
    application: { ...validMinorForwardManifest.application, label: "Changed" },
  };
  const staleOperation = { ...validOperation, label: "Changed" };
  const results = [
    await createAdapterClient({ fetch: async () => jsonResponse(staleManifest) }).getManifest(target),
    await createAdapterClient({ fetch: async () => jsonResponse(staleOperation) })
      .getOperation(target, staleOperation.id),
  ];

  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("endpoint identity mismatches are invalid even when the document schema is valid", async () => {
  const operation = { ...validOperation, id: "different-operation", revision: validOperation.revision };
  operation.revision = computeRevision(operation as unknown as JsonObject);
  const runForWrongOperation = { ...validRun, operationId: "different-operation" };
  const runWithWrongId = { ...validRun, id: "different-run" };
  const results = [
    await createAdapterClient({ fetch: async () => jsonResponse(operation) })
      .getOperation(target, validOperation.id),
    await createAdapterClient({ fetch: async () => jsonResponse(runForWrongOperation, 201) })
      .createRun(target, validOperation.id, {
        operationRevision: validOperation.revision,
        input: {},
      }),
    await createAdapterClient({ fetch: async () => jsonResponse(runWithWrongId) })
      .getRun(target, validRun.id),
  ];

  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("invalid resolve semantics map to the fixed safe 502", async () => {
  const invalidResponses = [
    { results: validResolveResponse.results.slice(0, 1) },
    { results: [...validResolveResponse.results].reverse() },
    {
      results: validResolveResponse.results.map((result, index) => index === 0
        ? {
            value: result.value,
            item: result.item === null ? null : { ...result.item, value: "other" },
          }
        : result),
    },
  ];

  for (const response of invalidResponses) {
    const client = createAdapterClient({ fetch: async () => jsonResponse(response) });
    const result = await client.resolveDataSource(
      target,
      "application-catalog",
      validResolveRequest,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("valid endpoint fixtures survive schema and shared semantic validation", async () => {
  const responses = [
    jsonResponse(validHealth),
    jsonResponse(validOperation, 200, { etag: `"${validOperation.revision}"` }),
    jsonResponse(validRun),
    jsonResponse(validDataSourcePage),
    jsonResponse(validResolveResponse),
    jsonResponse(validSessionLaunch, 201),
  ];
  const client = createAdapterClient({ fetch: async () => responses.shift()! });
  const results = [
    await client.health(target),
    await client.getOperation(target, validOperation.id),
    await client.getRun(target, validRun.id),
    await client.queryDataSource(target, "application-catalog", {}),
    await client.resolveDataSource(target, "application-catalog", validResolveRequest),
    await client.createSessionLaunch(target, validRun.id, "launch-1"),
  ];
  assert.equal(results.every((result) => result.ok), true);
});

test("operation Run validation applies identity, manifest references, and the declared output schema", () => {
  const run = succeededRunDocument as unknown as Run;
  assert.equal(operationRunIsValid(run, validOperation, validMinorForwardManifest), true);
  assert.equal(operationRunIsValid(
    { ...run, output: { reviewed: "twelve", notified: true } } as Run,
    validOperation,
    validMinorForwardManifest,
  ), false);
  assert.equal(operationRunIsValid(
    {
      ...run,
      actions: [{ kind: "invoke-operation", label: "Unknown", operationId: "unknown-operation" }],
    } as Run,
    validOperation,
    validMinorForwardManifest,
  ), false);
});

test("follow-up input validation applies the target schema plus secret and portable file rules", () => {
  const operation = structuredClone(validOperation) as OperationDefinition;
  const mutable = operation as unknown as JsonObject & { revision: string };
  const fileSchema = structuredClone(
    (validOperation.inputSchema.properties as Record<string, unknown>).attachment,
  );
  mutable.inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["publicValue"],
    properties: {
      publicValue: { type: "string", minLength: 1 },
      secret: { type: "string" },
      attachment: fileSchema,
    },
    additionalProperties: false,
  };
  mutable.inputHandling = {
    rules: [
      { kind: "secret", schemaPointer: "/properties/secret", retention: "none" },
      {
        kind: "file",
        schemaPointer: "/properties/attachment",
        multiple: false,
        mediaTypes: ["text/plain"],
        maxBytes: 10,
      },
    ],
  };
  mutable.presets = [];
  mutable.dataSources = [];
  delete mutable.uiSchema;
  mutable.revision = computeRevision(mutable);

  const now = new Date("2026-08-29T12:00:00Z");
  const file = {
    kind: "file",
    uploadId: "upload-1",
    name: "fixture.txt",
    mediaType: "text/plain",
    sizeBytes: 10,
    expiresAt: "2026-08-29T12:01:00Z",
  } as const;
  assert.equal(operationActionInputIsValid(undefined, operation, now), false);
  assert.equal(operationActionInputIsValid({ publicValue: "ok" }, operation, now), true);
  assert.equal(operationActionInputIsValid({ publicValue: "ok", secret: "must-not-leave-adapter" }, operation, now), false);
  assert.equal(operationActionInputIsValid({ publicValue: "ok", attachment: file }, operation, now), true);
  assert.equal(operationActionInputIsValid({
    publicValue: "ok",
    attachment: { ...file, expiresAt: "2026-08-29T12:00:00Z" },
  }, operation, now), false);
  assert.equal(operationActionInputIsValid({
    publicValue: "ok",
    attachment: { ...file, mediaType: "application/pdf" },
  }, operation, now), false);
  assert.equal(operationActionInputIsValid({
    publicValue: "ok",
    attachment: { ...file, sizeBytes: 11 },
  }, operation, now), false);
});

test("canonical Run validation is a fail-closed public preflight for untrusted store values", () => {
  assert.equal(canonicalRunIsValid(validRun), true);
  assert.equal(canonicalRunIsValid(null), false);
  assert.equal(canonicalRunIsValid({ ...validRun, id: "foreign!run" }), false);
  assert.equal(canonicalRunIsValid({ ...validRun, updatedAt: "2026-08-29T11:59:59Z" }), false);
});
