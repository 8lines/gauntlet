import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "../../../protocol/node_modules/ajv/dist/2020.js";
import addFormats from "../../../protocol/node_modules/ajv-formats/dist/index.js";
import type {
  Artifact,
  FileReference,
  InputHandlingRule,
  InvocationContext,
  JsonObject,
  JsonValue,
  ObjectJsonSchema,
  Problem,
  Run,
  ValidationError,
} from "@8lines/gauntlet-protocol";
import {
  type ExecutionCoordinator,
  DuplicateIdempotencyKeyError,
  defineOperation,
  OperationRegistry,
  type OperationDefinitionDraft,
  type OperationHandler,
  type RegisteredOperation,
  type RunContext,
  type RunStore,
} from "../src/index.js";
import { InMemoryRunStore } from "../src/in-memory-run-store.js";
import {
  RunManager,
  type CreateRunResult,
  type FileReferenceValidationRequest,
  type RunManagerOptions,
  type SchemaValidationRequest,
} from "../src/run-manager.js";
import { confirmationFor } from "./support/operation.js";

const fixtureIdempotencySecret = (): Uint8Array =>
  new TextEncoder().encode("fixture-stable-idempotency-secret");

const objectSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
} as const;

async function canonicalRunValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const common = JSON.parse(await readFile(
    new URL("../../../protocol/schemas/v1/common.schema.json", import.meta.url),
    "utf8",
  ));
  const run = JSON.parse(await readFile(
    new URL("../../../protocol/schemas/v1/run.schema.json", import.meta.url),
    "utf8",
  ));
  ajv.addSchema(common);
  ajv.addSchema(run);
  return ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/run.schema.json")!;
}

async function canonicalCommonValidator(definition: "artifact" | "problem") {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const common = JSON.parse(await readFile(
    new URL("../../../protocol/schemas/v1/common.schema.json", import.meta.url),
    "utf8",
  ));
  ajv.addSchema(common);
  return ajv.getSchema(
    `https://schemas.8lines.dev/gauntlet/v1/common.schema.json#/$defs/${definition}`,
  )!;
}

function registered(
  id: string,
  options: {
    readonly definition?: Partial<OperationDefinitionDraft>;
    readonly handler?: OperationHandler<JsonObject>;
  } = {},
): RegisteredOperation<JsonObject> {
  const featureId = id.split(".", 1)[0] ?? id;
  return defineOperation({
    id,
    label: id,
    featureId,
    order: 0,
    tags: [],
    inputSchema: objectSchema,
    dataSources: [],
    presets: [],
    execution: {
      impact: "read",
      confirmationRequired: false,
      dryRunSupported: false,
      idempotency: "optional",
      cancellationSupported: false,
    },
    output: { schema: objectSchema },
    ...options.definition,
  }, options.handler ?? (() => ({ output: {} })));
}

function requiredPropertyValidator({
  schema,
  value,
}: SchemaValidationRequest): readonly ValidationError[] {
  for (const property of schema.required ?? []) {
    if (!Object.hasOwn(value, property)) {
      return [{
        instancePath: "",
        schemaPath: "#/required",
        keyword: "required",
        message: `must have required property '${property}'`,
        params: { missingProperty: property },
      }];
    }
  }
  return [];
}

interface Harness {
  readonly manager: RunManager;
  readonly store: InMemoryRunStore;
  readonly settle: () => Promise<void>;
}

function harness(
  operations: readonly RegisteredOperation[],
  overrides: Partial<RunManagerOptions> = {},
  store = new InMemoryRunStore(),
): Harness {
  const registry = new OperationRegistry();
  for (const featureId of new Set(operations.map(({ definition }) => definition.featureId))) {
    registry.registerFeature({ id: featureId, label: featureId });
  }
  for (const operation of operations) {
    registry.register(operation);
  }

  const pending: Array<() => Promise<void>> = [];
  let id = 0;
  let tick = 0;
  const options: RunManagerOptions = {
    validateSchema: requiredPropertyValidator,
    validateFileReference: () => [],
    idempotencySecret: fixtureIdempotencySecret(),
    createId: () => `generated-${++id}`,
    now: () => new Date(Date.UTC(2026, 7, 29, 12, 0, tick++)).toISOString(),
    schedule: (task) => pending.push(task),
    ...overrides,
  };
  const manager = new RunManager(registry, store, options);

  return {
    manager,
    store,
    settle: async () => {
      while (pending.length > 0) {
        await pending.shift()!();
        await Promise.resolve();
      }
    },
  };
}

test("requires a stable idempotency secret of at least 32 bytes", () => {
  const registry = new OperationRegistry();
  const store = new InMemoryRunStore();
  const validators = {
    validateSchema: requiredPropertyValidator,
    validateFileReference: () => [],
  };

  for (const options of [
    validators,
    { ...validators, idempotencySecret: new Uint8Array(31) },
    { ...validators, idempotencySecret: "fixture-stable-idempotency-secret" },
  ]) {
    assert.throws(
      () => new RunManager(registry, store, options as never),
      new TypeError("idempotencySecret must contain at least 32 bytes"),
    );
  }
});

test("confirmation is exact and precedes every run admission side effect", async () => {
  let schemaCalls = 0;
  let fileCalls = 0;
  let replayLookupCalls = 0;
  let createCalls = 0;
  let coordinatorCalls = 0;
  let scheduleCalls = 0;
  let handlerCalls = 0;
  let idCalls = 0;
  let clockCalls = 0;

  class AdmissionStore extends InMemoryRunStore {
    override async findByIdempotencyKey(
      operationId: string,
      idempotencyFingerprint: string,
    ): Promise<Run | undefined> {
      replayLookupCalls += 1;
      return super.findByIdempotencyKey(operationId, idempotencyFingerprint);
    }

    override async create(run: Run, idempotencyFingerprint?: string): Promise<void> {
      createCalls += 1;
      return super.create(run, idempotencyFingerprint);
    }
  }

  const operation = registered("test.confirmed", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: { attachment: { type: "object" } },
      },
      inputHandling: {
        rules: [{
          kind: "file",
          schemaPointer: "/properties/attachment",
          multiple: false,
          mediaTypes: ["text/plain"],
        }],
      },
      execution: {
        impact: "write",
        confirmationRequired: true,
        dryRunSupported: true,
        idempotency: "required",
        cancellationSupported: false,
      },
    },
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "test", label: "test" });
  registry.register(operation);
  const store = new AdmissionStore();
  const pending: Array<() => Promise<void>> = [];
  const coordinator: ExecutionCoordinator = {
    acquire: () => {
      coordinatorCalls += 1;
      return {
        kind: "acquired",
        ready: Promise.resolve(true),
        signal: new AbortController().signal,
        commitAdmission: () => undefined,
        release: () => undefined,
      };
    },
    requestCancellation: () => false,
  };
  const manager = new RunManager(registry, store, {
    validateSchema: () => {
      schemaCalls += 1;
      return [];
    },
    validateFileReference: () => {
      fileCalls += 1;
      return [];
    },
    idempotencySecret: fixtureIdempotencySecret(),
    executionCoordinator: coordinator,
    createId: () => {
      idCalls += 1;
      return "confirmed-run";
    },
    now: () => {
      clockCalls += 1;
      return "2026-09-03T12:00:00.000Z";
    },
    schedule: (task) => {
      scheduleCalls += 1;
      pending.push(task);
    },
  });
  const acknowledgement = confirmationFor(operation);
  const baseRequest = {
    operationRevision: operation.definition.revision,
    input: {
      attachment: {
        kind: "file",
        uploadId: "upload-confirmed",
        name: "confirmation.txt",
        mediaType: "text/plain",
        sizeBytes: 12,
        expiresAt: "2026-09-03T13:00:00.000Z",
      },
    },
    idempotencyKey: "confirmed-request",
  } as const;
  const invalidCases = [
    { request: baseRequest, path: "/confirmation", keyword: "required" },
    {
      request: { ...baseRequest, confirmation: { ...acknowledgement, operationId: "test.other" } },
      path: "/confirmation/operationId",
      keyword: "const",
    },
    {
      request: { ...baseRequest, confirmation: { ...acknowledgement, operationRevision: `sha256:${"f".repeat(64)}` as const } },
      path: "/confirmation/operationRevision",
      keyword: "const",
    },
    {
      request: { ...baseRequest, confirmation: { ...acknowledgement, impact: "destructive" as const } },
      path: "/confirmation/impact",
      keyword: "const",
    },
    {
      request: { ...baseRequest, dryRun: true },
      path: "/confirmation",
      keyword: "required",
    },
  ];

  for (const { request, path, keyword } of invalidCases) {
    const result = await manager.create(operation.definition.id, request);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.status, 422);
      assert.equal(result.problem.errors?.[0]?.instancePath, path);
      assert.equal(result.problem.errors?.[0]?.keyword, keyword);
    }
  }

  const stale = await manager.create(operation.definition.id, {
    ...baseRequest,
    operationRevision: `sha256:${"e".repeat(64)}`,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.problem.status, 409);
  assert.deepEqual({
    schemaCalls,
    fileCalls,
    replayLookupCalls,
    createCalls,
    coordinatorCalls,
    scheduleCalls,
    handlerCalls,
    idCalls,
    clockCalls,
    pending: pending.length,
  }, {
    schemaCalls: 0,
    fileCalls: 0,
    replayLookupCalls: 0,
    createCalls: 0,
    coordinatorCalls: 0,
    scheduleCalls: 0,
    handlerCalls: 0,
    idCalls: 0,
    clockCalls: 0,
    pending: 0,
  });
});

test("missing confirmation cannot replay an already accepted idempotent run", async () => {
  const operation = registered("test.confirmed-replay", {
    definition: {
      execution: {
        impact: "write",
        confirmationRequired: true,
        dryRunSupported: false,
        idempotency: "required",
        cancellationSupported: false,
      },
    },
  });
  let replayLookups = 0;
  class ReplayStore extends InMemoryRunStore {
    override async findByIdempotencyKey(
      operationId: string,
      idempotencyFingerprint: string,
    ): Promise<Run | undefined> {
      replayLookups += 1;
      return super.findByIdempotencyKey(operationId, idempotencyFingerprint);
    }
  }
  const { manager, settle } = harness([operation], {}, new ReplayStore());
  const validRequest = {
    ...requestFor(operation, "replay-key"),
    confirmation: confirmationFor(operation),
  };
  const first = await manager.create(operation.definition.id, validRequest);
  assert.equal(first.ok, true);
  await settle();
  const lookupsAfterAcceptance = replayLookups;

  const replayWithoutConfirmation = await manager.create(operation.definition.id, {
    ...requestFor(operation, "replay-key"),
  });

  assert.equal(replayWithoutConfirmation.ok, false);
  if (!replayWithoutConfirmation.ok) {
    assert.equal(replayWithoutConfirmation.problem.errors?.[0]?.instancePath, "/confirmation");
  }
  assert.equal(replayLookups, lookupsAfterAcceptance);
});

function requestFor(
  operation: RegisteredOperation,
  idempotencyKey?: string,
  input: JsonObject = {},
) {
  return {
    operationRevision: operation.definition.revision,
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function queuedRunFor(operation: RegisteredOperation, id = "stored-run"): Run {
  return {
    id,
    operationId: operation.definition.id,
    operationRevision: operation.definition.revision,
    state: "queued",
    sequence: 0,
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
    artifacts: [],
    actions: [],
  };
}

function succeededRunFor(
  operation: RegisteredOperation,
  id = "stored-run",
  overrides: Partial<Run> = {},
): Run {
  return {
    ...queuedRunFor(operation, id),
    state: "succeeded",
    sequence: 2,
    updatedAt: "2026-08-29T12:02:00.000Z",
    startedAt: "2026-08-29T12:01:00.000Z",
    completedAt: "2026-08-29T12:02:00.000Z",
    output: {},
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function assertDeepPlainFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype);
    value.forEach((child) => assertDeepPlainFrozen(child, seen));
    return;
  }
  assert.equal(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    true,
  );
  Object.values(value).forEach((child) => assertDeepPlainFrozen(child, seen));
}

const invocationContextSentinel = "invocation-context-only-sentinel-2026-08-29";

const fullInvocationContextFixture = {
  requestId: "request-context-1",
  locale: "pl-PL",
  timeZone: "Europe/Warsaw",
  actor: { id: "actor-context-1", displayName: "Original actor" },
  target: { id: "target-context-1", environment: "staging" },
  extensions: {
    "urn:test:invocation-context": { sentinel: invocationContextSentinel },
  },
} satisfies InvocationContext;

test("create rejects a stale operation revision before creating a run", async () => {
  const operation = registered("agency.demote");
  const { manager, store } = harness([operation]);

  const result = await manager.create("agency.demote", {
    operationRevision: `sha256:${"f".repeat(64)}`,
    input: { applicationId: "a" },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.status, 409);
  assert.equal((await store.all()).length, 0);
});

test("an idempotency key returns the original run", async () => {
  let executionCount = 0;
  const operation = registered("test.echo", {
    handler: () => {
      executionCount += 1;
      return { output: {} };
    },
  });
  const { manager, settle } = harness([operation]);
  const request = requestFor(operation, "same");

  const first = await manager.create("test.echo", request);
  const second = await manager.create("test.echo", request);
  await settle();

  assert.equal(first.ok && second.ok && first.run.id, second.ok && second.run.id);
  assert.equal(executionCount, 1);
});

test("secret values never cross the idempotency persistence boundary", async () => {
  const secret = "secret-used-as-key";
  class RecordingRunStore extends InMemoryRunStore {
    readonly persistedIdempotencyKeys: string[] = [];

    override async create(
      run: Parameters<InMemoryRunStore["create"]>[0],
      idempotencyFingerprint?: string,
    ): Promise<void> {
      if (idempotencyFingerprint !== undefined) {
        this.persistedIdempotencyKeys.push(idempotencyFingerprint);
      }
      await super.create(run, idempotencyFingerprint);
    }
  }

  const store = new RecordingRunStore();
  const operation = registered("test.idempotent-secret", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: { token: { type: "string" } },
      },
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: "/properties/token",
          retention: "none",
        }],
      },
    },
  });
  const { manager, settle } = harness([operation], {}, store);
  const request = requestFor(operation, secret, { token: secret });

  const first = await manager.create("test.idempotent-secret", request);
  const second = await manager.create("test.idempotent-secret", request);
  await settle();

  assert.equal(first.ok && second.ok && first.run.id, second.ok && second.run.id);
  assert.equal(JSON.stringify(store.persistedIdempotencyKeys).includes(secret), false);
});

test("idempotency fingerprints are keyed, operation-scoped, and stable with shared configuration", async () => {
  class RecordingRunStore extends InMemoryRunStore {
    readonly persistedIdempotencyKeys: string[] = [];

    override async create(run: Run, idempotencyFingerprint?: string): Promise<void> {
      if (idempotencyFingerprint !== undefined) {
        this.persistedIdempotencyKeys.push(idempotencyFingerprint);
      }
      await super.create(run, idempotencyFingerprint);
    }
  }

  const firstOperation = registered("alpha.shared-key");
  const secondOperation = registered("beta.shared-key");
  const rawKey = "same-client-key";
  const sharedSecret = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
  const expectedSecret = Uint8Array.from(sharedSecret);
  const firstStore = new RecordingRunStore();
  const firstHarness = harness(
    [firstOperation, secondOperation],
    { idempotencySecret: sharedSecret },
    firstStore,
  );
  sharedSecret.fill(0);
  await firstHarness.manager.create(firstOperation.definition.id, requestFor(firstOperation, rawKey));
  await firstHarness.manager.create(secondOperation.definition.id, requestFor(secondOperation, rawKey));

  const secondStore = new RecordingRunStore();
  const secondHarness = harness(
    [firstOperation],
    { idempotencySecret: expectedSecret },
    secondStore,
  );
  await secondHarness.manager.create(firstOperation.definition.id, requestFor(firstOperation, rawKey));

  const expected = `tc-idempotency:v1:${createHmac("sha256", expectedSecret)
    .update("tc-idempotency:v1\0", "utf8")
    .update(firstOperation.definition.id, "utf8")
    .update("\0", "utf8")
    .update(rawKey, "utf8")
    .digest("hex")}`;
  assert.equal(firstStore.persistedIdempotencyKeys[0], expected);
  assert.equal(secondStore.persistedIdempotencyKeys[0], expected);
  assert.notEqual(firstStore.persistedIdempotencyKeys[0], firstStore.persistedIdempotencyKeys[1]);
  assert.equal(JSON.stringify(firstStore.persistedIdempotencyKeys).includes(rawKey), false);

  await firstHarness.settle();
  await secondHarness.settle();
});

test("idempotency policy rejects forbidden and missing or blank keys", async () => {
  const none = registered("test.none", {
    definition: { execution: {
      impact: "read",
      confirmationRequired: false,
      dryRunSupported: false,
      idempotency: "none",
      cancellationSupported: false,
    } },
  });
  const required = registered("test.required", {
    definition: { execution: {
      impact: "read",
      confirmationRequired: false,
      dryRunSupported: false,
      idempotency: "required",
      cancellationSupported: false,
    } },
  });
  const { manager, store } = harness([none, required]);

  const forbidden = await manager.create("test.none", requestFor(none, "not-allowed"));
  const missing = await manager.create("test.required", requestFor(required));
  const blank = await manager.create("test.required", requestFor(required, "   "));

  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.problem.status, 422);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.problem.status, 422);
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.problem.status, 422);
  assert.equal((await store.all()).length, 0);
});

test("public get owns canonical store values and hides invalid or mismatched data", async () => {
  const operation = registered("test.store-get");
  const source = queuedRunFor(operation, "expected-run");
  let stored: Run | undefined = source;
  const store: RunStore = {
    create: async () => undefined,
    get: async () => stored,
    findByIdempotencyKey: async () => undefined,
    update: async () => undefined,
  };
  const { manager } = harness([operation], {}, store);

  const owned = await manager.get(source.id);
  assert.notEqual(owned, source);
  assertDeepPlainFrozen(owned);
  (source as { sequence: number }).sequence = 9;
  assert.equal(owned?.sequence, 0);

  stored = { ...queuedRunFor(operation, source.id), unexpected: true } as never;
  assert.equal(await manager.get(source.id), undefined);
  stored = {
    ...queuedRunFor(operation, source.id),
    extensions: { "urn:test:exotic": new Date("2026-08-29T12:00:00Z") },
  } as never;
  assert.equal(await manager.get(source.id), undefined);
  stored = queuedRunFor(operation, "different-run");
  assert.equal(await manager.get(source.id), undefined);
});

test("custom store projections reject noncanonical cancellation and timeout Problems", async () => {
  const operation = registered("test.store-terminal-policy");
  const queued = queuedRunFor(operation, "terminal-policy-run");
  let stored: Run | undefined;
  const store: RunStore = {
    create: async () => undefined,
    get: async () => stored,
    findByIdempotencyKey: async () => undefined,
    update: async () => undefined,
  };
  const { manager } = harness([operation], {}, store);
  const canonical = [
    {
      state: "cancelled" as const,
      problem: {
        type: "urn:gauntlet:problem:run-cancelled" as const,
        title: "Run cancelled",
        status: 409,
      },
    },
    {
      state: "timed_out" as const,
      problem: {
        type: "urn:gauntlet:problem:run-timed-out" as const,
        title: "Run timed out",
        status: 504,
      },
    },
  ];

  for (const terminal of canonical) {
    const run: Run = {
      ...queued,
      state: terminal.state,
      sequence: 1,
      completedAt: queued.updatedAt,
      problem: terminal.problem,
    };
    stored = run;
    assert.equal((await manager.get(run.id))?.state, terminal.state);

    for (const problem of [
      { ...terminal.problem, type: "urn:gauntlet:problem:handler-failed" as const },
      { ...terminal.problem, title: "Hostile terminal title" },
      { ...terminal.problem, status: 500 },
    ]) {
      stored = { ...run, problem };
      assert.equal(await manager.get(run.id), undefined);
      assert.equal(await manager.runProjectionIsValid(stored, { id: run.id }), false);
    }
  }
});

test("idempotency replay owns and verifies every custom store value", async () => {
  const operation = registered("test.store-replay");
  const source = queuedRunFor(operation, "replayed-run");
  let replay: Run | undefined = source;
  let createCalls = 0;
  let scheduleCalls = 0;
  const store: RunStore = {
    create: async () => {
      createCalls += 1;
    },
    get: async () => undefined,
    findByIdempotencyKey: async () => replay,
    update: async () => undefined,
  };
  const { manager } = harness([operation], {
    schedule: () => {
      scheduleCalls += 1;
    },
  }, store);

  const canonical = await manager.create(
    operation.definition.id,
    requestFor(operation, "existing-key"),
  );
  assert.equal(canonical.ok, true);
  if (canonical.ok) {
    assert.notEqual(canonical.run, source);
    assertDeepPlainFrozen(canonical.run);
    (source as { sequence: number }).sequence = 7;
    assert.equal(canonical.run.sequence, 0);
  }
  assert.equal(createCalls, 0);
  assert.equal(scheduleCalls, 0);

  const invalidReplays: readonly Run[] = [
    { ...queuedRunFor(operation), unexpected: true } as never,
    { ...queuedRunFor(operation), operationId: "other.operation" },
    { ...queuedRunFor(operation), operationRevision: `sha256:${"f".repeat(64)}` },
  ];
  for (const invalid of invalidReplays) {
    replay = invalid;
    const result = await manager.create(
      operation.definition.id,
      requestFor(operation, "existing-key"),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.type, "urn:gauntlet:problem:adapter-internal-error");
      assert.equal(JSON.stringify(result.problem).includes("other.operation"), false);
    }
  }
  assert.equal(createCalls, 0);
  assert.equal(scheduleCalls, 0);
});

test("every custom store read rejects catalog-invalid output, actions, artifacts, and files", async () => {
  const requiredInput = registered("stored.target", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
    },
  });
  const fileTarget = registered("stored.file-target", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["attachment"],
        properties: { attachment: { type: "object" } },
        additionalProperties: false,
      },
      inputHandling: {
        rules: [{ kind: "file", schemaPointer: "/properties/attachment", multiple: false }],
      },
    },
  });
  const source = registered("stored.source", {
    definition: {
      output: {
        schema: {
          ...objectSchema,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
  });
  const valid = succeededRunFor(source, "stored-projection", { output: { ok: true } });
  const file: FileReference = {
    kind: "file",
    uploadId: "untrusted-upload",
    name: "fixture.txt",
    mediaType: "text/plain",
    sizeBytes: 7,
    expiresAt: "2026-08-29T13:00:00.000Z",
  };
  const invalid: readonly Run[] = [
    { ...valid, output: { ok: "yes" } as never },
    {
      ...valid,
      actions: [{
        kind: "invoke-operation",
        label: "Missing required input",
        operationId: requiredInput.definition.id,
      }],
    },
    {
      ...valid,
      actions: [{
        kind: "invoke-operation",
        label: "Unknown operation",
        operationId: "stored.missing",
        input: {},
      }],
    },
    {
      ...valid,
      actions: [{
        kind: "invoke-operation",
        label: "Untrusted file",
        operationId: fileTarget.definition.id,
        input: { attachment: file },
      }],
    },
    {
      ...valid,
      artifacts: [
        { id: "duplicate", kind: "notice", level: "info", message: "one" },
        { id: "duplicate", kind: "notice", level: "info", message: "two" },
      ],
    },
    {
      ...valid,
      actions: [{ kind: "browser-launch", label: "Open", artifactId: "missing" }],
    },
    {
      ...valid,
      createdAt: "2026-08-29T12:03:00.000Z",
    },
    {
      ...valid,
      progress: {
        current: 2,
        total: 1,
        updatedAt: valid.updatedAt,
      },
    },
  ];
  let stored: Run | undefined = valid;
  let createCalls = 0;
  let scheduleCalls = 0;
  const store: RunStore = {
    create: async () => { createCalls += 1; },
    get: async () => stored,
    findByIdempotencyKey: async () => stored,
    update: async () => undefined,
  };
  const { manager } = harness(
    [source, requiredInput, fileTarget],
    {
      validateFileReference: () => [{
        instancePath: "/attachment",
        schemaPath: "#/inputHandling",
        keyword: "file",
        message: "upload is not trusted",
        params: {},
      }],
      schedule: () => { scheduleCalls += 1; },
    },
    store,
  );

  assert.deepEqual(await manager.get(valid.id), valid);
  for (const candidate of invalid) {
    stored = candidate;
    assert.equal(await manager.get(valid.id), undefined);
    const replay = await manager.create(source.definition.id, requestFor(source, "existing-key"));
    assert.equal(replay.ok, false);
    if (!replay.ok) {
      assert.equal(replay.problem.type, "urn:gauntlet:problem:adapter-internal-error");
    }
  }
  assert.equal(createCalls, 0);
  assert.equal(scheduleCalls, 0);
});

test("producer invoke actions validate absent and present input before persistence", async () => {
  const target = registered("actions.required-target", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
    },
  });
  const fromContext = registered("actions.context-source", {
    handler: (_input, context) => {
      context.addAction({
        kind: "invoke-operation",
        label: "Missing input",
        operationId: target.definition.id,
      });
      return { output: {} };
    },
  });
  const fromResult = registered("actions.result-source", {
    handler: () => ({
      output: {},
      actions: [{
        kind: "invoke-operation",
        label: "Invalid input",
        operationId: target.definition.id,
        input: {},
      }],
    }),
  });
  const { manager, store, settle } = harness([target, fromContext, fromResult]);

  const created = await Promise.all([fromContext, fromResult].map((operation) =>
    manager.create(operation.definition.id, requestFor(operation))));
  assert.equal(created.every((result) => result.ok), true);
  await settle();

  for (const result of created) {
    if (!result.ok) continue;
    const history = await store.history(result.run.id);
    assert.equal(history.at(-1)?.state, "failed");
    assert.equal(history.every((run) => run.actions.length === 0), true);
  }
});

test("producer invoke actions reject a non-array target-schema validator result", async () => {
  const target = registered("actions.hostile-validator-target", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
    },
  });
  const source = registered("actions.hostile-validator-source", {
    handler: (_input, context) => {
      context.addAction({
        kind: "invoke-operation",
        label: "Continue",
        operationId: target.definition.id,
        input: { id: "target" },
      });
      return { output: {} };
    },
  });
  const { manager, store, settle } = harness([source, target], {
    validateSchema: async ({ value }) => (value as { id?: unknown }).id === "target"
      ? { length: 0 } as unknown as readonly ValidationError[]
      : [],
  });

  const created = await manager.create(source.definition.id, requestFor(source));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await settle();
  const history = await store.history(created.run.id);
  assert.equal(history.at(-1)?.state, "failed");
  assert.equal(history.every((run) => run.actions.length === 0), true);
});

test("duplicate and execution recovery validate custom store reads before inspection", async () => {
  const duplicateOperation = registered("test.store-duplicate");
  let lookupCalls = 0;
  const duplicateStore: RunStore = {
    create: async () => {
      throw new DuplicateIdempotencyKeyError();
    },
    get: async () => undefined,
    findByIdempotencyKey: async () => {
      lookupCalls += 1;
      return lookupCalls === 1
        ? undefined
        : { ...queuedRunFor(duplicateOperation), operationId: "wrong.operation" };
    },
    update: async () => undefined,
  };
  const duplicateTasks: Array<() => Promise<void>> = [];
  const duplicateHarness = harness(
    [duplicateOperation],
    { schedule: (task) => duplicateTasks.push(task) },
    duplicateStore,
  );

  const duplicate = await duplicateHarness.manager.create(
    duplicateOperation.definition.id,
    requestFor(duplicateOperation, "duplicate-key"),
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.problem.type, "urn:gauntlet:problem:adapter-internal-error");
  assert.equal(duplicateTasks.length, 1);
  await assert.doesNotReject(duplicateTasks[0]!());

  let recoveryStateReads = 0;
  const recoveryOperation = registered("test.store-recovery", {
    handler: () => {
      throw new Error("handler detail");
    },
  });
  const recoveryRun = queuedRunFor(recoveryOperation, "generated-1") as Record<string, unknown>;
  Object.defineProperty(recoveryRun, "state", {
    enumerable: true,
    get: () => {
      recoveryStateReads += 1;
      throw new Error("store accessor detail");
    },
  });
  const recoveryStore: RunStore = {
    create: async () => undefined,
    get: async () => recoveryRun as never,
    findByIdempotencyKey: async () => undefined,
    update: async () => undefined,
  };
  const recoveryTasks: Array<() => Promise<void>> = [];
  const recoveryHarness = harness(
    [recoveryOperation],
    { schedule: (task) => recoveryTasks.push(task) },
    recoveryStore,
  );

  const created = await recoveryHarness.manager.create(
    recoveryOperation.definition.id,
    requestFor(recoveryOperation),
  );
  assert.equal(created.ok, true);
  await assert.doesNotReject(recoveryTasks[0]!());
  assert.equal(recoveryStateReads, 0);
});

test("scheduler failure cannot create a persisted orphan", async () => {
  let handlerCalls = 0;
  let scheduledTask: (() => Promise<void>) | undefined;
  const operation = registered("test.scheduler-throw", {
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const { manager, store } = harness([operation], {
    schedule: (task) => {
      scheduledTask = task;
      throw new Error("scheduler internals must not escape");
    },
  });

  const result = await manager.create(operation.definition.id, {
    ...requestFor(operation),
    context: fullInvocationContextFixture,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.status, 500);
  assert.notEqual(scheduledTask, undefined);
  await assert.doesNotReject(scheduledTask!());
  assert.deepEqual(await store.all(), []);
  assert.equal(JSON.stringify(await store.all()).includes(invocationContextSentinel), false);
  assert.equal(handlerCalls, 0);
});

test("handler dispatch waits for successful queued persistence", async () => {
  const createStarted = deferred();
  const allowCreate = deferred();
  class GatedCreateStore extends InMemoryRunStore {
    override async create(run: Run, idempotencyFingerprint?: string): Promise<void> {
      createStarted.resolve();
      await allowCreate.promise;
      await super.create(run, idempotencyFingerprint);
    }
  }

  let handlerCalls = 0;
  const operation = registered("test.persistence-gate", {
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const tasks: Array<() => Promise<void>> = [];
  const store = new GatedCreateStore();
  const { manager } = harness([operation], { schedule: (task) => tasks.push(task) }, store);

  const creating = manager.create(operation.definition.id, requestFor(operation));
  await createStarted.promise;
  const scheduledBeforePersistence = tasks.length;
  if (scheduledBeforePersistence !== 1) {
    allowCreate.resolve();
    await creating;
  }
  assert.equal(scheduledBeforePersistence, 1);

  const execution = tasks[0]!();
  await Promise.resolve();
  assert.equal(handlerCalls, 0);
  allowCreate.resolve();
  const created = await creating;
  assert.equal(created.ok, true);
  await execution;
  assert.equal(handlerCalls, 1);
});

test("failed and duplicate creates release candidate tasks as no-ops", async () => {
  const createStarted = deferred();
  const rejectCreate = deferred();
  class FailingCreateStore extends InMemoryRunStore {
    override async create(): Promise<void> {
      createStarted.resolve();
      await rejectCreate.promise;
      throw new Error("persistence details must not escape");
    }
  }

  let handlerCalls = 0;
  const operation = registered("test.persistence-failure", {
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const failedTasks: Array<() => Promise<void>> = [];
  const failedStore = new FailingCreateStore();
  const { manager: failedManager } = harness(
    [operation],
    { schedule: (task) => failedTasks.push(task) },
    failedStore,
  );
  const failingCreate = failedManager.create(operation.definition.id, {
    ...requestFor(operation),
    context: fullInvocationContextFixture,
  });
  await createStarted.promise;
  const failedTaskCount = failedTasks.length;
  if (failedTaskCount !== 1) rejectCreate.resolve();
  assert.equal(failedTaskCount, 1);
  const failedExecution = failedTasks[0]!();
  rejectCreate.resolve();
  const failedResult = await failingCreate;
  await failedExecution;
  assert.equal(failedResult.ok, false);
  assert.deepEqual(await failedStore.all(), []);
  assert.equal(JSON.stringify(await failedStore.all()).includes(invocationContextSentinel), false);
  assert.equal(handlerCalls, 0);

  const existing: Run = {
    id: "existing-run",
    operationId: operation.definition.id,
    operationRevision: operation.definition.revision,
    state: "queued",
    sequence: 0,
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
    artifacts: [],
    actions: [],
  };
  let createAttempted = false;
  const duplicateStore: RunStore = {
    create: async () => {
      createAttempted = true;
      throw new DuplicateIdempotencyKeyError();
    },
    get: async () => existing,
    findByIdempotencyKey: async () => createAttempted ? existing : undefined,
    update: async () => undefined,
  };
  const duplicateTasks: Array<() => Promise<void>> = [];
  const { manager: duplicateManager } = harness(
    [operation],
    { schedule: (task) => duplicateTasks.push(task) },
    duplicateStore,
  );
  const duplicateResult = await duplicateManager.create(
    operation.definition.id,
    {
      ...requestFor(operation, "duplicate"),
      context: fullInvocationContextFixture,
    },
  );
  assert.equal(duplicateResult.ok, true);
  assert.equal(duplicateResult.ok && duplicateResult.run.id, existing.id);
  assert.equal(duplicateTasks.length, 1);
  await duplicateTasks[0]!();
  if (duplicateResult.ok) {
    assert.equal(JSON.stringify(duplicateResult.run).includes(invocationContextSentinel), false);
  }
  assert.equal(handlerCalls, 0);
});

test("normal and fallback update rejection cannot reject a scheduled task", async () => {
  class RejectingUpdateStore extends InMemoryRunStore {
    updateCalls = 0;

    override async update(): Promise<void> {
      this.updateCalls += 1;
      throw new Error("raw-store-secret");
    }
  }

  let handlerCalls = 0;
  const operation = registered("test.update-rejection", {
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const tasks: Array<() => Promise<void>> = [];
  const store = new RejectingUpdateStore();
  const { manager } = harness([operation], { schedule: (task) => tasks.push(task) }, store);
  const created = await manager.create(operation.definition.id, {
    ...requestFor(operation),
    context: fullInvocationContextFixture,
  });
  assert.equal(created.ok, true);
  assert.equal(tasks.length, 1);

  await assert.doesNotReject(tasks[0]!());
  assert.equal(store.updateCalls, 3);
  assert.equal(handlerCalls, 0);
  assert.equal(JSON.stringify(await store.all()).includes(invocationContextSentinel), false);
  assert.equal(JSON.stringify(await store.all()).includes("raw-store-secret"), false);
});

test("unknown operations and unsupported dry runs fail before persistence", async () => {
  let handlerCalls = 0;
  const operation = registered("test.echo", {
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const { manager, store } = harness([operation]);

  const missing = await manager.create("test.missing", requestFor(operation));
  const dryRun = await manager.create("test.echo", {
    ...requestFor(operation),
    dryRun: true,
  });

  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.problem.status, 404);
    assert.equal(missing.problem.type, "urn:gauntlet:problem:operation-not-found");
  }
  assert.equal(dryRun.ok, false);
  if (!dryRun.ok) assert.equal(dryRun.problem.status, 422);
  assert.equal((await store.all()).length, 0);
  assert.equal(handlerCalls, 0);
});

test("create owns and validates the complete request envelope before any field read", async () => {
  let handlerCalls = 0;
  let validatorCalls = 0;
  let fileValidatorCalls = 0;
  let scheduleCalls = 0;
  let revisionReads = 0;
  const operation = registered("test.request-envelope", {
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const accessorRequest = {
    input: {},
  } as Record<string, unknown>;
  Object.defineProperty(accessorRequest, "operationRevision", {
    enumerable: true,
    get: () => {
      revisionReads += 1;
      throw new Error("caller accessor detail");
    },
  });
  const symbolRequest = requestFor(operation) as Record<PropertyKey, unknown>;
  symbolRequest[Symbol("hidden")] = true;
  const exoticRequest = Object.assign(Object.create({ inherited: true }), requestFor(operation));
  const invalidRequests: readonly unknown[] = [
    null,
    [],
    { operationRevision: operation.definition.revision },
    { input: {} },
    { operationRevision: "not-a-revision", input: {} },
    { ...requestFor(operation), unexpected: true },
    { ...requestFor(operation), context: {} },
    { ...requestFor(operation), extensions: { invalid: true } },
    { ...requestFor(operation), input: { unsafe: Number.MAX_SAFE_INTEGER + 1 } },
    accessorRequest,
    symbolRequest,
    exoticRequest,
  ];
  const { manager, store } = harness([operation], {
    validateSchema: (request) => {
      validatorCalls += 1;
      return requiredPropertyValidator(request);
    },
    validateFileReference: () => {
      fileValidatorCalls += 1;
      return [];
    },
    schedule: () => {
      scheduleCalls += 1;
    },
  });

  const results: readonly (CreateRunResult | Error)[] = await Promise.all(invalidRequests.map(async (request) => {
    try {
      return await manager.create(operation.definition.id, request as never);
    } catch (error) {
      return error instanceof Error ? error : new Error("unknown create rejection");
    }
  }));

  const validateProblem = await canonicalCommonValidator("problem");
  for (const result of results) {
    assert.equal(result instanceof Error, false);
    if (result instanceof Error) continue;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.type, "urn:gauntlet:problem:validation-failed");
      assert.equal(result.problem.status, 422);
      assert.equal(validateProblem(result.problem), true, JSON.stringify(validateProblem.errors));
      assert.equal(JSON.stringify(result.problem).includes("caller accessor detail"), false);
    }
  }
  assert.equal(revisionReads, 0);
  assert.equal(validatorCalls, 0);
  assert.equal(fileValidatorCalls, 0);
  assert.equal(scheduleCalls, 0);
  assert.equal(handlerCalls, 0);
  assert.deepEqual(await store.all(), []);
});

test("request envelope diagnostics never contain secret-derived caller text", async () => {
  const secret = "secret-field-name-8391";
  let handlerCalls = 0;
  let validatorCalls = 0;
  let fileValidatorCalls = 0;
  let scheduleCalls = 0;
  const operation = registered("test.envelope-diagnostic-secret", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: { token: { type: "string" } },
      },
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: "/properties/token",
          retention: "none",
        }],
      },
    },
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const { manager, store } = harness([operation], {
    validateSchema: () => {
      validatorCalls += 1;
      return [];
    },
    validateFileReference: () => {
      fileValidatorCalls += 1;
      return [];
    },
    schedule: () => {
      scheduleCalls += 1;
    },
  });
  const requests: readonly unknown[] = [
    {
      ...requestFor(operation, undefined, { token: secret }),
      [secret]: true,
    },
    {
      ...requestFor(operation, undefined, { token: secret }),
      extensions: { [secret]: true },
    },
    requestFor(operation, undefined, {
      token: secret,
      [secret]: Number.MAX_SAFE_INTEGER + 1,
    }),
  ];

  const results = await Promise.all(requests.map((request) =>
    manager.create(operation.definition.id, request as never)));

  const validateProblem = await canonicalCommonValidator("problem");
  for (const result of results) {
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.problem.status, 422);
    assert.equal(validateProblem(result.problem), true, JSON.stringify(validateProblem.errors));
    assert.equal(JSON.stringify(result.problem).includes(secret), false);
    for (const error of result.problem.errors ?? []) {
      assert.equal(error.instancePath.includes(secret), false);
      assert.equal(error.schemaPath.includes(secret), false);
      assert.equal(error.keyword.includes(secret), false);
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error.params).includes(secret), false);
      assert.equal(JSON.stringify(error.extensions ?? {}).includes(secret), false);
    }
  }
  assert.equal(validatorCalls, 0);
  assert.equal(fileValidatorCalls, 0);
  assert.equal(scheduleCalls, 0);
  assert.equal(handlerCalls, 0);
  assert.deepEqual(await store.all(), []);
});

test("valid owned request envelopes retain semantic validation precedence", async () => {
  const operation = registered("test.request-precedence", {
    definition: {
      execution: {
        impact: "read",
        confirmationRequired: false,
        dryRunSupported: false,
        idempotency: "none",
        cancellationSupported: false,
      },
    },
  });
  const { manager, store } = harness([operation]);
  const staleRevision = `sha256:${"f".repeat(64)}`;

  const stale = await manager.create(operation.definition.id, {
    operationRevision: staleRevision,
    input: {},
    dryRun: true,
    idempotencyKey: "not-allowed",
  });
  const dryRun = await manager.create(operation.definition.id, {
    operationRevision: operation.definition.revision,
    input: {},
    dryRun: true,
    idempotencyKey: "not-allowed",
  });
  const idempotency = await manager.create(operation.definition.id, {
    operationRevision: operation.definition.revision,
    input: {},
    idempotencyKey: "not-allowed",
  });

  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.problem.status, 409);
  assert.equal(dryRun.ok, false);
  if (!dryRun.ok) assert.equal(dryRun.problem.errors?.[0]?.keyword, "dryRun");
  assert.equal(idempotency.ok, false);
  if (!idempotency.ok) assert.equal(idempotency.problem.errors?.[0]?.keyword, "idempotency");
  assert.deepEqual(await store.all(), []);
});

test("input and context schemas are enforced before handler dispatch", async () => {
  let executionCount = 0;
  const inputSchema: ObjectJsonSchema = { ...objectSchema, required: ["applicationId"] };
  const contextSchema: ObjectJsonSchema = {
    ...objectSchema,
    required: ["requestId", "target"],
    properties: {
      requestId: { type: "string" },
      locale: { type: "string" },
      timeZone: { type: "string" },
      actor: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayName: { type: "string" },
        },
        additionalProperties: false,
      },
      target: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          environment: { type: "string" },
        },
        additionalProperties: false,
      },
      extensions: { type: "object" },
    },
    additionalProperties: false,
  };
  const requestOnlyContext = { requestId: "request-only" } as const;
  const completeContext = {
    requestId: "request-complete",
    locale: "pl-PL",
    timeZone: "Europe/Warsaw",
    actor: { id: "tester-1", displayName: "Tester" },
    target: { id: "staging", environment: "staging" },
    extensions: { "urn:test:trace": { correlationId: "trace-1" } },
  } as const;
  const validatedContextValues: JsonObject[] = [];
  const operation = registered("test.validated", {
    definition: { inputSchema, contextSchema },
    handler: () => {
      executionCount += 1;
      return { output: {} };
    },
  });
  const { manager, store, settle } = harness([operation], {
    validateSchema: (request) => {
      if (request.subject === "context") {
        validatedContextValues.push(request.value);
      }
      return requiredPropertyValidator(request);
    },
  });

  const invalidInput = await manager.create("test.validated", requestFor(operation));
  const invalidContext = await manager.create("test.validated", {
    ...requestFor(operation, undefined, { applicationId: "app-1" }),
    context: requestOnlyContext,
  });
  const valid = await manager.create("test.validated", {
    ...requestFor(operation, undefined, { applicationId: "app-1" }),
    context: completeContext,
  });

  assert.equal(invalidInput.ok, false);
  if (!invalidInput.ok) {
    assert.equal(invalidInput.problem.status, 422);
    assert.equal(invalidInput.problem.errors?.[0]?.schemaPath, "#/required");
  }
  assert.equal(invalidContext.ok, false);
  if (!invalidContext.ok) {
    assert.equal(invalidContext.problem.status, 422);
    assert.equal(invalidContext.problem.errors?.[0]?.schemaPath, "#/required");
  }
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.run.state, "queued");
  assert.equal(executionCount, 0);
  assert.deepEqual(validatedContextValues, [requestOnlyContext, completeContext]);

  await settle();

  assert.equal(executionCount, 1);
  const stored = await store.all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.state, "succeeded");
});

test("schema and file diagnostics take precedence over secret handling", async () => {
  let executionCount = 0;
  const operation = registered("test.precedence", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["applicationId"],
        properties: {
          attachment: { type: "object" },
          token: { type: "string" },
        },
      },
      inputHandling: {
        rules: [
          {
            kind: "secret",
            schemaPointer: "/properties/token",
            retention: "none",
          },
          {
            kind: "file",
            schemaPointer: "/properties/attachment",
            multiple: false,
            mediaTypes: ["text/plain"],
          },
        ],
      },
    },
    handler: () => {
      executionCount += 1;
      return { output: {} };
    },
  });
  const { manager, store } = harness([operation]);
  const attachment: FileReference = {
    kind: "file",
    uploadId: "upload-1",
    name: "note.txt",
    mediaType: "text/plain",
    sizeBytes: 50,
    expiresAt: "2026-08-29T13:00:00Z",
  };

  const staleUncloneable = await manager.create("test.precedence", {
    operationRevision: `sha256:${"f".repeat(64)}`,
    input: { value: () => undefined } as never,
  });
  assert.equal(staleUncloneable.ok, false);
  if (!staleUncloneable.ok) assert.equal(staleUncloneable.problem.status, 422);

  const schemaFailure = await manager.create("test.precedence", requestFor(operation, undefined, {
    token: "diagnostic-secret",
    attachment,
  }));
  assert.equal(schemaFailure.ok, false);
  if (!schemaFailure.ok) assert.equal(schemaFailure.problem.errors?.[0]?.schemaPath, "#/required");
  assert.equal(JSON.stringify(schemaFailure).includes("diagnostic-secret"), false);

  const fileFailure = await manager.create("test.precedence", requestFor(operation, undefined, {
    applicationId: "app-1",
    token: "file-secret",
    attachment: { ...attachment, mediaType: "application/pdf" },
  }));
  assert.equal(fileFailure.ok, false);
  if (!fileFailure.ok) assert.equal(fileFailure.problem.errors?.[0]?.keyword, "mediaType");

  assert.equal(executionCount, 0);
  assert.equal((await store.all()).length, 0);
});

test("file rules enforce shape, policy, and the injected upload validator", async () => {
  const fileRule: Extract<InputHandlingRule, { kind: "file" }> = {
    kind: "file",
    schemaPointer: "/properties/attachment",
    multiple: false,
    mediaTypes: ["text/plain"],
    maxBytes: 100,
  };
  const operation = registered("test.upload", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: { attachment: { type: "object" } },
      },
      inputHandling: { rules: [fileRule] },
    },
  });
  const validator = ({ reference }: FileReferenceValidationRequest): readonly ValidationError[] =>
    reference.uploadId === "expired-upload"
      ? [{
          instancePath: "/attachment",
          schemaPath: "#/upload",
          keyword: "upload",
          message: "upload is expired",
          params: {},
        }]
      : [];
  const { manager, store } = harness([operation], { validateFileReference: validator });
  const baseFile: FileReference = {
    kind: "file",
    uploadId: "upload-1",
    name: "note.txt",
    mediaType: "text/plain",
    sizeBytes: 50,
    expiresAt: "2026-08-29T13:00:00Z",
  };

  const wrongMedia = await manager.create("test.upload", requestFor(operation, undefined, {
    attachment: { ...baseFile, mediaType: "application/pdf" },
  }));
  const tooLarge = await manager.create("test.upload", requestFor(operation, undefined, {
    attachment: { ...baseFile, sizeBytes: 101 },
  }));
  const expired = await manager.create("test.upload", requestFor(operation, undefined, {
    attachment: { ...baseFile, uploadId: "expired-upload" },
  }));

  for (const result of [wrongMedia, tooLarge, expired]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, 422);
  }
  assert.equal((await store.all()).length, 0);
});

test("file references are closed, strict RFC3339 values that must remain unexpired", async () => {
  const operation = registered("test.canonical-file", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: { attachment: { type: "object" } },
      },
      inputHandling: {
        rules: [{
          kind: "file",
          schemaPointer: "/properties/attachment",
          multiple: false,
        }],
      },
    },
  });
  const { manager, store } = harness([operation]);
  const validFile = {
    kind: "file",
    uploadId: "upload-1",
    name: "note.txt",
    mediaType: "text/plain",
    sizeBytes: 50,
    expiresAt: "2026-08-29T13:00:00Z",
  } as const;

  const extraMember = await manager.create("test.canonical-file", requestFor(operation, undefined, {
    attachment: { ...validFile, unexpected: "not canonical" },
  }));
  const nonRfc3339 = await manager.create("test.canonical-file", requestFor(operation, undefined, {
    attachment: { ...validFile, expiresAt: "2026-08-29 13:00:00Z" },
  }));
  const expired = await manager.create("test.canonical-file", requestFor(operation, undefined, {
    attachment: { ...validFile, expiresAt: "2026-08-29T12:00:00Z" },
  }));

  for (const result of [extraMember, nonRfc3339, expired]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, 422);
  }
  assert.equal((await store.all()).length, 0);
});

test("file validator receives operation binding and deterministic validation time", async () => {
  const operation = registered("test.bound-file", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: { attachment: { type: "object" } },
      },
      inputHandling: {
        rules: [{
          kind: "file",
          schemaPointer: "/properties/attachment",
          multiple: false,
        }],
      },
    },
  });
  let observed: FileReferenceValidationRequest | undefined;
  const { manager } = harness([operation], {
    validateFileReference: (request) => {
      observed = request;
      return request.operationId === "test.bound-file"
        && request.operationRevision === operation.definition.revision
        && request.validatedAt === "2026-08-29T12:00:00.000Z"
        ? []
        : [{
            instancePath: request.instancePath,
            schemaPath: "#/uploadBinding",
            keyword: "uploadBinding",
            message: "upload is bound to another operation",
            params: {},
          }];
    },
  });

  const result = await manager.create("test.bound-file", requestFor(operation, undefined, {
    attachment: {
      kind: "file",
      uploadId: "upload-1",
      name: "note.txt",
      mediaType: "text/plain",
      sizeBytes: 50,
      expiresAt: "2026-08-29T13:00:00Z",
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(observed?.operationId, "test.bound-file");
  assert.equal(observed?.operationRevision, operation.definition.revision);
  assert.equal(observed?.validatedAt, "2026-08-29T12:00:00.000Z");
});

test("file rules map supported schema compositions to exact instance paths", async () => {
  const dialect = "https://json-schema.org/draft/2020-12/schema" as const;
  const fileSchema = { type: "object" } as const;
  const vectors = [
    {
      id: "pointer.escaped",
      schema: { ...objectSchema, properties: { "a/b": fileSchema } },
      pointer: "/properties/a~1b",
      input: { "a/b": undefined },
      paths: ["/a~1b"],
    },
    {
      id: "pointer.all-of",
      schema: { ...objectSchema, allOf: [{ properties: { attachment: fileSchema } }] },
      pointer: "/allOf/0/properties/attachment",
      input: { attachment: undefined },
      paths: ["/attachment"],
    },
    {
      id: "pointer.any-of",
      schema: { ...objectSchema, anyOf: [{ properties: { attachment: fileSchema } }] },
      pointer: "/anyOf/0/properties/attachment",
      input: { attachment: undefined },
      paths: ["/attachment"],
    },
    {
      id: "pointer.one-of",
      schema: { ...objectSchema, oneOf: [{ properties: { attachment: fileSchema } }] },
      pointer: "/oneOf/0/properties/attachment",
      input: { attachment: undefined },
      paths: ["/attachment"],
    },
    {
      id: "pointer.dependent",
      schema: {
        ...objectSchema,
        dependentSchemas: { trigger: { properties: { attachment: fileSchema } } },
      },
      pointer: "/dependentSchemas/trigger/properties/attachment",
      input: { trigger: true, attachment: undefined },
      paths: ["/attachment"],
    },
    {
      id: "pointer.conditional",
      schema: {
        ...objectSchema,
        if: { properties: { trigger: { const: true } } },
        then: { properties: { attachment: fileSchema } },
      },
      pointer: "/then/properties/attachment",
      input: { trigger: true, attachment: undefined },
      paths: ["/attachment"],
    },
    {
      id: "pointer.local-ref",
      schema: {
        ...objectSchema,
        $defs: { upload: fileSchema },
        properties: { attachment: { $ref: "#/$defs/upload" } },
      },
      pointer: "/$defs/upload",
      input: { attachment: undefined },
      paths: ["/attachment"],
    },
    {
      id: "pointer.array",
      schema: {
        ...objectSchema,
        properties: { attachments: { type: "array", items: fileSchema } },
      },
      pointer: "/properties/attachments/items",
      input: { attachments: [undefined, undefined] },
      paths: ["/attachments/0", "/attachments/1"],
    },
  ] as const;
  const file = {
    kind: "file",
    uploadId: "upload-1",
    name: "note.txt",
    mediaType: "text/plain",
    sizeBytes: 50,
    expiresAt: "2026-08-29T13:00:00Z",
  } as const;
  const operations = vectors.map(({ id, schema, pointer }) => registered(id, {
    definition: {
      inputSchema: schema,
      inputHandling: { rules: [{ kind: "file", schemaPointer: pointer, multiple: false }] },
    },
  }));
  const observed = new Map<string, string[]>();
  const { manager } = harness(operations, {
    validateFileReference: ({ operationId, instancePath }) => {
      const paths = observed.get(operationId) ?? [];
      paths.push(instancePath);
      observed.set(operationId, paths);
      return [];
    },
  });

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index]!;
    const operation = operations[index]!;
    const input = structuredClone(vector.input) as Record<string, unknown>;
    if (vector.id === "pointer.array") {
      input.attachments = [file, { ...file, uploadId: "upload-2" }];
    } else if (vector.id === "pointer.escaped") {
      input["a/b"] = file;
    } else {
      input.attachment = file;
    }
    const result = await manager.create(vector.id, requestFor(operation, undefined, input as JsonObject));
    assert.equal(result.ok, true, vector.id);
    assert.deepEqual(observed.get(vector.id), vector.paths, vector.id);
  }

  const ambiguous = registered("pointer.ambiguous", {
    definition: {
      inputSchema: {
        $schema: dialect,
        type: "object",
        $defs: { upload: fileSchema },
        properties: {
          first: { $ref: "#/$defs/upload" },
          second: { $ref: "#/$defs/upload" },
        },
      },
      inputHandling: {
        rules: [{ kind: "file", schemaPointer: "/$defs/upload", multiple: false }],
      },
    },
  });
  const ambiguousHarness = harness([ambiguous]);
  const ambiguousResult = await ambiguousHarness.manager.create(
    "pointer.ambiguous",
    requestFor(ambiguous, undefined, { first: file, second: file }),
  );
  assert.equal(ambiguousResult.ok, false);
  if (!ambiguousResult.ok) {
    assert.equal(ambiguousResult.problem.errors?.[0]?.keyword, "schemaPointer");
    assert.match(ambiguousResult.problem.errors?.[0]?.message ?? "", /ambiguous/i);
  }
});

test("prefixItems file rules traverse the exact tuple index", async () => {
  const rule: Extract<InputHandlingRule, { kind: "file" }> = {
    kind: "file",
    schemaPointer: "/properties/tuple/prefixItems/0",
    multiple: false,
  };
  const operation = registered("test.tuple-file", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: {
          tuple: {
            type: "array",
            prefixItems: [{ type: "object" }],
            items: false,
          },
        },
      },
      inputHandling: { rules: [rule] },
    },
  });
  const validReference: FileReference = {
    kind: "file",
    uploadId: "upload-1",
    name: "tuple.txt",
    mediaType: "text/plain",
    sizeBytes: 10,
    expiresAt: "2026-08-29T13:00:00Z",
  };
  const observed: FileReferenceValidationRequest[] = [];
  const { manager, settle } = harness([operation], {
    validateFileReference: (request) => {
      observed.push(request);
      return [];
    },
  });

  const expired = await manager.create(operation.definition.id, requestFor(operation, undefined, {
    tuple: [{ ...validReference, expiresAt: "2026-08-29T11:00:00Z" }],
  }));
  const valid = await manager.create(operation.definition.id, requestFor(operation, undefined, {
    tuple: [validReference],
  }));

  assert.equal(expired.ok, false);
  assert.equal(valid.ok, true);
  assert.deepEqual(observed, [{
    reference: validReference,
    rule,
    instancePath: "/tuple/0",
    operationId: operation.definition.id,
    operationRevision: operation.definition.revision,
    validatedAt: "2026-08-29T12:00:01.000Z",
  }]);
  await settle();
});

test("items file rules skip tuple prefixes for direct and definition targets", async () => {
  const file = (uploadId: string): FileReference => ({
    kind: "file",
    uploadId,
    name: `${uploadId}.txt`,
    mediaType: "text/plain",
    sizeBytes: 10,
    expiresAt: "2026-08-29T13:00:00Z",
  });
  const direct = registered("items.direct-file-tail", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["tuple"],
        properties: {
          tuple: {
            type: "array",
            prefixItems: [{ type: "object" }, { type: "string" }],
            items: { type: "object" },
          },
        },
      },
      inputHandling: {
        rules: [
          {
            kind: "file",
            schemaPointer: "/properties/tuple/prefixItems/0",
            multiple: false,
          },
          {
            kind: "file",
            schemaPointer: "/properties/tuple/items",
            multiple: false,
          },
        ],
      },
    },
  });
  const byDefinition = registered("items.definition-file-tail", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["tuple"],
        properties: {
          tuple: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            items: { $ref: "#/$defs/tailFile" },
          },
        },
        $defs: { tailFile: { type: "object" } },
      },
      inputHandling: {
        rules: [{
          kind: "file",
          schemaPointer: "/$defs/tailFile",
          multiple: false,
        }],
      },
    },
  });
  const observed = new Map<string, string[]>();
  const { manager, settle } = harness([direct, byDefinition], {
    validateFileReference: ({ operationId, instancePath }) => {
      const paths = observed.get(operationId) ?? [];
      paths.push(instancePath);
      observed.set(operationId, paths);
      return [];
    },
  });

  const directResult = await manager.create(direct.definition.id, requestFor(direct, undefined, {
    tuple: [file("prefix"), "public-header", file("tail-1"), file("tail-2")],
  }));
  const definitionResult = await manager.create(
    byDefinition.definition.id,
    requestFor(byDefinition, undefined, {
      tuple: ["public-header", 7.5, file("tail-3"), file("tail-4")],
    }),
  );

  assert.equal(directResult.ok, true);
  assert.equal(definitionResult.ok, true);
  assert.deepEqual(observed.get(direct.definition.id), [
    "/tuple/0",
    "/tuple/2",
    "/tuple/3",
  ]);
  assert.deepEqual(observed.get(byDefinition.definition.id), ["/tuple/2", "/tuple/3"]);
  await settle();
});

test("items secret rules contain only tuple tails for direct and definition targets", async () => {
  const publicValues = ["public-prefix-a", "public-prefix-b"] as const;
  const tailSecrets = ["tail-secret-a", "tail-secret-b"] as const;
  const makeOperation = (id: string, byDefinition: boolean) => registered(id, {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["mode", "tuple"],
        properties: {
          mode: { type: "string" },
          tuple: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "string" }],
            items: byDefinition ? { $ref: "#/$defs/tailSecret" } : { type: "string" },
          },
        },
        ...(byDefinition ? { $defs: { tailSecret: { type: "string" } } } : {}),
      },
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: byDefinition ? "/$defs/tailSecret" : "/properties/tuple/items",
          retention: "none",
        }],
      },
    },
    handler: (input) => {
      const tuple = input.tuple as JsonValue[];
      return {
        output: input.mode === "leak"
          ? { tail: tuple[2] }
          : { prefix: [tuple[0], tuple[1]] },
      };
    },
  });
  const operations = [
    makeOperation("items.direct-secret-tail", false),
    makeOperation("items.definition-secret-tail", true),
  ];
  const { manager, store, settle } = harness(operations);
  const created = [];
  for (const operation of operations) {
    created.push(await manager.create(operation.definition.id, requestFor(operation, undefined, {
      mode: "safe",
      tuple: [...publicValues, ...tailSecrets],
    })));
    created.push(await manager.create(operation.definition.id, requestFor(operation, undefined, {
      mode: "leak",
      tuple: [...publicValues, ...tailSecrets],
    })));
  }
  await settle();

  assert.equal(created.every(({ ok }) => ok), true);
  const states = await Promise.all(created.map(async (result) =>
    result.ok ? (await store.history(result.run.id)).at(-1)?.state : undefined));
  assert.deepEqual(states, ["succeeded", "failed", "succeeded", "failed"]);
  for (let index = 0; index < created.length; index += 1) {
    const result = created[index]!;
    if (!result.ok) continue;
    const history = JSON.stringify(await store.history(result.run.id));
    for (const secret of tailSecrets) assert.equal(history.includes(secret), false);
    if (index % 2 === 0) {
      for (const value of publicValues) assert.equal(history.includes(value), true);
    }
  }
});

test("named boolean definition targets resolve true locations and ignore false locations", async () => {
  const fileReference: FileReference = {
    kind: "file",
    uploadId: "boolean-upload",
    name: "boolean.txt",
    mediaType: "text/plain",
    sizeBytes: 10,
    expiresAt: "2026-08-29T13:00:00Z",
  };
  const fileOperation = registered("boolean.file-targets", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["attachment"],
        properties: {
          attachment: { $ref: "#/$defs/allowedSlot" },
          impossible: { $ref: "#/$defs/impossibleSlot" },
        },
        $defs: {
          allowedSlot: true,
          impossibleSlot: false,
        },
      },
      inputHandling: {
        rules: [
          { kind: "file", schemaPointer: "/$defs/allowedSlot", multiple: false },
          { kind: "file", schemaPointer: "/$defs/impossibleSlot", multiple: false },
        ],
      },
    },
  });
  const secret = "boolean-definition-secret";
  const secretOperation = registered("boolean.secret-targets", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["mode", "token"],
        properties: {
          mode: { type: "string" },
          token: { $ref: "#/$defs/allowedSecret" },
          impossible: { $ref: "#/$defs/impossibleSecret" },
        },
        $defs: {
          allowedSecret: true,
          impossibleSecret: false,
        },
      },
      inputHandling: {
        rules: [
          { kind: "secret", schemaPointer: "/$defs/allowedSecret", retention: "none" },
          { kind: "secret", schemaPointer: "/$defs/impossibleSecret", retention: "none" },
        ],
      },
    },
    handler: (input) => ({
      output: input.mode === "leak" ? { echoed: input.token } : { safe: true },
    }),
  });
  const observed: string[] = [];
  const { manager, store, settle } = harness([fileOperation, secretOperation], {
    validateFileReference: ({ instancePath }) => {
      observed.push(instancePath);
      return [];
    },
  });

  const fileCreated = await manager.create(
    fileOperation.definition.id,
    requestFor(fileOperation, undefined, { attachment: fileReference }),
  );
  const secretSafe = await manager.create(
    secretOperation.definition.id,
    requestFor(secretOperation, undefined, { mode: "safe", token: secret }),
  );
  const secretLeak = await manager.create(
    secretOperation.definition.id,
    requestFor(secretOperation, undefined, { mode: "leak", token: secret }),
  );
  assert.equal(fileCreated.ok, true);
  assert.equal(secretSafe.ok, true);
  assert.equal(secretLeak.ok, true);
  assert.deepEqual(observed, ["/attachment"]);
  await settle();

  if (!fileCreated.ok || !secretSafe.ok || !secretLeak.ok) return;
  assert.equal((await store.history(fileCreated.run.id)).at(-1)?.state, "succeeded");
  assert.equal((await store.history(secretSafe.run.id)).at(-1)?.state, "succeeded");
  assert.equal((await store.history(secretLeak.run.id)).at(-1)?.state, "failed");
  assert.equal(JSON.stringify(await store.history(secretSafe.run.id)).includes(secret), false);
  assert.equal(JSON.stringify(await store.history(secretLeak.run.id)).includes(secret), false);
});

test("transitive encoded local refs and items map to concrete file paths", async () => {
  const rule: Extract<InputHandlingRule, { kind: "file" }> = {
    kind: "file",
    schemaPointer: "/$defs/file~1target",
    multiple: false,
  };
  const operation = registered("test.transitive-file-ref", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: {
          files: {
            type: "array",
            items: { $ref: "#/%24defs/alias%20schema" },
          },
        },
        $defs: {
          "file/target": { type: "object" },
          "alias schema": { $ref: "#/%24defs/file~1target" },
        },
      },
      inputHandling: { rules: [rule] },
    },
  });
  const reference: FileReference = {
    kind: "file",
    uploadId: "upload-1",
    name: "nested.txt",
    mediaType: "text/plain",
    sizeBytes: 12,
    expiresAt: "2026-08-29T13:00:00Z",
  };
  const observed: FileReferenceValidationRequest[] = [];
  const { manager, settle } = harness([operation], {
    validateFileReference: (request) => {
      observed.push(request);
      return [];
    },
  });

  const result = await manager.create(operation.definition.id, requestFor(operation, undefined, {
    files: [reference],
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(observed, [{
    reference,
    rule,
    instancePath: "/files/0",
    operationId: operation.definition.id,
    operationRevision: operation.definition.revision,
    validatedAt: "2026-08-29T12:00:00.000Z",
  }]);
  await settle();
});

test("productive recursive rules validate every finite file location", async () => {
  let handlerCalls = 0;
  const fileRule: Extract<InputHandlingRule, { kind: "file" }> = {
    kind: "file",
    schemaPointer: "/$defs/node/properties/attachment",
    multiple: false,
  };
  const operation = registered("test.recursive-files", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["root"],
        properties: { root: { $ref: "#/$defs/node" } },
        $defs: {
          node: {
            type: "object",
            required: ["token", "attachment", "next", "children"],
            properties: {
              token: { type: "string" },
              attachment: { type: "object" },
              next: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] },
              children: { type: "array", items: { $ref: "#/$defs/node" } },
            },
          },
        },
      },
      inputHandling: { rules: [fileRule] },
    },
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const file = (uploadId: string, expiresAt = "2026-08-29T13:00:00Z"): FileReference => ({
    kind: "file",
    uploadId,
    name: `${uploadId}.txt`,
    mediaType: "text/plain",
    sizeBytes: 12,
    expiresAt,
  });
  const finiteInput = (nestedExpiry = "2026-08-29T13:00:00Z"): JsonObject => ({
    root: {
      token: "root-token",
      attachment: file("root"),
      next: {
        token: "next-token",
        attachment: file("next", nestedExpiry),
        next: {
          token: "deep-token",
          attachment: file("deep"),
          next: null,
          children: [],
        },
        children: [],
      },
      children: [{
        token: "child-token",
        attachment: file("child"),
        next: null,
        children: [],
      }],
    },
  });
  const observed: string[] = [];
  let scheduled = 0;
  const { manager, store } = harness([operation], {
    validateFileReference: ({ instancePath }) => {
      observed.push(instancePath);
      return [];
    },
    schedule: () => {
      scheduled += 1;
    },
  });

  const expired = await manager.create(
    operation.definition.id,
    requestFor(operation, undefined, finiteInput("2026-08-29T11:59:59Z")),
  );

  assert.equal(expired.ok, false);
  assert.equal(handlerCalls, 0);
  assert.equal(scheduled, 0);
  assert.deepEqual(await store.all(), []);

  observed.length = 0;
  const valid = await manager.create(
    operation.definition.id,
    requestFor(operation, undefined, finiteInput()),
  );

  assert.equal(valid.ok, true);
  assert.deepEqual(observed, [
    "/root/attachment",
    "/root/next/attachment",
    "/root/next/next/attachment",
    "/root/children/0/attachment",
  ]);
});

test("productive recursive secret rules contain every finite secret", async () => {
  const secrets = ["root-secret", "next-secret", "deep-secret", "child-secret"] as const;
  const operation = registered("test.recursive-secrets", {
    definition: {
      inputSchema: {
        ...objectSchema,
        required: ["root"],
        properties: { root: { $ref: "#/$defs/node" } },
        $defs: {
          node: {
            type: "object",
            required: ["token", "next", "children"],
            properties: {
              token: { type: "string" },
              next: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] },
              children: { type: "array", items: { $ref: "#/$defs/node" } },
            },
          },
        },
      },
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: "/$defs/node/properties/token",
          retention: "none",
        }],
      },
    },
    handler: (input) => ({
      output: {
        echoed: [
          ((input.root as JsonObject).next as JsonObject).token,
          (((input.root as JsonObject).next as JsonObject).next as JsonObject).token,
          (((input.root as JsonObject).children as JsonObject[])[0] as JsonObject).token,
        ],
      },
    }),
  });
  const input: JsonObject = {
    root: {
      token: secrets[0],
      next: {
        token: secrets[1],
        next: { token: secrets[2], next: null, children: [] },
        children: [],
      },
      children: [{ token: secrets[3], next: null, children: [] }],
    },
  };
  const { manager, store, settle } = harness([operation]);

  const created = await manager.create(
    operation.definition.id,
    requestFor(operation, undefined, input),
  );
  assert.equal(created.ok, true);
  await settle();

  if (!created.ok) return;
  const history = await store.history(created.run.id);
  assert.equal(history.at(-1)?.state, "failed");
  for (const snapshot of history) {
    for (const secret of secrets) assert.equal(JSON.stringify(snapshot).includes(secret), false);
  }
});

test("secret values are removed from validation Problems and every stored snapshot", async () => {
  const secret = "s3cr3t-token";
  const secretRule: Extract<InputHandlingRule, { kind: "secret" }> = {
    kind: "secret",
    schemaPointer: "/properties/token",
    retention: "none",
  };
  const operation = registered("test.secret", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: { token: { type: "string" } },
      },
      inputHandling: { rules: [secretRule] },
    },
    handler: (input, context) => {
      context.report({ message: `working with ${String(input.token)}` });
      context.log({
        level: "info",
        message: `log ${String(input.token)}`,
        fields: { credential: input.token },
      });
      context.warn(`warning ${String(input.token)}`);
      context.addArtifact({
        id: "handler-artifact",
        kind: "notice",
        level: "info",
        message: `artifact ${String(input.token)}`,
      });
      context.addAction({
        kind: "open-link",
        label: `link ${String(input.token)}`,
        url: `https://example.test/?token=${String(input.token)}`,
      });
      return {
        summary: { title: "done", message: `summary ${String(input.token)}`, tone: "success" },
        output: { echoed: input.token },
        artifacts: [{
          id: "result-artifact",
          kind: "json",
          value: { leaked: input.token },
        }],
        actions: [{
          kind: "open-link",
          label: "result",
          url: `https://example.test/${String(input.token)}`,
        }],
      };
    },
  });
  const { manager, store, settle } = harness([operation]);

  const validationManager = harness([operation], {
    validateSchema: ({ subject, value }: SchemaValidationRequest) => subject === "input"
      ? [{
          instancePath: "/token",
          schemaPath: "#/properties/token",
          keyword: "custom",
          message: `rejected ${String(value.token)}`,
          params: { rejected: value.token },
        }]
      : [],
  });
  const invalid = await validationManager.manager.create(
    "test.secret",
    requestFor(operation, undefined, { token: secret }),
  );
  assert.equal(invalid.ok, false);
  assert.equal(JSON.stringify(invalid).includes(secret), false);
  assert.equal((await validationManager.store.all()).length, 0);

  const created = await manager.create(
    "test.secret",
    requestFor(operation, undefined, { token: secret }),
  );
  assert.equal(created.ok, true);
  await settle();
  assert.equal(created.ok && JSON.stringify(await store.history(created.run.id)).includes(secret), false);
});

test("validators and handlers receive one deeply immutable snapshot of caller input", async () => {
  let validationStarted!: () => void;
  let releaseValidation!: () => void;
  const started = new Promise<void>((resolve) => { validationStarted = resolve; });
  const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  let inputWasFrozen = false;
  let contextWasFrozen = false;
  let validatorMutationBlocked = false;
  let handlerMutationBlocked = false;
  let handlerToken: unknown;
  let handlerNested: unknown;
  const operation = registered("test.snapshot", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: {
          token: { type: "string" },
          nested: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      },
      contextSchema: objectSchema,
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: "/properties/token",
          retention: "none",
        }],
      },
    },
    handler: (input) => {
      handlerToken = input.token;
      handlerNested = (input.nested as JsonObject).value;
      try {
        (input as { token: string }).token = "handler-mutated-secret";
      } catch {
        handlerMutationBlocked = true;
      }
      try {
        (input.nested as { value: string }).value = "handler-mutated-nested";
      } catch {
        handlerMutationBlocked = true;
      }
      return { output: { safe: "done" } };
    },
  });
  const input = {
    token: "validated-secret",
    nested: { value: "validated-nested" },
  };
  const context = {
    requestId: "request-1",
    actor: { id: "actor-1", displayName: "Original actor" },
  };
  const { manager, store, settle } = harness([operation], {
    validateSchema: async ({ subject, value }) => {
      if (subject === "input") {
        inputWasFrozen = Object.isFrozen(value) && Object.isFrozen(value.nested);
        validationStarted();
        await validationGate;
        try {
          (value as { token: string }).token = "validator-mutated-secret";
          (value.nested as { value: string }).value = "validator-mutated-nested";
        } catch {
          validatorMutationBlocked = true;
        }
      } else {
        contextWasFrozen = Object.isFrozen(value) && Object.isFrozen(value.actor);
      }
      return [];
    },
  });

  const creating = manager.create("test.snapshot", {
    ...requestFor(operation, undefined, input),
    context,
  });
  await started;
  input.token = "caller-mutated-secret";
  input.nested.value = "caller-mutated-nested";
  context.actor.displayName = "Caller-mutated actor";
  releaseValidation();

  const created = await creating;
  assert.equal(created.ok, true);
  await settle();
  if (!created.ok) return;

  assert.equal(inputWasFrozen, true);
  assert.equal(contextWasFrozen, true);
  assert.equal(validatorMutationBlocked, true);
  assert.equal(handlerMutationBlocked, true);
  assert.equal(handlerToken, "validated-secret");
  assert.equal(handlerNested, "validated-nested");
  assert.equal(input.token, "caller-mutated-secret");
  assert.equal(input.nested.value, "caller-mutated-nested");
  const history = JSON.stringify(await store.history(created.run.id));
  for (const secret of [
    "validated-secret",
    "caller-mutated-secret",
    "validator-mutated-secret",
    "handler-mutated-secret",
  ]) {
    assert.equal(history.includes(secret), false);
  }
});

test("handlers receive the full owned invocation context and undefined when absent", async () => {
  const validationStarted = deferred();
  const allowValidation = deferred();
  const callerContext = structuredClone(fullInvocationContextFixture);
  const expectedContext = structuredClone(fullInvocationContextFixture);
  let observedContext: InvocationContext | undefined;
  let absentContext: InvocationContext | undefined = fullInvocationContextFixture;
  const withContext = registered("test.invocation-context-owned", {
    definition: { contextSchema: objectSchema },
    handler: (_input, context) => {
      observedContext = context.invocationContext;
      assert.deepEqual(observedContext, expectedContext);
      assert.notEqual(observedContext, callerContext);
      assert.notEqual(observedContext?.actor, callerContext.actor);
      assert.notEqual(observedContext?.target, callerContext.target);
      assert.notEqual(observedContext?.extensions, callerContext.extensions);
      assert.notEqual(
        observedContext?.extensions?.["urn:test:invocation-context"],
        callerContext.extensions["urn:test:invocation-context"],
      );
      assertDeepPlainFrozen(observedContext);
      assert.throws(() => {
        (observedContext!.actor as { displayName: string }).displayName = "handler actor";
      }, TypeError);
      assert.throws(() => {
        (observedContext!.target as { environment: string }).environment = "production";
      }, TypeError);
      assert.throws(() => {
        (observedContext!.extensions!["urn:test:invocation-context"] as { sentinel: string }).sentinel = "changed";
      }, TypeError);
      assert.deepEqual(observedContext, expectedContext);
      return { output: {} };
    },
  });
  const withoutContext = registered("test.invocation-context-absent", {
    handler: (_input, context) => {
      assert.equal(Object.hasOwn(context, "invocationContext"), true);
      assert.equal(
        typeof Object.getOwnPropertyDescriptor(context, "invocationContext")?.get,
        "function",
      );
      absentContext = context.invocationContext;
      return { output: {} };
    },
  });
  const { manager, settle } = harness([withContext, withoutContext], {
    validateSchema: async ({ subject }) => {
      if (subject === "input") {
        validationStarted.resolve();
        await allowValidation.promise;
      }
      return [];
    },
  });

  const creating = manager.create(withContext.definition.id, {
    ...requestFor(withContext),
    context: callerContext,
  });
  await validationStarted.promise;
  callerContext.actor.displayName = "caller actor";
  callerContext.target.environment = "production";
  callerContext.extensions["urn:test:invocation-context"].sentinel = "caller changed";
  allowValidation.resolve();

  const createdWithContext = await creating;
  assert.equal(createdWithContext.ok, true);
  await settle();
  assert.deepEqual(observedContext, expectedContext);

  const createdWithoutContext = await manager.create(
    withoutContext.definition.id,
    requestFor(withoutContext),
  );
  assert.equal(createdWithoutContext.ok, true);
  await settle();
  assert.equal(absentContext, undefined);
});

test("invocation context accessor is immutable and non-enumerable", async () => {
  const operation = registered("test.invocation-context-accessor", {
    handler: (_input, context) => {
      const descriptor = Object.getOwnPropertyDescriptor(context, "invocationContext");
      assert.equal(typeof descriptor?.get, "function");
      assert.equal(descriptor?.set, undefined);
      assert.equal(descriptor?.enumerable, false);
      assert.equal(descriptor?.configurable, false);
      assert.equal(Reflect.set(context, "invocationContext", undefined), false);
      assert.equal(Reflect.defineProperty(context, "invocationContext", { value: undefined }), false);
      assert.deepEqual(context.invocationContext, fullInvocationContextFixture);
      return { output: {} };
    },
  });
  const { manager, settle } = harness([operation]);

  const created = await manager.create(operation.definition.id, {
    ...requestFor(operation),
    context: fullInvocationContextFixture,
  });
  assert.equal(created.ok, true);
  await settle();
  assert.equal((await manager.get(created.ok ? created.run.id : "missing"))?.state, "succeeded");
});

test("secret collision values preserve wire discriminants while composite echoes fail safely", async () => {
  const operation = registered("test.secret-collisions", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: {
          mode: { type: "string" },
          payload: { type: "object" },
        },
      },
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: "/properties/payload",
          retention: "none",
        }],
      },
    },
    handler: (input, context) => {
      if (input.mode === "leak") {
        return { output: { echoed: input.payload } };
      }
      context.addArtifact({
        id: "artifact-1",
        kind: "notice",
        level: "info",
        message: "Safe progress",
      });
      context.log({ level: "info", message: "Safe structured log" });
      return {
        outcome: "partial",
        problem: {
          type: "urn:gauntlet:problem:adapter-internal-error",
          title: "Some work remains",
          status: 500,
        },
        output: { safe: "done" },
      };
    },
  });
  const { manager, store, settle } = harness([operation]);
  const compositeSecret = {
    "sensitive-name": "ordinary",
    values: [
      "partial",
      "notice",
      "urn:gauntlet:artifact:structured-log",
      500,
      true,
      "",
      null,
      "[REDACTED]",
    ],
  };

  const clean = await manager.create("test.secret-collisions", requestFor(operation, undefined, {
    mode: "clean",
    payload: compositeSecret,
  }));
  const contaminated = await manager.create("test.secret-collisions", requestFor(operation, undefined, {
    mode: "leak",
    payload: compositeSecret,
  }));
  assert.equal(clean.ok, true);
  assert.equal(contaminated.ok, true);
  await settle();
  if (!clean.ok || !contaminated.ok) return;

  const cleanTerminal = await manager.get(clean.run.id);
  assert.equal(cleanTerminal?.state, "partial");
  if (cleanTerminal?.state === "partial") {
    assert.equal(cleanTerminal.problem.status, 500);
    assert.equal(typeof cleanTerminal.problem.status, "number");
    assert.equal(cleanTerminal.artifacts[0]?.kind, "notice");
    assert.equal(cleanTerminal.artifacts[1]?.kind, "urn:gauntlet:artifact:structured-log");
  }

  const contaminatedTerminal = await manager.get(contaminated.run.id);
  assert.equal(contaminatedTerminal?.state, "failed");
  const contaminatedHistory = JSON.stringify(await store.history(contaminated.run.id));
  for (const fragment of ["sensitive-name", "ordinary", "[REDACTED]"]) {
    assert.equal(contaminatedHistory.includes(fragment), false);
  }
});

test("producer-controlled Problem and Artifact URNs cannot contain secret input", async () => {
  const secret = "producer-secret";
  const inputDefinition = {
    inputSchema: {
      ...objectSchema,
      properties: { token: { type: "string" } },
    },
    inputHandling: {
      rules: [{
        kind: "secret",
        schemaPointer: "/properties/token",
        retention: "none",
      }],
    },
  } as const;
  const maliciousProblem: Problem = {
    type: `urn:gauntlet:problem:${secret}`,
    title: "Producer problem",
    status: 500,
  };
  const maliciousArtifact: Artifact = {
    id: "artifact-1",
    kind: `urn:test:${secret}`,
    data: { safe: true },
  };
  const problemOperation = registered("test.secret-problem-urn", {
    definition: inputDefinition,
    handler: () => ({ outcome: "partial", problem: maliciousProblem, output: {} }),
  });
  const artifactOperation = registered("test.secret-artifact-urn", {
    definition: inputDefinition,
    handler: () => ({ artifacts: [maliciousArtifact], output: {} }),
  });
  const validateProblem = await canonicalCommonValidator("problem");
  const validateArtifact = await canonicalCommonValidator("artifact");
  assert.equal(validateProblem(maliciousProblem), true, JSON.stringify(validateProblem.errors));
  assert.equal(validateArtifact(maliciousArtifact), true, JSON.stringify(validateArtifact.errors));

  const { manager, store, settle } = harness([problemOperation, artifactOperation]);
  const created = await Promise.all([problemOperation, artifactOperation].map((operation) =>
    manager.create(operation.definition.id, requestFor(operation, undefined, { token: secret }))));
  assert.equal(created.every(({ ok }) => ok), true);
  await settle();

  const terminals = await Promise.all(created.map((result) =>
    result.ok ? manager.get(result.run.id) : undefined));
  assert.deepEqual(terminals.map((run) => run?.state), ["failed", "failed"]);
  const validateRun = await canonicalRunValidator();
  for (const result of created) {
    if (!result.ok) continue;
    for (const snapshot of await store.history(result.run.id)) {
      assert.equal(validateRun(snapshot), true, JSON.stringify(validateRun.errors));
      assert.equal(JSON.stringify(snapshot).includes(secret), false);
      if (snapshot.problem !== undefined) {
        assert.equal(validateProblem(snapshot.problem), true, JSON.stringify(validateProblem.errors));
      }
      for (const artifact of snapshot.artifacts) {
        assert.equal(validateArtifact(artifact), true, JSON.stringify(validateArtifact.errors));
      }
    }
  }
});

test("invalid operation result union members fail before result side effects", async () => {
  const producerProblem: Problem = {
    type: "urn:gauntlet:problem:adapter-internal-error",
    title: "Producer problem",
    status: 500,
  };
  const invalidResults: readonly unknown[] = [
    null,
    { outcome: "failed", problem: producerProblem, output: {} },
    { outcome: null, output: {} },
    { problem: producerProblem, output: {} },
    { outcome: "succeeded", problem: producerProblem, output: {} },
    { outcome: "partial", output: {} },
    {
      outcome: "succeeded",
      unexpected: true,
      artifacts: [{
        id: "must-not-persist",
        kind: "notice",
        level: "info",
        message: "Invalid result side effect",
      }],
      output: {},
    },
    { outcome: "succeeded", artifacts: {}, output: {} },
    { outcome: "succeeded", summary: { title: "Bad tone", tone: "unknown" }, output: {} },
  ];
  const operations = invalidResults.map((result, index) => registered(`result.invalid-${index}`, {
    handler: () => result as never,
  }));
  const { manager, store, settle } = harness(operations);

  const created = await Promise.all(operations.map((operation) =>
    manager.create(operation.definition.id, requestFor(operation))));
  assert.equal(created.every(({ ok }) => ok), true);
  await settle();

  const validateRun = await canonicalRunValidator();
  for (const result of created) {
    if (!result.ok) continue;
    const history = await store.history(result.run.id);
    const terminal = history.at(-1);
    assert.equal(terminal?.state, "failed", result.run.operationId);
    assert.equal(terminal?.problem?.type, "urn:gauntlet:problem:handler-failed");
    assert.deepEqual(terminal?.artifacts, []);
    for (const snapshot of history) {
      assert.equal(validateRun(snapshot), true, JSON.stringify(validateRun.errors));
      assert.equal(JSON.stringify(snapshot).includes("Producer problem"), false);
      assert.equal(JSON.stringify(snapshot).includes("must-not-persist"), false);
    }
  }
});

test("valid implicit success, explicit success, and partial results retain their states", async () => {
  const partialProblem: Problem = {
    type: "urn:gauntlet:problem:adapter-internal-error",
    title: "Partial producer result",
    status: 500,
  };
  const operations = [
    registered("result.valid-implicit", { handler: () => ({ output: { mode: "implicit" } }) }),
    registered("result.valid-explicit", {
      handler: () => ({ outcome: "succeeded", output: { mode: "explicit" } }),
    }),
    registered("result.valid-partial", {
      handler: () => ({ outcome: "partial", problem: partialProblem, output: { mode: "partial" } }),
    }),
  ];
  const { manager, store, settle } = harness(operations);

  const created = await Promise.all(operations.map((operation) =>
    manager.create(operation.definition.id, requestFor(operation))));
  await settle();

  assert.equal(created.every(({ ok }) => ok), true);
  const terminalStates = await Promise.all(created.map(async (result) =>
    result.ok ? (await store.history(result.run.id)).at(-1)?.state : undefined));
  assert.deepEqual(terminalStates, ["succeeded", "succeeded", "partial"]);
});

test("producer-controlled values never persist a noncanonical Run or invalid output", async () => {
  const outputSchema = {
    ...objectSchema,
    required: ["ok"],
    properties: { ok: { type: "string" } },
    additionalProperties: false,
  } as const;
  const operations = [
    registered("invalid.progress", {
      handler: (_input, context) => {
        context.report({ current: Number.NaN } as never);
        return { output: {} };
      },
    }),
    registered("invalid.artifact", {
      handler: (_input, context) => {
        context.addArtifact({
          id: "unsafe/id",
          kind: "notice",
          level: "info",
          message: "unsafe",
        });
        return { output: {} };
      },
    }),
    registered("invalid.action", {
      handler: () => ({
        output: {},
        actions: [{ kind: "open-link", label: "Unsafe", url: "javascript:alert(1)" }],
      }),
    }),
    registered("invalid.problem", {
      handler: () => ({
        outcome: "partial",
        problem: {
          type: "urn:gauntlet:problem:adapter-internal-error",
          title: "Invalid status",
          status: 42,
        },
        output: {},
      }),
    }),
    registered("invalid.output", {
      definition: { output: { schema: outputSchema } },
      handler: () => ({ output: { ok: 42 } }),
    }),
  ];
  const { manager, store, settle } = harness(operations);
  const created = await Promise.all(operations.map((operation) =>
    manager.create(operation.definition.id, requestFor(operation))));
  assert.equal(created.every(({ ok }) => ok), true);
  await settle();

  const validateRun = await canonicalRunValidator();
  for (const result of created) {
    if (!result.ok) continue;
    const terminal = await manager.get(result.run.id);
    assert.equal(terminal?.state, "failed", result.run.operationId);
    for (const snapshot of await store.history(result.run.id)) {
      assert.equal(validateRun(snapshot), true, `${result.run.operationId}: ${JSON.stringify(validateRun.errors)}`);
      assert.equal(JSON.stringify(snapshot).includes("javascript:alert(1)"), false);
    }
  }
});

test("producer progress bounds fail before a permissive custom store sees the invalid snapshot", async () => {
  const operation = registered("invalid.progress-bounds", {
    handler: (_input, context) => {
      context.report({ current: 2, total: 1 });
      return { output: {} };
    },
  });
  const history: Run[] = [];
  const store: RunStore = {
    create: async (run) => { history.push(run); },
    get: async () => history.at(-1),
    findByIdempotencyKey: async () => undefined,
    update: async (run) => { history.push(run); },
  };
  const { manager, settle } = harness([operation], {}, store);

  const created = await manager.create(operation.definition.id, requestFor(operation));
  assert.equal(created.ok, true);
  await settle();

  assert.equal(history.some(({ progress }) => progress?.current === 2 && progress.total === 1), false);
  assert.equal(history.at(-1)?.state, "failed");
});

test("request input and context reject non-plain JSON before schema validation", async () => {
  let handlerCalls = 0;
  let validatorCalls = 0;
  const operation = registered("invalid.request-json", {
    handler: () => {
      handlerCalls += 1;
      return { output: {} };
    },
  });
  const customPrototype = Object.assign(Object.create({ inherited: true }), { value: "custom" });
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => "accessed" });
  const symbolProperty = { value: "visible" } as Record<PropertyKey, unknown>;
  symbolProperty[Symbol("hidden")] = "symbol";
  const sparse = new Array(1);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const inputValues: readonly unknown[] = [
    new Date("2026-08-29T12:00:00Z"),
    new Map([["key", "value"]]),
    new Set(["value"]),
    /value/u,
    new Uint8Array([1, 2]),
    customPrototype,
    accessor,
    symbolProperty,
    undefined,
    sparse,
    cyclic,
  ];
  const { manager, store, settle } = harness([operation], {
    validateSchema: (request) => {
      validatorCalls += 1;
      return requiredPropertyValidator(request);
    },
  });

  const results = [];
  for (const value of inputValues) {
    results.push(await manager.create(operation.definition.id, {
      operationRevision: operation.definition.revision,
      input: { value } as never,
    }));
  }
  results.push(await manager.create(operation.definition.id, {
    operationRevision: operation.definition.revision,
    input: {},
    context: {
      requestId: "request-1",
      extensions: { "urn:test:non-json": new Date("2026-08-29T12:00:00Z") },
    } as never,
  }));
  await settle();

  assert.equal(results.every(({ ok }) => !ok), true);
  assert.equal(validatorCalls, 0);
  assert.equal(handlerCalls, 0);
  assert.deepEqual(await store.all(), []);
});

test("producer payload surfaces reject exotic objects without persisting them", async () => {
  const target = registered("invalid-json.target");
  let actionKindReads = 0;
  const operations = [
    registered("invalid-json.output", {
      handler: () => ({ output: new Date("2026-08-29T12:00:00Z") as never }),
    }),
    registered("invalid-json.progress", {
      handler: (_input, context) => {
        context.report({
          current: 1,
          extensions: { "urn:test:non-json": new Map([["key", "value"]]) },
        } as never);
        return { output: {} };
      },
    }),
    registered("invalid-json.artifact", {
      handler: () => ({
        artifacts: [{
          id: "artifact-1",
          kind: "urn:test:artifact:custom",
          data: new Set(["value"]),
        } as never],
        output: {},
      }),
    }),
    registered("invalid-json.action", {
      handler: (_input, context) => {
        const action = {
          label: "Invoke",
          operationId: target.definition.id,
          input: { pattern: /value/u },
        } as Record<string, unknown>;
        Object.defineProperty(action, "kind", {
          enumerable: true,
          get: () => {
            actionKindReads += 1;
            return "invoke-operation";
          },
        });
        context.addAction(action as never);
        return { output: {} };
      },
    }),
    registered("invalid-json.log", {
      handler: (_input, context) => {
        context.log({
          level: "info",
          message: "binary",
          fields: { binary: new Uint8Array([1, 2]) },
        } as never);
        return { output: {} };
      },
    }),
  ];
  const { manager, store, settle } = harness([target, ...operations]);
  const created = await Promise.all(operations.map((operation) =>
    manager.create(operation.definition.id, requestFor(operation))));
  assert.equal(created.every(({ ok }) => ok), true);
  await settle();
  assert.equal(actionKindReads, 0);

  for (const result of created) {
    if (!result.ok) continue;
    const terminal = await manager.get(result.run.id);
    assert.equal(terminal?.state, "failed", result.run.operationId);
    for (const snapshot of await store.history(result.run.id)) {
      assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
      assertDeepPlainFrozen(snapshot);
    }
  }
});

test("in-memory store rejects exotic Run values and owns round-tripping snapshots", async () => {
  const store = new InMemoryRunStore();
  const queued: Run = {
    id: "run-plain-json",
    operationId: "test.echo",
    operationRevision: `sha256:${"a".repeat(64)}`,
    state: "queued",
    sequence: 0,
    createdAt: "2026-08-29T12:00:00Z",
    updatedAt: "2026-08-29T12:00:00Z",
    artifacts: [],
    actions: [],
    extensions: { "urn:test:nested": { values: [1, "two", null] } },
  };

  await assert.rejects(store.create({
    ...queued,
    id: "run-exotic",
    extensions: { "urn:test:non-json": new Date("2026-08-29T12:00:00Z") },
  } as never), /canonical|JSON|plain/i);
  let stateReads = 0;
  const accessorRun = { ...queued, id: "run-accessor" } as Record<string, unknown>;
  Object.defineProperty(accessorRun, "state", {
    enumerable: true,
    get: () => {
      stateReads += 1;
      return "queued";
    },
  });
  await assert.rejects(store.create(accessorRun as never), /canonical|JSON|plain/i);
  assert.equal(stateReads, 0);
  await store.create(queued);

  const snapshot = await store.get(queued.id);
  assert.notEqual(snapshot, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assertDeepPlainFrozen(snapshot);
  assert.deepEqual(await store.all(), [snapshot!]);
});

test("in-memory store rejects backwards timestamps", async () => {
  const store = new InMemoryRunStore();
  const queued: Run = {
    id: "run-1",
    operationId: "test.echo",
    operationRevision: `sha256:${"a".repeat(64)}`,
    state: "queued",
    sequence: 0,
    createdAt: "2026-08-29T12:00:00Z",
    updatedAt: "2026-08-29T12:00:00Z",
    artifacts: [],
    actions: [],
  };
  await store.create(queued);

  await assert.rejects(store.update({
    ...queued,
    state: "running",
    sequence: 1,
    startedAt: "2026-08-29T11:59:59Z",
    updatedAt: "2026-08-29T11:59:59Z",
  }, 0), /timestamp|chronolog/i);
  assert.deepEqual(await store.history(queued.id), [queued]);
});

test("in-memory store accepts completion at or before updatedAt and rejects future completion", async () => {
  const queued = (id: string): Run => ({
    id,
    operationId: "test.echo",
    operationRevision: `sha256:${"a".repeat(64)}`,
    state: "queued",
    sequence: 0,
    createdAt: "2026-08-29T12:00:00Z",
    updatedAt: "2026-08-29T12:00:00Z",
    artifacts: [],
    actions: [],
  });
  const running = (run: Run): Run => ({
    ...run,
    state: "running",
    sequence: 1,
    startedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
  });

  const validStore = new InMemoryRunStore();
  const validQueued = queued("run-valid-completion");
  const validRunning = running(validQueued);
  await validStore.create(validQueued);
  await validStore.update(validRunning, 0);
  await validStore.update({
    ...validRunning,
    state: "succeeded",
    sequence: 2,
    completedAt: "2026-08-29T12:00:02Z",
    updatedAt: "2026-08-29T12:00:03Z",
  }, 1);
  assert.equal((await validStore.get(validQueued.id))?.state, "succeeded");

  const invalidStore = new InMemoryRunStore();
  const invalidQueued = queued("run-future-completion");
  const invalidRunning = running(invalidQueued);
  await invalidStore.create(invalidQueued);
  await invalidStore.update(invalidRunning, 0);
  await assert.rejects(invalidStore.update({
    ...invalidRunning,
    state: "succeeded",
    sequence: 2,
    completedAt: "2026-08-29T12:00:04Z",
    updatedAt: "2026-08-29T12:00:03Z",
  }, 1), /timestamp|chronolog/i);
  assert.equal((await invalidStore.get(invalidQueued.id))?.state, "running");
});

test("run lifecycle stores immutable monotonic snapshots and a valid partial terminal state", async () => {
  const operation = registered("test.partial", {
    handler: (_input, context) => {
      context.report({ current: 1, total: 2, phase: "work" });
      context.addArtifact({
        id: "notice-1",
        kind: "notice",
        level: "warning",
        message: "partial result retained",
      });
      return {
        outcome: "partial",
        problem: {
          type: "urn:gauntlet:problem:adapter-internal-error",
          title: "Partially completed",
          status: 500,
        },
        output: { completed: 1 },
      };
    },
  });
  const { manager, store, settle } = harness([operation]);

  const created = await manager.create("test.partial", requestFor(operation));
  assert.equal(created.ok, true);
  await settle();
  if (!created.ok) return;

  const history = await store.history(created.run.id);
  assert.deepEqual(history.map(({ sequence }) => sequence), [0, 1, 2, 3, 4]);
  assert.deepEqual(history.map(({ state }) => state), ["queued", "running", "running", "running", "partial"]);
  assert.equal(history.every((snapshot) => Object.isFrozen(snapshot)), true);
  assert.equal(history.slice(0, -1).every((snapshot) => snapshot.problem === undefined), true);
  const terminal = await manager.get(created.run.id);
  assert.equal(terminal?.state, "partial");
  if (terminal?.state === "partial") {
    assert.equal(terminal.completedAt, "2026-08-29T12:00:04.000Z");
    assert.equal(terminal.problem.title, "Partially completed");
  }
});

test("retained contexts no-op after success or failure without detached rejections", async () => {
  let succeededContext: RunContext | undefined;
  let failedContext: RunContext | undefined;
  const succeeded = registered("test.retained-success", {
    handler: (_input, context) => {
      succeededContext = context;
      return { output: {} };
    },
  });
  const failed = registered("test.retained-failure", {
    handler: (_input, context) => {
      failedContext = context;
      throw new Error("handler failure");
    },
  });
  const { manager, store, settle } = harness([succeeded, failed]);
  const created = await Promise.all([succeeded, failed].map((operation, index) =>
    manager.create(operation.definition.id, {
      ...requestFor(operation),
      context: {
        ...structuredClone(fullInvocationContextFixture),
        requestId: `retained-context-${index}`,
      },
    })));
  assert.equal(created.every(({ ok }) => ok), true);
  await settle();
  assert.notEqual(succeededContext, undefined);
  assert.notEqual(failedContext, undefined);
  assert.equal(succeededContext!.invocationContext, undefined);
  assert.equal(failedContext!.invocationContext, undefined);

  const before = await Promise.all(created.map((result) =>
    result.ok ? store.history(result.run.id) : []));
  const processFailures: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => processFailures.push(reason);
  const onUncaughtException = (error: unknown) => processFailures.push(error);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  try {
    const invokeEveryMutator = (context: RunContext, suffix: string): void => {
      context.report({ current: 1, phase: `late-${suffix}` });
      context.addArtifact({
        id: `late-artifact-${suffix}`,
        kind: "notice",
        level: "info",
        message: "late artifact",
      });
      context.addAction({
        kind: "open-link",
        label: "Late link",
        url: "https://example.com/late",
      });
      context.log({ level: "info", message: "late log", fields: { suffix } });
      context.warn("late warning");
    };
    assert.doesNotThrow(() => invokeEveryMutator(succeededContext!, "success"));
    assert.doesNotThrow(() => invokeEveryMutator(failedContext!, "failure"));
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  }

  const after = await Promise.all(created.map((result) =>
    result.ok ? store.history(result.run.id) : []));
  assert.deepEqual(processFailures, []);
  assert.deepEqual(after, before);
  assert.deepEqual(after.map((history) => history.at(-1)?.state), ["succeeded", "failed"]);
});

test("invocation context is revoked before terminal persistence completes", async () => {
  const terminalEntered = deferred();
  const allowTerminal = deferred();
  class GatedTerminalStore extends InMemoryRunStore {
    override async update(run: Run, expectedPreviousSequence: number): Promise<void> {
      if (run.state !== "queued" && run.state !== "running") {
        terminalEntered.resolve();
        await allowTerminal.promise;
      }
      await super.update(run, expectedPreviousSequence);
    }
  }

  let retainedContext: RunContext | undefined;
  const operation = registered("test.invocation-context-terminal-gate", {
    handler: (_input, context) => {
      retainedContext = context;
      assert.deepEqual(context.invocationContext, fullInvocationContextFixture);
      return { output: { safe: "terminal" } };
    },
  });
  const store = new GatedTerminalStore();
  const { manager, settle } = harness([operation], {}, store);
  const created = await manager.create(operation.definition.id, {
    ...requestFor(operation),
    context: fullInvocationContextFixture,
  });
  assert.equal(created.ok, true);

  const settling = settle();
  try {
    await terminalEntered.promise;
    assert.notEqual(retainedContext, undefined);
    assert.equal(retainedContext!.invocationContext, undefined);
  } finally {
    allowTerminal.resolve();
    await settling;
  }
  assert.equal((await manager.get(created.ok ? created.run.id : "missing"))?.state, "succeeded");
});

test("active context mutations serialize in call order before terminal completion", async () => {
  const operation = registered("test.active-context-order", {
    handler: async (_input, context) => {
      context.report({ current: 1, total: 2, phase: "first" });
      await Promise.resolve();
      context.addArtifact({
        id: "notice-1",
        kind: "notice",
        level: "info",
        message: "first artifact",
      });
      context.addAction({
        kind: "open-link",
        label: "Next",
        url: "https://example.com/next",
      });
      context.log({ level: "info", message: "structured entry" });
      context.warn("warning entry");
      context.report({ current: 2, total: 2, phase: "last" });
      return { output: {} };
    },
  });
  const { manager, store, settle } = harness([operation]);
  const created = await manager.create(operation.definition.id, requestFor(operation));
  assert.equal(created.ok, true);
  await settle();
  if (!created.ok) return;

  const history = await store.history(created.run.id);
  assert.deepEqual(history.map(({ sequence }) => sequence), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(history.map(({ state }) => state), [
    "queued",
    "running",
    "running",
    "running",
    "running",
    "running",
    "running",
    "running",
    "succeeded",
  ]);
  const terminal = history.at(-1);
  assert.equal(terminal?.progress?.phase, "last");
  assert.deepEqual(terminal?.artifacts.map(({ kind }) => kind), [
    "notice",
    "urn:gauntlet:artifact:structured-log",
    "notice",
  ]);
  assert.deepEqual(terminal?.actions.map(({ kind }) => kind), ["open-link"]);
});

test("handler failures become sanitized terminal Problems", async () => {
  const secret = "database-password";
  const operation = registered("test.failure", {
    definition: {
      inputSchema: {
        ...objectSchema,
        properties: { password: { type: "string" } },
      },
      inputHandling: {
        rules: [{
          kind: "secret",
          schemaPointer: "/properties/password",
          retention: "none",
        }],
      },
    },
    handler: () => {
      throw new Error(`SQL connection failed using ${secret}`);
    },
  });
  const { manager, store, settle } = harness([operation]);

  const created = await manager.create(
    "test.failure",
    requestFor(operation, undefined, { password: secret }),
  );
  assert.equal(created.ok, true);
  await settle();
  if (!created.ok) return;

  const terminal = await manager.get(created.run.id);
  assert.equal(terminal?.state, "failed");
  if (terminal?.state === "failed") {
    assert.deepEqual(terminal.problem, {
      type: "urn:gauntlet:problem:handler-failed",
      title: "Operation failed",
      status: 500,
    });
  }
  assert.equal(JSON.stringify(await store.history(created.run.id)).includes(secret), false);
  assert.equal(JSON.stringify(await store.history(created.run.id)).includes("SQL connection"), false);
  assert.equal(JSON.stringify(await store.history(created.run.id)).includes("stack"), false);
});

test("invocation context is never automatically persisted across run surfaces", async () => {
  const safe = "safe-handler-value";
  const succeeded = registered("test.invocation-context-surfaces", {
    handler: (_input, context) => {
      assert.equal(
        (context.invocationContext?.extensions?.["urn:test:invocation-context"] as JsonObject).sentinel,
        invocationContextSentinel,
      );
      context.report({ current: 1, total: 1, phase: safe, message: safe });
      context.log({ level: "info", message: safe, fields: { source: safe } });
      context.addArtifact({
        id: "context-safe-handler-artifact",
        kind: "notice",
        level: "info",
        message: safe,
      });
      context.addAction({
        kind: "open-link",
        label: safe,
        url: "https://example.test/safe-handler",
      });
      return {
        summary: { title: safe, message: safe, tone: "success" },
        output: { value: safe },
        artifacts: [{
          id: "context-safe-result-artifact",
          kind: "json",
          value: { value: safe },
        }],
        actions: [{
          kind: "open-link",
          label: safe,
          url: "https://example.test/safe-result",
        }],
      };
    },
  });
  const failed = registered("test.invocation-context-diagnostic", {
    handler: (_input, context) => {
      assert.equal(context.invocationContext?.requestId, fullInvocationContextFixture.requestId);
      throw new Error(`handler diagnostic ${invocationContextSentinel}`);
    },
  });
  const { manager, store, settle } = harness([succeeded, failed]);
  const created = await Promise.all([succeeded, failed].map((operation) =>
    manager.create(operation.definition.id, {
      ...requestFor(operation),
      context: fullInvocationContextFixture,
    })));
  assert.equal(created.every(({ ok }) => ok), true);
  await settle();

  for (const result of created) {
    if (!result.ok) continue;
    assert.equal(
      JSON.stringify(await store.history(result.run.id)).includes(invocationContextSentinel),
      false,
    );
  }
  const successTerminal = created[0]?.ok ? await manager.get(created[0].run.id) : undefined;
  assert.equal(successTerminal?.state, "succeeded");
  if (successTerminal?.state === "succeeded") {
    assert.equal(successTerminal.progress?.phase, safe);
    assert.deepEqual(successTerminal.output, { value: safe });
    assert.deepEqual(successTerminal.summary, { title: safe, message: safe, tone: "success" });
    assert.deepEqual(successTerminal.artifacts.map(({ kind }) => kind), [
      "urn:gauntlet:artifact:structured-log",
      "notice",
      "json",
    ]);
    assert.equal(JSON.stringify(successTerminal.artifacts).includes(safe), true);
    assert.deepEqual(successTerminal.actions.map(({ label }) => label), [safe, safe]);
  }
  const failedTerminal = created[1]?.ok ? await manager.get(created[1].run.id) : undefined;
  assert.equal(failedTerminal?.state, "failed");
  if (failedTerminal?.state === "failed") {
    assert.deepEqual(failedTerminal.problem, {
      type: "urn:gauntlet:problem:handler-failed",
      title: "Operation failed",
      status: 500,
    });
  }
});
