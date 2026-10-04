import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdapterClient } from "@8lines/gauntlet-dashboard-client";
import {
  computeRevision,
  type AdapterManifest,
  type JsonObject,
  type OperationDefinition,
  type Run,
  type RunEvent,
} from "@8lines/gauntlet-protocol";
import { createInMemoryGauntletStore } from "../src/in-memory-gauntlet-store.js";
import { createManifestService } from "../src/manifest-service.js";
import { createRunProxyService } from "../src/run-proxy-service.js";
import { createStaticTargetProvider, type StaticTargetConfig } from "../src/static-target-provider.js";
import { createTargetRegistry } from "../src/target-registry.js";
import type { GauntletStore } from "../src/gauntlet-store.js";
import {
  createFakeAdapter,
  createHappyManifest,
  createHappyOperation,
  createQueuedRun,
  fakeTarget,
  validCreateRunRequest,
} from "./support/fake-adapter.js";

function harness(options: {
  readonly targets?: readonly StaticTargetConfig[];
  readonly fake?: ReturnType<typeof createFakeAdapter>;
  readonly store?: GauntletStore;
} = {}) {
  const targets = options.targets ?? [fakeTarget];
  const fake = options.fake ?? createFakeAdapter();
  const registry = createTargetRegistry([createStaticTargetProvider(targets)]);
  const store = options.store ?? createInMemoryGauntletStore();
  const client = createAdapterClient({ fetch: fake.fetch });
  const manifests = createManifestService({
    registry,
    client,
    store,
    clock: () => new Date("2026-08-29T12:00:00Z"),
  });
  const runs = createRunProxyService({
    registry,
    client,
    manifests,
    store,
    clock: () => new Date("2026-08-29T12:00:00Z"),
  });
  return { fake, registry, store, client, manifests, runs };
}

function hostileRunStore(candidate: unknown): GauntletStore {
  const backing = createInMemoryGauntletStore();
  return {
    getSnapshot: (targetId) => backing.getSnapshot(targetId),
    saveSnapshot: (snapshot) => backing.saveSnapshot(snapshot),
    getRun: () => candidate as Run,
    saveRun: () => undefined,
  };
}

function countCalls(fake: ReturnType<typeof createFakeAdapter>, suffix: string, method?: string): number {
  return fake.calls.filter((call) => call.pathname.endsWith(suffix) && (method === undefined || call.method === method)).length;
}

function mutateManifest(
  operation: OperationDefinition,
  change: (manifest: AdapterManifest & JsonObject) => void,
): AdapterManifest {
  const manifest = createHappyManifest(operation) as AdapterManifest & JsonObject;
  change(manifest);
  (manifest as unknown as { manifestRevision: string }).manifestRevision = computeRevision(manifest, "manifestRevision");
  return manifest;
}

function runWith(base: Run, changes: Partial<Run>): Run {
  return { ...structuredClone(base), ...changes } as Run;
}

function withoutConfirmation(): Record<string, unknown> {
  const request = structuredClone(validCreateRunRequest) as unknown as Record<string, unknown>;
  delete request.confirmation;
  return request;
}

function createFollowUpTargetOperation(): OperationDefinition {
  const operation = structuredClone(createHappyOperation()) as OperationDefinition;
  const mutable = operation as unknown as JsonObject & { revision: string };
  const fileSchema = structuredClone(
    (operation.inputSchema.properties as Record<string, unknown>).attachment,
  );
  mutable.id = "applications.follow-up";
  mutable.label = "Follow up";
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
  return operation;
}

function manifestWithFollowUp(
  source: OperationDefinition,
  target: OperationDefinition,
): AdapterManifest {
  return mutateManifest(source, (manifest) => {
    (manifest as unknown as { operations: Array<Record<string, unknown>> }).operations.push({
      id: target.id,
      revision: target.revision,
      label: target.label,
      featureId: target.featureId,
      availability: { state: "available" },
      ...(target.requirements === undefined
        ? {}
        : { requirements: structuredClone(target.requirements) }),
    });
  });
}

function targetOperationResponse(
  target: OperationDefinition,
): (call: { readonly method: string; readonly pathname: string }) => Response | undefined {
  return (call) => call.method === "GET"
      && call.pathname === `/_gauntlet/v1/operations/${target.id}`
    ? Response.json(target, { headers: { etag: `"${target.revision}"` } })
    : undefined;
}

test("create resolves and cross-checks the operation before storing the adapter-owned run", async () => {
  const { runs, store } = harness();
  const result = await runs.create(fakeTarget.id, createHappyOperation().id, validCreateRunRequest);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.state, "queued");
    assert.deepEqual(store.getRun(fakeTarget.id, result.value.id), result.value);
    assert.equal(Object.isFrozen(result.value), true);
  }
});

test("create rejects a Run whose output or follow-up operation violates its resolved definition", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const invalidRuns = [
    runWith(queued, {
      sequence: 1,
      state: "succeeded",
      updatedAt: "2026-08-29T12:00:01Z",
      completedAt: "2026-08-29T12:00:01Z",
      output: { reviewed: "not-an-integer", notified: true },
    }),
    runWith(queued, {
      actions: [{ kind: "invoke-operation", label: "Unknown", operationId: "unknown-operation" }],
    }),
  ];

  for (const createdRun of invalidRuns) {
    const fake = createFakeAdapter({ operation, createdRun });
    const { runs, store } = harness({ fake });
    const result = await runs.create(fakeTarget.id, operation.id, validCreateRunRequest);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
    assert.equal(store.getRun(fakeTarget.id, createdRun.id), undefined);
  }
});

test("create resolves follow-up definitions and rejects schema, secret, and file violations", async () => {
  const source = createHappyOperation();
  const target = createFollowUpTargetOperation();
  const manifest = manifestWithFollowUp(source, target);
  const base = createQueuedRun(source);
  const file = {
    kind: "file",
    uploadId: "upload-1",
    name: "fixture.txt",
    mediaType: "text/plain",
    sizeBytes: 10,
    expiresAt: "2026-08-29T12:01:00Z",
  } as const;
  const candidates: ReadonlyArray<{ readonly input?: JsonObject; readonly valid: boolean }> = [
    { input: { publicValue: "ok" }, valid: true },
    { valid: false },
    { input: { publicValue: "ok", secret: "must-not-leave-adapter" }, valid: false },
    {
      input: {
        publicValue: "ok",
        attachment: { ...file, expiresAt: "2026-08-29T12:00:00Z" },
      },
      valid: false,
    },
  ];

  for (const candidate of candidates) {
    const action = {
      kind: "invoke-operation" as const,
      label: "Continue",
      operationId: target.id,
      ...(candidate.input === undefined ? {} : { input: candidate.input }),
    };
    const createdRun = runWith(base, { actions: [action] });
    const fake = createFakeAdapter({
      manifest,
      operation: source,
      createdRun,
      responseFor: targetOperationResponse(target),
    });
    const { runs, store } = harness({ fake });

    const result = await runs.create(fakeTarget.id, source.id, validCreateRunRequest);

    assert.equal(result.ok, candidate.valid);
    if (!result.ok) assert.equal(result.problem.status, 502);
    assert.equal(store.getRun(fakeTarget.id, createdRun.id) !== undefined, candidate.valid);
    assert.equal(countCalls(fake, `/operations/${target.id}`, "GET"), 1);
  }
});

test("poll, cancel, and SSE reject hostile follow-up inputs before persistence", async () => {
  const source = createHappyOperation();
  const target = createFollowUpTargetOperation();
  const manifest = manifestWithFollowUp(source, target);
  const queued = createQueuedRun(source);
  const hostileAction = {
    kind: "invoke-operation" as const,
    label: "Continue",
    operationId: target.id,
    input: { publicValue: "ok", secret: "must-not-leave-adapter" },
  };
  const running = runWith(queued, {
    sequence: 1,
    state: "running",
    startedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
    actions: [hostileAction],
  });
  const cancelled = runWith(queued, {
    sequence: 1,
    state: "cancelled",
    completedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
    problem: { type: "urn:gauntlet:problem:run-cancelled", title: "Run cancelled", status: 409 },
    actions: [hostileAction],
  });
  const responseFor = targetOperationResponse(target);

  const pollFake = createFakeAdapter({
    manifest,
    operation: source,
    createdRun: queued,
    polledRuns: [running],
    responseFor,
  });
  const poll = harness({ fake: pollFake });
  assert.equal((await poll.runs.create(fakeTarget.id, source.id, validCreateRunRequest)).ok, true);
  const polled = await poll.runs.get(fakeTarget.id, queued.id);
  assert.equal(polled.ok, false);
  if (!polled.ok) assert.equal(polled.problem.status, 502);
  assert.deepEqual(poll.store.getRun(fakeTarget.id, queued.id), queued);

  const cancelFake = createFakeAdapter({
    manifest,
    operation: source,
    createdRun: queued,
    cancelledRun: cancelled,
    responseFor,
  });
  const cancellation = harness({ fake: cancelFake });
  assert.equal((await cancellation.runs.create(fakeTarget.id, source.id, validCreateRunRequest)).ok, true);
  const cancelledResult = await cancellation.runs.cancel(fakeTarget.id, queued.id);
  assert.equal(cancelledResult.ok, false);
  if (!cancelledResult.ok) assert.equal(cancelledResult.problem.status, 502);
  assert.deepEqual(cancellation.store.getRun(fakeTarget.id, queued.id), queued);

  const event: RunEvent = {
    id: "event-1",
    sequence: running.sequence,
    occurredAt: running.updatedAt,
    type: "run.updated",
    run: running,
  };
  const sseFake = createFakeAdapter({
    manifest,
    operation: source,
    createdRun: queued,
    events: [event],
    responseFor,
  });
  const sse = harness({ fake: sseFake });
  assert.equal((await sse.runs.create(fakeTarget.id, source.id, validCreateRunRequest)).ok, true);
  const stream = await sse.runs.streamEvents(fakeTarget.id, queued.id);
  assert.equal(stream.ok, true);
  if (!stream.ok) return;
  await assert.rejects(async () => {
    for await (const ignored of stream.value) void ignored;
  }, /event stream failed/i);
  assert.deepEqual(sse.store.getRun(fakeTarget.id, queued.id), queued);
});

test("create validates the store winner after persistence before returning it", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const corrupt = runWith(queued, {
    sequence: 1,
    state: "succeeded",
    updatedAt: "2026-08-29T12:00:01Z",
    completedAt: "2026-08-29T12:00:01Z",
    output: { reviewed: "not-an-integer", notified: true },
  });
  const backing = createInMemoryGauntletStore();
  const store: GauntletStore = {
    getSnapshot: (targetId) => backing.getSnapshot(targetId),
    saveSnapshot: (snapshot) => backing.saveSnapshot(snapshot),
    getRun: (targetId, runId) => backing.getRun(targetId, runId),
    saveRun(targetId, _run) {
      backing.saveRun(targetId, corrupt);
    },
  };
  const fake = createFakeAdapter({ operation, createdRun: queued });
  const { runs } = harness({ fake, store });

  const result = await runs.create(fakeTarget.id, operation.id, validCreateRunRequest);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
  }
});

test("unsupported and unavailable summaries stop before definition and run fetch", async () => {
  const operation = createHappyOperation();
  const unsupportedManifest = mutateManifest(operation, (manifest) => {
    (manifest as unknown as { profiles: string[] }).profiles.push("urn:future-ui@1");
    (manifest as unknown as { operations: Array<{ requirements?: { profiles?: string[] } }> }).operations[0]!.requirements = {
      profiles: ["urn:future-ui@1"],
    };
  });
  const unsupportedFake = createFakeAdapter({ manifest: unsupportedManifest, operation });
  const unsupported = await harness({ fake: unsupportedFake }).runs.create(fakeTarget.id, operation.id, validCreateRunRequest);
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.problem.status, 501);
  assert.equal(countCalls(unsupportedFake, `/operations/${operation.id}`), 0);
  assert.equal(countCalls(unsupportedFake, "/runs", "POST"), 0);

  const unavailableManifest = mutateManifest(operation, (manifest) => {
    (manifest as unknown as { operations: Array<{ availability: unknown }> }).operations[0]!.availability = {
      state: "unavailable",
      problem: { type: "urn:gauntlet:problem:adapter-disabled", title: "Unavailable", status: 503 },
    };
  });
  const unavailableFake = createFakeAdapter({ manifest: unavailableManifest, operation });
  const unavailable = await harness({ fake: unavailableFake }).runs.resolveOperation(fakeTarget.id, operation.id);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.problem.status, 503);
  assert.equal(countCalls(unavailableFake, `/operations/${operation.id}`), 0);
});

test("unsafe unavailable summary status is replaced by a fixed invalid-response problem", async () => {
  const operation = createHappyOperation();
  const manifest = mutateManifest(operation, (document) => {
    (document as unknown as { operations: Array<{ availability: unknown }> }).operations[0]!.availability = {
      state: "unavailable",
      problem: { type: "urn:gauntlet:problem:adapter-disabled", title: "Unsafe", status: 200 },
    };
  });
  const fake = createFakeAdapter({ manifest, operation });
  const result = await harness({ fake }).runs.resolveOperation(fakeTarget.id, operation.id);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.problem.status, 502);
    assert.equal(result.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
  }
  assert.equal(countCalls(fake, `/operations/${operation.id}`), 0);
});

test("summary-definition identity and canonical requirements mismatches block invocation", async () => {
  const operation = createHappyOperation();
  const cases: Array<{ operation: OperationDefinition; manifest: AdapterManifest }> = [];

  const labelMismatch = structuredClone(operation) as OperationDefinition;
  (labelMismatch as unknown as JsonObject & { label: string; revision: string }).label = "Different label";
  (labelMismatch as unknown as JsonObject & { revision: string }).revision = computeRevision(labelMismatch as unknown as JsonObject);
  cases.push({
    operation: labelMismatch,
    manifest: mutateManifest(labelMismatch, (manifest) => {
      (manifest as unknown as { operations: Array<{ label: string }> }).operations[0]!.label = operation.label;
    }),
  });

  const requirementsMismatch = structuredClone(operation) as OperationDefinition;
  const mutableRequirements = requirementsMismatch as unknown as JsonObject & {
    requirements: { profiles: string[]; capabilities: string[] };
    revision: string;
  };
  mutableRequirements.requirements.profiles = [...mutableRequirements.requirements.profiles].reverse();
  mutableRequirements.revision = computeRevision(mutableRequirements);
  cases.push({
    operation: requirementsMismatch,
    manifest: mutateManifest(requirementsMismatch, (manifest) => {
      (manifest as unknown as { operations: Array<{ requirements: unknown }> }).operations[0]!.requirements = operation.requirements;
      (manifest as unknown as { operations: Array<{ revision: string }> }).operations[0]!.revision = requirementsMismatch.revision;
    }),
  });

  for (const entry of cases) {
    const fake = createFakeAdapter({ manifest: entry.manifest, operation: entry.operation });
    const result = await harness({ fake }).runs.create(fakeTarget.id, entry.operation.id, {
      ...validCreateRunRequest,
      operationRevision: entry.operation.revision,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, 502);
    assert.equal(countCalls(fake, "/runs", "POST"), 0);
  }
});

test("undeclared definition requirements and data sources block invocation", async () => {
  const base = createHappyOperation();
  const unknownRequirement = structuredClone(base) as OperationDefinition;
  const req = unknownRequirement as unknown as JsonObject & {
    requirements: { profiles: string[]; capabilities: string[] };
    revision: string;
  };
  req.requirements.profiles.push("urn:undeclared@1");
  req.revision = computeRevision(req);

  const unknownDataSource = structuredClone(base) as OperationDefinition;
  const ds = unknownDataSource as unknown as JsonObject & {
    dataSources: Array<Record<string, unknown>>;
    revision: string;
  };
  ds.dataSources.push({ id: "undeclared-source", inputPointer: "/message", dependencyPointers: [] });
  ds.revision = computeRevision(ds);

  for (const operation of [unknownRequirement, unknownDataSource]) {
    const manifest = mutateManifest(operation, () => undefined);
    const fake = createFakeAdapter({ manifest, operation });
    const result = await harness({ fake }).runs.resolveOperation(fakeTarget.id, operation.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, 502);
  }
});

test("stale revision and mismatched context target are rejected before create-run fetch", async () => {
  for (const request of [
    { ...validCreateRunRequest, operationRevision: `sha256:${"f".repeat(64)}` as const },
    {
      ...validCreateRunRequest,
      context: { ...validCreateRunRequest.context!, target: { id: "other" } },
    },
  ]) {
    const fake = createFakeAdapter();
    const result = await harness({ fake }).runs.create(fakeTarget.id, createHappyOperation().id, request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, request.operationRevision === validCreateRunRequest.operationRevision ? 422 : 409);
    assert.equal(countCalls(fake, "/runs", "POST"), 0);
  }
});

test("required confirmation is revision-bound and rejected before create-run persistence", async (t) => {
  const operation = createHappyOperation();
  const validConfirmation = validCreateRunRequest.confirmation!;
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly request: unknown;
    readonly instancePath: string;
    readonly keyword: "required" | "const";
  }> = [
    {
      name: "missing",
      request: withoutConfirmation(),
      instancePath: "/confirmation",
      keyword: "required",
    },
    {
      name: "operation ID mismatch",
      request: {
        ...validCreateRunRequest,
        confirmation: { ...validConfirmation, operationId: "other-operation" },
      },
      instancePath: "/confirmation/operationId",
      keyword: "const",
    },
    {
      name: "operation revision mismatch",
      request: {
        ...validCreateRunRequest,
        confirmation: {
          ...validConfirmation,
          operationRevision: `sha256:${"0".repeat(64)}`,
        },
      },
      instancePath: "/confirmation/operationRevision",
      keyword: "const",
    },
    {
      name: "impact mismatch",
      request: {
        ...validCreateRunRequest,
        confirmation: { ...validConfirmation, impact: "read" },
      },
      instancePath: "/confirmation/impact",
      keyword: "const",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const backing = createInMemoryGauntletStore();
      let runSaves = 0;
      const store: GauntletStore = {
        getSnapshot: (targetId) => backing.getSnapshot(targetId),
        saveSnapshot: (snapshot) => backing.saveSnapshot(snapshot),
        getRun: (targetId, runId) => backing.getRun(targetId, runId),
        saveRun: (targetId, run) => {
          runSaves += 1;
          backing.saveRun(targetId, run);
        },
      };
      const fake = createFakeAdapter({ operation });
      const result = await harness({ fake, store }).runs.create(fakeTarget.id, operation.id, entry.request);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.deepEqual(result.problem, {
        type: "urn:gauntlet:problem:validation-failed",
        title: "Request validation failed",
        status: 422,
        errors: [{
          instancePath: entry.instancePath,
          schemaPath: "#",
          keyword: entry.keyword,
          message: entry.keyword === "required" ? "Required value is missing" : "Invalid value",
          params: {},
        }],
      });
      assert.equal(Object.isFrozen(result.problem), true);
      assert.equal(Object.isFrozen(result.problem.errors), true);
      assert.equal(Object.isFrozen(result.problem.errors?.[0]), true);
      assert.equal(Object.isFrozen(result.problem.errors?.[0]?.params), true);
      assert.equal(countCalls(fake, "/runs", "POST"), 0);
      assert.equal(runSaves, 0);
    });
  }
});

test("confirmation rejection is fresh, precedes context validation, and cannot be bypassed by dry-run", async () => {
  const operation = createHappyOperation();
  const invalidRequest = {
    ...withoutConfirmation(),
    dryRun: true,
    context: { ...validCreateRunRequest.context!, target: { id: "other" } },
  };
  const firstFake = createFakeAdapter({ operation });
  const first = await harness({ fake: firstFake }).runs.create(fakeTarget.id, operation.id, invalidRequest);
  const secondFake = createFakeAdapter({ operation });
  const second = await harness({ fake: secondFake }).runs.create(fakeTarget.id, operation.id, invalidRequest);

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  if (first.ok || second.ok) return;
  assert.equal(first.problem.errors?.[0]?.instancePath, "/confirmation");
  assert.equal(first.problem.errors?.[0]?.keyword, "required");
  assert.notEqual(first.problem, second.problem);
  assert.notEqual(first.problem.errors, second.problem.errors);
  assert.equal(countCalls(firstFake, "/runs", "POST"), 0);
  assert.equal(countCalls(secondFake, "/runs", "POST"), 0);
});

test("stale operation revision takes precedence over a missing confirmation", async () => {
  const fake = createFakeAdapter();
  const result = await harness({ fake }).runs.create(fakeTarget.id, createHappyOperation().id, {
    ...withoutConfirmation(),
    operationRevision: `sha256:${"f".repeat(64)}`,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.status, 409);
  assert.equal(countCalls(fake, "/runs", "POST"), 0);
});

test("target compatibility and operation resolution precede required confirmation", async () => {
  const missingTargetFake = createFakeAdapter();
  const missingTarget = await harness({ fake: missingTargetFake }).runs.create(
    "missing",
    createHappyOperation().id,
    withoutConfirmation(),
  );
  assert.equal(missingTarget.ok, false);
  if (!missingTarget.ok) assert.equal(missingTarget.problem.status, 404);
  assert.equal(missingTargetFake.calls.length, 0);

  const missingOperationFake = createFakeAdapter();
  const missingOperation = await harness({ fake: missingOperationFake }).runs.create(
    fakeTarget.id,
    "missing-operation",
    withoutConfirmation(),
  );
  assert.equal(missingOperation.ok, false);
  if (!missingOperation.ok) assert.equal(missingOperation.problem.status, 404);
  assert.equal(countCalls(missingOperationFake, "/runs", "POST"), 0);
});

test("operations that do not require confirmation accept its omission", async () => {
  const operation = structuredClone(createHappyOperation()) as OperationDefinition;
  const mutable = operation as unknown as JsonObject & {
    revision: string;
    execution: { confirmationRequired: boolean };
  };
  mutable.execution.confirmationRequired = false;
  mutable.revision = computeRevision(mutable);
  const manifest = createHappyManifest(operation);
  const createdRun = createQueuedRun(operation);
  const fake = createFakeAdapter({ operation, manifest, createdRun });
  const request = withoutConfirmation();
  request.operationRevision = operation.revision;

  const result = await harness({ fake }).runs.create(fakeTarget.id, operation.id, request);

  assert.equal(result.ok, true);
  assert.equal(countCalls(fake, "/runs", "POST"), 1);
});

test("valid confirmation and dry-run are forwarded unchanged", async () => {
  const fake = createFakeAdapter();
  const result = await harness({ fake }).runs.create(
    fakeTarget.id,
    createHappyOperation().id,
    validCreateRunRequest,
  );

  assert.equal(result.ok, true);
  const runCall = fake.calls.find(({ pathname, method }) => pathname.endsWith("/runs") && method === "POST");
  assert.deepEqual(runCall?.body, validCreateRunRequest);
  assert.equal((runCall?.body as { dryRun?: unknown } | undefined)?.dryRun, true);
  assert.deepEqual(
    (runCall?.body as { confirmation?: unknown } | undefined)?.confirmation,
    validCreateRunRequest.confirmation,
  );
});

test("noncanonical create request is rejected without invoking accessors or fetching a target", async () => {
  let getterCalls = 0;
  const request = structuredClone(validCreateRunRequest) as unknown as Record<string, unknown>;
  Object.defineProperty(request, "operationRevision", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return validCreateRunRequest.operationRevision;
    },
  });
  const fake = createFakeAdapter();

  const result = await harness({ fake }).runs.create(fakeTarget.id, createHappyOperation().id, request);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.status, 422);
  assert.equal(getterCalls, 0);
  assert.equal(fake.calls.length, 0);
});

test("create validation precedes stale and context checks for every invalid document", async () => {
  const staleRevision = `sha256:${"f".repeat(64)}` as const;
  const invalidDocuments: readonly unknown[] = [
    { ...validCreateRunRequest, operationRevision: "not-a-sha256-revision" },
    {
      operationRevision: staleRevision,
      context: validCreateRunRequest.context,
      dryRun: validCreateRunRequest.dryRun,
    },
  ];

  for (const document of invalidDocuments) {
    const fake = createFakeAdapter();
    const result = await harness({ fake }).runs.create(
      fakeTarget.id,
      createHappyOperation().id,
      document as typeof validCreateRunRequest,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.status, 422);
      assert.equal(result.problem.type, "urn:gauntlet:problem:validation-failed");
    }
    assert.equal(countCalls(fake, "/runs", "POST"), 0);
  }
});

test("polling accepts monotonic projections and keeps target-scoped run ownership", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const running = runWith(queued, {
    sequence: 1,
    state: "running",
    updatedAt: "2026-08-29T12:00:01Z",
    startedAt: "2026-08-29T12:00:01Z",
  });
  const secondTarget = { ...fakeTarget, id: "other", label: "Other", adapterUrl: "http://other.internal" };
  const fake = createFakeAdapter({ operation, createdRun: queued, polledRuns: [running] });
  const { runs, store } = harness({ targets: [fakeTarget, secondTarget], fake });
  assert.equal((await runs.create("acme", operation.id, validCreateRunRequest)).ok, true);
  const otherRequest = {
    ...validCreateRunRequest,
    context: { ...validCreateRunRequest.context!, target: { id: "other" } },
  };
  assert.equal((await runs.create("other", operation.id, otherRequest)).ok, true);
  const polled = await runs.get("acme", queued.id);
  assert.equal(polled.ok, true);
  if (polled.ok) assert.equal(polled.value.sequence, 1);
  assert.equal(store.getRun("other", queued.id)?.sequence, 0);
  assert.equal(store.getRun("acme", queued.id)?.sequence, 1);
});

test("polling resolves the operation contract and refuses invalid terminal output before persistence", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const invalidTerminal = runWith(queued, {
    sequence: 1,
    state: "succeeded",
    updatedAt: "2026-08-29T12:00:01Z",
    completedAt: "2026-08-29T12:00:01Z",
    output: { reviewed: false, notified: true },
  });
  const fake = createFakeAdapter({ operation, createdRun: queued, polledRuns: [invalidTerminal] });
  const { runs, store } = harness({ fake });
  assert.equal((await runs.create(fakeTarget.id, operation.id, validCreateRunRequest)).ok, true);

  const result = await runs.get(fakeTarget.id, queued.id);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
  assert.deepEqual(store.getRun(fakeTarget.id, queued.id), queued);
  assert.equal(countCalls(fake, `/operations/${operation.id}`), 2);
});

test("polling rejects a terminal state whose fixed Problem does not match", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const invalidCancelled = runWith(queued, {
    sequence: 1,
    state: "cancelled",
    updatedAt: "2026-08-29T12:00:01Z",
    completedAt: "2026-08-29T12:00:01Z",
    problem: {
      type: "urn:gauntlet:problem:handler-failed",
      title: "Operation failed",
      status: 500,
    },
  });
  const fake = createFakeAdapter({ operation, createdRun: queued, polledRuns: [invalidCancelled] });
  const { runs, store } = harness({ fake });
  assert.equal((await runs.create(fakeTarget.id, operation.id, validCreateRunRequest)).ok, true);

  const result = await runs.get(fakeTarget.id, queued.id);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
  assert.deepEqual(store.getRun(fakeTarget.id, queued.id), queued);
});

test("polling refuses a semantically corrupt stored Run before calling the adapter Run endpoint", async () => {
  const operation = createHappyOperation();
  const corrupt = runWith(createQueuedRun(operation), {
    sequence: 1,
    state: "succeeded",
    updatedAt: "2026-08-29T12:00:01Z",
    completedAt: "2026-08-29T12:00:01Z",
    output: { reviewed: "not-an-integer", notified: true },
  });
  const fake = createFakeAdapter({ operation });
  const { runs, store } = harness({ fake });
  store.saveRun(fakeTarget.id, corrupt);

  const result = await runs.get(fakeTarget.id, corrupt.id);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
  assert.equal(countCalls(fake, `/runs/${corrupt.id}`, "GET"), 0);
  assert.deepEqual(store.getRun(fakeTarget.id, corrupt.id), corrupt);
});

test("malformed and foreign store projections fail closed before Run or launch dispatch", async () => {
  const operation = createHappyOperation();
  const foreign = runWith(createQueuedRun(operation), { id: "run-foreign" });
  const invalidScalar = runWith(createQueuedRun(operation), {
    summary: { title: "\ud800", tone: "neutral" },
  });
  const negativeZero = runWith(createQueuedRun(operation), { sequence: -0 });

  for (const candidate of [null, foreign, invalidScalar, negativeZero]) {
    const getFake = createFakeAdapter({ operation });
    const getHarness = harness({ fake: getFake, store: hostileRunStore(candidate) });
    const getResult = await getHarness.runs.get(fakeTarget.id, "run-1");
    assert.equal(getResult.ok, false);
    if (!getResult.ok) {
      assert.equal(getResult.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
    }
    assert.equal(countCalls(getFake, "/runs/run-1", "GET"), 0);

    const launchFake = createFakeAdapter({ operation });
    const launchHarness = harness({ fake: launchFake, store: hostileRunStore(candidate) });
    const launchResult = await launchHarness.runs.createSessionLaunch(
      fakeTarget.id,
      "run-1",
      "launch-1",
    );
    assert.equal(launchResult.ok, false);
    if (!launchResult.ok) {
      assert.equal(launchResult.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
    }
    assert.equal(countCalls(launchFake, "/launch", "POST"), 0);
  }
});

test("out-of-order, conflicting, regressing, and terminal projections are rejected", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const cases: Array<{ created: Run; polled: Run }> = [
    {
      created: runWith(queued, { sequence: 2, updatedAt: "2026-08-29T12:00:02Z" }),
      polled: runWith(queued, { sequence: 1, updatedAt: "2026-08-29T12:00:01Z" }),
    },
    {
      created: queued,
      polled: runWith(queued, { summary: { title: "Changed", tone: "neutral" } }),
    },
    {
      created: runWith(queued, { sequence: 1, state: "running", startedAt: "2026-08-29T12:00:00Z" }),
      polled: runWith(queued, { sequence: 2, state: "queued", updatedAt: "2026-08-29T12:00:02Z" }),
    },
    {
      created: runWith(queued, { sequence: 1, updatedAt: "2026-08-29T12:00:02Z" }),
      polled: runWith(queued, { sequence: 2, state: "running", updatedAt: "2026-08-29T12:00:01Z" }),
    },
    {
      created: runWith(queued, {
        sequence: 1,
        state: "running",
        updatedAt: "2026-08-29T12:00:01Z",
        startedAt: "2026-08-29T12:00:00Z",
      }),
      polled: runWith(queued, {
        sequence: 2,
        state: "running",
        updatedAt: "2026-08-29T12:00:02Z",
        startedAt: "2026-08-29T12:00:01Z",
      }),
    },
    {
      created: runWith(queued, {
        sequence: 1,
        state: "running",
        updatedAt: "2026-08-29T12:00:02Z",
        progress: { current: 1, total: 2, updatedAt: "2026-08-29T12:00:01Z" },
      }),
      polled: runWith(queued, {
        sequence: 2,
        state: "running",
        updatedAt: "2026-08-29T12:00:03Z",
        progress: { current: 1, total: 2, updatedAt: "2026-08-29T12:00:00Z" },
      }),
    },
    {
      created: runWith(queued, {
        sequence: 2,
        state: "succeeded",
        updatedAt: "2026-08-29T12:00:02Z",
        completedAt: "2026-08-29T12:00:02Z",
      }),
      polled: runWith(queued, {
        sequence: 3,
        state: "succeeded",
        updatedAt: "2026-08-29T12:00:03Z",
        completedAt: "2026-08-29T12:00:03Z",
      }),
    },
  ];

  for (const { created, polled } of cases) {
    const fake = createFakeAdapter({ operation, createdRun: created, polledRuns: [polled] });
    const { runs, store } = harness({ fake });
    assert.equal((await runs.create(fakeTarget.id, operation.id, validCreateRunRequest)).ok, true);
    const result = await runs.get(fakeTarget.id, created.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, 502);
    assert.deepEqual(store.getRun(fakeTarget.id, created.id), created);
  }
});

test("an identical same-sequence projection is accepted without replacing owned state", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const fake = createFakeAdapter({ operation, createdRun: queued, polledRuns: [structuredClone(queued)] });
  const { runs, store } = harness({ fake });
  await runs.create(fakeTarget.id, operation.id, validCreateRunRequest);
  const result = await runs.get(fakeTarget.id, queued.id);
  assert.equal(result.ok, true);
  assert.deepEqual(store.getRun(fakeTarget.id, queued.id), queued);
});

test("terminal Run Problems are sanitized before create and poll projections are stored", async () => {
  const sentinelUrl = "https://adapter.internal/run-problem";
  const sentinelSecret = "run-super-secret";
  const operation = createHappyOperation();
  const failed = runWith(createQueuedRun(operation), {
    sequence: 1,
    state: "failed",
    updatedAt: "2026-08-29T12:00:01Z",
    completedAt: "2026-08-29T12:00:01Z",
    problem: {
      type: "urn:gauntlet:problem:handler-failed",
      title: sentinelSecret,
      status: 500,
      detail: sentinelUrl,
      instance: `${sentinelUrl}/instance`,
      errors: [{
        instancePath: sentinelUrl,
        schemaPath: `${sentinelUrl}#/${sentinelSecret}`,
        keyword: "handler",
        message: sentinelSecret,
        params: { secret: sentinelSecret },
      }],
    },
  });
  const fake = createFakeAdapter({ operation, createdRun: failed, polledRuns: [failed] });
  const { runs, store } = harness({ fake });

  const created = await runs.create(fakeTarget.id, operation.id, validCreateRunRequest);
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(JSON.stringify(created.value).includes(sentinelUrl), false);
    assert.equal(JSON.stringify(created.value).includes(sentinelSecret), false);
  }
  assert.equal(JSON.stringify(store.getRun(fakeTarget.id, failed.id)).includes(sentinelUrl), false);
  assert.equal(JSON.stringify(store.getRun(fakeTarget.id, failed.id)).includes(sentinelSecret), false);

  const polled = await runs.get(fakeTarget.id, failed.id);
  assert.equal(polled.ok, true);
  if (polled.ok) {
    assert.equal(JSON.stringify(polled.value).includes(sentinelUrl), false);
    assert.equal(JSON.stringify(polled.value).includes(sentinelSecret), false);
  }
  assert.equal(JSON.stringify(store.getRun(fakeTarget.id, failed.id)).includes(sentinelUrl), false);
  assert.equal(JSON.stringify(store.getRun(fakeTarget.id, failed.id)).includes(sentinelSecret), false);
});

test("unknown run and invalid launch artifacts fail locally without launch fetch", async () => {
  const missing = harness();
  const missingResult = await missing.runs.createSessionLaunch(fakeTarget.id, "missing", "launch-1");
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.equal(missingResult.problem.status, 404);
  assert.equal(countCalls(missing.fake, "/launch", "POST"), 0);

  const operation = createHappyOperation();
  const base = createQueuedRun(operation);
  const invalidRuns: ReadonlyArray<{ readonly run: Run; readonly expectedStatus: number }> = [
    { run: runWith(base, { artifacts: [] }), expectedStatus: 502 },
    {
      run: runWith(base, {
        artifacts: [{ id: "launch-1", kind: "notice", level: "info", message: "No" }],
      }),
      expectedStatus: 502,
    },
    {
      run: runWith(base, {
        artifacts: [
          { id: "launch-1", kind: "browser-launch", label: "One" },
          { id: "launch-1", kind: "browser-launch", label: "Two" },
        ],
      }),
      expectedStatus: 502,
    },
  ];
  for (const { run: createdRun, expectedStatus } of invalidRuns) {
    const fake = createFakeAdapter({ operation, createdRun });
    const { runs, store } = harness({ fake });
    store.saveRun(fakeTarget.id, createdRun);
    const result = await runs.createSessionLaunch(fakeTarget.id, createdRun.id, "launch-1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, expectedStatus);
    assert.equal(countCalls(fake, "/launch", "POST"), 0);
  }
});

test("launch requires configured public origin and an advertised capability", async () => {
  const noPublic = {
    id: "acme",
    label: "Acme",
    adapterUrl: "http://acme.internal",
    expectedEnvironment: fakeTarget.expectedEnvironment,
  };
  const fake = createFakeAdapter();
  const absentOrigin = harness({ targets: [noPublic], fake });
  await absentOrigin.runs.create("acme", createHappyOperation().id, validCreateRunRequest);
  const result = await absentOrigin.runs.createSessionLaunch("acme", "run-1", "launch-1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.status, 409);
  assert.equal(countCalls(fake, "/launch", "POST"), 0);

  const operation = createHappyOperation();
  const manifest = mutateManifest(operation, (document) => {
    (document as unknown as { capabilities: string[] }).capabilities = [];
    (document as unknown as { operations: Array<{ requirements?: { capabilities?: string[] } }> }).operations[0]!.requirements = {
      profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    };
  });
  const noCapabilityFake = createFakeAdapter({ manifest, operation });
  const noCapability = harness({ fake: noCapabilityFake });
  await noCapability.runs.create("acme", operation.id, validCreateRunRequest);
  const capabilityResult = await noCapability.runs.createSessionLaunch("acme", "run-1", "launch-1");
  assert.equal(capabilityResult.ok, false);
  if (!capabilityResult.ok) assert.equal(capabilityResult.problem.status, 501);
  assert.equal(countCalls(noCapabilityFake, "/launch", "POST"), 0);
});

test("launch rejects credentials, cross-origin URLs, and expiry outside the bounded future window", async () => {
  const urls = [
    { url: "https://user:secret@app.example.test/session", expiresAt: "2030-01-01T00:00:00Z" },
    { url: "https://evil.example.test/session", expiresAt: "2030-01-01T00:00:00Z" },
    { url: "https://app.example.test/session", expiresAt: "2026-08-29T12:00:00Z" },
    { url: "https://app.example.test/session", expiresAt: "2030-01-01T00:00:00Z" },
  ];
  for (const candidate of urls) {
    const fake = createFakeAdapter({ launch: { ...candidate, singleUse: true } });
    const { runs } = harness({ fake });
    await runs.create(fakeTarget.id, createHappyOperation().id, validCreateRunRequest);
    const result = await runs.createSessionLaunch(fakeTarget.id, "run-1", "launch-1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, 502);
  }
});

test("launch accepts normalized default ports and never fetches the returned browser URL", async () => {
  const target = { ...fakeTarget, publicUrl: "https://app.example.test:443" };
  const fake = createFakeAdapter({
    launch: {
      url: "https://app.example.test:443/session?token=one#continue",
      expiresAt: "2026-08-29T12:10:00Z",
      singleUse: true,
    },
  });
  const { runs } = harness({ targets: [target], fake });
  await runs.create(fakeTarget.id, createHappyOperation().id, validCreateRunRequest);
  const result = await runs.createSessionLaunch(fakeTarget.id, "run-1", "launch-1");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.url.includes("/session"), true);
  assert.equal(fake.calls.some((call) => new URL(call.url).hostname === "app.example.test"), false);
});

test("upload, cancellation, and SSE are capability-gated and persist monotonic run projections", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const running = runWith(queued, {
    sequence: 1,
    state: "running",
    startedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
  });
  const cancelled = runWith(running, {
    sequence: 2,
    state: "cancelled",
    updatedAt: "2026-08-29T12:00:02Z",
    completedAt: "2026-08-29T12:00:02Z",
    problem: { type: "urn:gauntlet:problem:run-cancelled", title: "Run cancelled", status: 409 },
  });
  const events: readonly RunEvent[] = [{
    id: "event-1",
    sequence: running.sequence,
    occurredAt: running.updatedAt,
    type: "run.updated",
    run: running,
  }];
  const fake = createFakeAdapter({ operation, createdRun: queued, cancelledRun: cancelled, events });
  const { runs, store } = harness({ fake });

  const upload = await runs.createUpload("acme", new Blob(["fixture"]), "fixture.txt");
  assert.equal(upload.ok, true);
  if (upload.ok) assert.equal(upload.value.file.sizeBytes, 7);

  assert.equal((await runs.create("acme", operation.id, validCreateRunRequest)).ok, true);
  const stream = await runs.streamEvents("acme", queued.id);
  assert.equal(stream.ok, true);
  if (!stream.ok) return;
  const received: RunEvent[] = [];
  for await (const event of stream.value) received.push(event);
  assert.deepEqual(received.map(({ sequence }) => sequence), [1]);
  assert.equal(store.getRun("acme", queued.id)?.state, "running");

  const cancellation = await runs.cancel("acme", queued.id);
  assert.equal(cancellation.ok, true);
  if (cancellation.ok) assert.equal(cancellation.value.state, "cancelled");
  assert.equal(store.getRun("acme", queued.id)?.state, "cancelled");
  assert.equal(countCalls(fake, "/uploads", "POST"), 1);
  assert.equal(countCalls(fake, `/runs/${queued.id}/events`, "GET"), 1);
  assert.equal(countCalls(fake, `/runs/${queued.id}/cancel`, "POST"), 1);
});

test("an unadvertised control capability fails before its adapter endpoint is invoked", async () => {
  const operation = createHappyOperation();
  const manifest = mutateManifest(operation, (document) => {
    (document as unknown as { capabilities: string[] }).capabilities = ["tc-session-launch@1"];
    (document as unknown as { operations: Array<{ requirements: { capabilities: string[] } }> })
      .operations[0]!.requirements.capabilities = ["tc-session-launch@1"];
  });
  const fake = createFakeAdapter({ manifest, operation });
  const { runs, store } = harness({ fake });
  store.saveRun("acme", createQueuedRun(operation));

  const results = await Promise.all([
    runs.createUpload("acme", new Blob(["fixture"]), "fixture.txt"),
    runs.cancel("acme", "run-1"),
    runs.streamEvents("acme", "run-1"),
  ]);
  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, 501);
  }
  assert.equal(countCalls(fake, "/uploads", "POST"), 0);
  assert.equal(countCalls(fake, "/cancel", "POST"), 0);
  assert.equal(countCalls(fake, "/events", "GET"), 0);
});

test("SSE keeps the last valid projection and fails closed on a regressing event", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const running = runWith(queued, {
    sequence: 1,
    state: "running",
    startedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
  });
  const regression = runWith(queued, {
    sequence: 0,
    updatedAt: "2026-08-29T12:00:00Z",
  });
  const fake = createFakeAdapter({
    operation,
    createdRun: queued,
    events: [
      { id: "event-1", sequence: 1, occurredAt: running.updatedAt, type: "run.updated", run: running },
      { id: "event-2", sequence: 0, occurredAt: regression.updatedAt, type: "run.updated", run: regression },
    ],
  });
  const { runs, store } = harness({ fake });
  assert.equal((await runs.create("acme", operation.id, validCreateRunRequest)).ok, true);
  const result = await runs.streamEvents("acme", queued.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const iterator = result.value[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.sequence, 1);
  await assert.rejects(async () => await iterator.next(), /event stream failed/i);
  assert.equal(store.getRun("acme", queued.id)?.sequence, 1);
});

test("cancelling the projected SSE after a yield releases the upstream reader", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  let transportCancellations = 0;
  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      const event: RunEvent = {
        id: "event-1",
        sequence: queued.sequence,
        occurredAt: queued.updatedAt,
        type: "run.updated",
        run: queued,
      };
      controller.enqueue(new TextEncoder().encode(
        `id: event-1\nevent: run.updated\ndata: ${JSON.stringify(event)}\n\n`,
      ));
    },
    cancel() {
      transportCancellations += 1;
    },
  });
  const fake = createFakeAdapter({
    operation,
    createdRun: queued,
    responseFor: (call) => call.pathname.endsWith("/events")
      ? new Response(responseBody, { headers: { "content-type": "text/event-stream" } })
      : undefined,
  });
  const { runs } = harness({ fake });
  assert.equal((await runs.create("acme", operation.id, validCreateRunRequest)).ok, true);
  const result = await runs.streamEvents("acme", queued.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const iterator = result.value[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  assert.equal(responseBody.locked, true);
  await result.value.cancel();
  assert.equal(responseBody.locked, false);
  assert.equal(transportCancellations, 1);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("create records a verified actor in the forwarded invocation context", async () => {
  const { fake, runs } = harness();
  const actor = { id: "user:anna", displayName: "anna" };
  const created = await runs.create(fakeTarget.id, createHappyOperation().id, validCreateRunRequest, actor);
  assert.equal(created.ok, true);
  const forwarded = fake.calls.find((call) => call.method === "POST" && call.pathname.endsWith("/runs"));
  const context = (forwarded?.body as { context: Record<string, unknown> }).context;
  assert.deepEqual(context.actor, actor);
  assert.equal(context.requestId, validCreateRunRequest.context?.requestId);

  const { context: _omitted, ...withoutContext } = validCreateRunRequest;
  const second = harness();
  assert.equal((await second.runs.create(fakeTarget.id, createHappyOperation().id, withoutContext, actor)).ok, true);
  const generated = second.fake.calls.find((call) => call.method === "POST" && call.pathname.endsWith("/runs"));
  const generatedContext = (generated?.body as { context: Record<string, unknown> }).context;
  assert.deepEqual(generatedContext.actor, actor);
  assert.match(String(generatedContext.requestId), /^gauntlet-[0-9a-f-]{36}$/);
});
