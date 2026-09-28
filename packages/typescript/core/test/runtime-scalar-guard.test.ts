import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeRevision,
  type CreateRunRequest,
  type FileReference,
  type JsonObject,
  type Problem,
  type Run,
  type ValidationError,
} from "@8lines/gauntlet-protocol";
import {
  defineOperation,
  InMemoryRunStore,
  OperationRegistry,
  RunManager,
  validationFailedProblem,
  type OperationDefinitionDraft,
  type OperationHandler,
  type RegisteredOperation,
  type RunContext,
  type RunManagerOptions,
  type RunStore,
} from "../src/index.js";

const LONE_HIGH = "\ud800";
const LONE_LOW = "\udc00";
const PAIRED = "\ud83d\ude00";
const UNSAFE_NON_EXPONENTIAL = 9_007_199_254_740_992;
const objectSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
} as const;
const FIXED_VALIDATION_PROBLEM = {
  type: "urn:gauntlet:problem:validation-failed",
  title: "Validation failed",
  status: 422,
} as const;
const FIXED_INTERNAL_PROBLEM = {
  type: "urn:gauntlet:problem:adapter-internal-error",
  title: "Adapter internal error",
  status: 500,
} as const;
const FIXED_HANDLER_PROBLEM = {
  type: "urn:gauntlet:problem:handler-failed",
  title: "Operation failed",
  status: 500,
} as const;

function ownData(
  key: string,
  value: unknown,
  prototype: object | null = Object.prototype,
): Record<string, unknown> {
  const result = Object.create(prototype) as Record<string, unknown>;
  Object.defineProperty(result, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return result;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      assertDeepFrozen(descriptor.value, seen);
    }
  }
}

function hasRejectedScalar(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return true;
      }
    }
    return false;
  }
  if (typeof value === "number") return Object.is(Math.abs(value), UNSAFE_NON_EXPONENTIAL);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "string" && hasRejectedScalar(key, seen)) return true;
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor
      && hasRejectedScalar(descriptor.value, seen)) return true;
  }
  return false;
}

function draft(
  id: string,
  overrides: Partial<OperationDefinitionDraft> = {},
): OperationDefinitionDraft {
  const featureId = id.split(".", 1)[0] ?? id;
  return {
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
    ...overrides,
  };
}

function operation(
  id: string,
  handler: OperationHandler<JsonObject> = () => ({ output: {} }),
  overrides: Partial<OperationDefinitionDraft> = {},
): RegisteredOperation<JsonObject> {
  return defineOperation(draft(id, overrides), handler);
}

class CountingStore extends InMemoryRunStore {
  createCalls = 0;
  updateCalls = 0;

  override async create(run: Run, idempotencyFingerprint?: string): Promise<void> {
    this.createCalls += 1;
    await super.create(run, idempotencyFingerprint);
  }

  override async update(run: Run, expectedPreviousSequence: number): Promise<void> {
    this.updateCalls += 1;
    await super.update(run, expectedPreviousSequence);
  }
}

interface Harness {
  readonly manager: RunManager;
  readonly store: InMemoryRunStore;
  readonly tasks: Array<() => Promise<void>>;
  readonly settle: () => Promise<void>;
}

function harness(
  operations: readonly RegisteredOperation[],
  overrides: Partial<RunManagerOptions> = {},
  store: InMemoryRunStore | RunStore = new InMemoryRunStore(),
): Harness {
  const registry = new OperationRegistry();
  for (const featureId of new Set(operations.map(({ definition }) => definition.featureId))) {
    registry.registerFeature({ id: featureId, label: featureId });
  }
  for (const registered of operations) registry.register(registered);

  let id = 0;
  let tick = 0;
  const tasks: Array<() => Promise<void>> = [];
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    idempotencySecret: new TextEncoder().encode("fixture-stable-idempotency-secret"),
    createId: () => `runtime-scalar-${++id}`,
    now: () => new Date(Date.UTC(2026, 7, 29, 12, 0, tick++)).toISOString(),
    schedule: (task) => tasks.push(task),
    ...overrides,
  });
  return {
    manager,
    store: store as InMemoryRunStore,
    tasks,
    settle: async () => {
      while (tasks.length > 0) await tasks.shift()!();
    },
  };
}

function requestFor(
  registered: RegisteredOperation,
  input: JsonObject = {},
): CreateRunRequest {
  return { operationRevision: registered.definition.revision, input };
}

function queuedRunFor(
  registered: RegisteredOperation,
  id = "runtime-scalar-stored",
): Run {
  return {
    id,
    operationId: registered.definition.id,
    operationRevision: registered.definition.revision,
    state: "queued",
    sequence: 0,
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
    artifacts: [],
    actions: [],
  };
}

function validError(params: JsonObject = {}): ValidationError {
  return {
    instancePath: "/input",
    schemaPath: "#/properties/input",
    keyword: "type",
    message: "must be a string",
    params,
  };
}

test("operation authoring and feature registration use canonical ownership as their first scalar gate", () => {
  assert.throws(
    () => defineOperation(draft("author.lone", { label: LONE_HIGH }), () => ({ output: {} })),
    /canonical plain JSON/i,
  );
  assert.throws(
    () => defineOperation(draft("author.unsafe", {
      inputSchema: {
        ...objectSchema,
        properties: { count: { type: "number", maximum: UNSAFE_NON_EXPONENTIAL } },
      },
    }), () => ({ output: {} })),
    /canonical plain JSON/i,
  );

  const properties = { [PAIRED]: { type: "number", maximum: 1e21 } } as Record<string, unknown>;
  Object.defineProperty(properties, "__proto__", {
    value: { type: "string" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const schema = { ...objectSchema, properties };
  const valid = defineOperation(draft("author.valid", {
    label: PAIRED,
    inputSchema: schema as never,
  }), () => ({ output: {} }));
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "author", label: "Author" });
  registry.register(valid);

  assert.equal(registry.require(valid.definition.id), valid);
  assert.equal(
    computeRevision(valid.definition as unknown as JsonObject),
    valid.definition.revision,
  );
  assert.equal(Object.hasOwn(valid.definition.inputSchema.properties as object, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(valid.definition.inputSchema.properties), Object.prototype);
  assertDeepFrozen(valid.definition);

  const features = new OperationRegistry();
  assert.throws(
    () => features.registerFeature({ id: "feature", label: LONE_LOW }),
    /canonical plain JSON/i,
  );
  assert.deepEqual(features.features(), []);
});

test("request input and context reject hostile scalars before any application callback or persistence", async () => {
  const canonicalContextSchema = {
    ...objectSchema,
    properties: {
      requestId: { type: "string" },
      actor: { type: "object" },
      extensions: { type: "object" },
    },
  } as const;
  const cases: readonly [string, JsonObject, CreateRunRequest["context"]?][] = [
    ["input value", { value: LONE_HIGH }],
    ["input key", ownData(LONE_LOW, "value") as JsonObject],
    ["input array", { nested: [LONE_HIGH] }],
    ["actor display name", {}, { requestId: "request-1", actor: { id: "actor-1", displayName: LONE_HIGH } }],
    ["context extension", {}, { requestId: "request-1", extensions: { "urn:test:value": LONE_LOW } }],
    ["unsafe input number", { value: UNSAFE_NON_EXPONENTIAL }],
  ];

  for (const [name, input, context] of cases) {
    let schemaCalls = 0;
    let fileCalls = 0;
    let scheduleCalls = 0;
    let handlerCalls = 0;
    const registered = operation(`request.${name.replaceAll(" ", "-")}`, () => {
      handlerCalls += 1;
      return { output: {} };
    }, { contextSchema: canonicalContextSchema });
    const store = new CountingStore();
    const { manager } = harness([registered], {
      validateSchema: () => {
        schemaCalls += 1;
        return [];
      },
      validateFileReference: () => {
        fileCalls += 1;
        return [];
      },
      schedule: () => {
        scheduleCalls += 1;
      },
    }, store);
    const result = await manager.create(registered.definition.id, {
      ...requestFor(registered, input),
      ...(context === undefined ? {} : { context }),
    });

    assert.deepEqual(result, { ok: false, problem: FIXED_VALIDATION_PROBLEM }, name);
    assert.equal(hasRejectedScalar(result), false, name);
    assert.equal(schemaCalls, 0, name);
    assert.equal(fileCalls, 0, name);
    assert.equal(scheduleCalls, 0, name);
    assert.equal(handlerCalls, 0, name);
    assert.equal(store.createCalls, 0, name);
    assert.equal(store.updateCalls, 0, name);
    assert.deepEqual(await store.all(), [], name);
  }
});

test("valid paired scalars reach validators and handlers only as owned frozen snapshots", async () => {
  const sourceInput = { value: PAIRED, nested: { value: PAIRED } };
  const sourceContext = {
    requestId: "paired-request",
    actor: { id: "actor-1", displayName: PAIRED },
    extensions: { "urn:test:paired": PAIRED },
  } as const;
  const validated: JsonObject[] = [];
  let handlerCalls = 0;
  const registered = operation("request.valid-pair", (input) => {
    handlerCalls += 1;
    assert.notEqual(input, sourceInput);
    assertDeepFrozen(input);
    return { output: { value: input.value ?? null } };
  }, { contextSchema: objectSchema });
  const { manager, store, settle } = harness([registered], {
    validateSchema: ({ value }) => {
      validated.push(value);
      assertDeepFrozen(value);
      return [];
    },
  });

  const result = await manager.create(registered.definition.id, {
    ...requestFor(registered, sourceInput),
    context: sourceContext,
  });
  assert.equal(result.ok, true);
  assert.equal(validated.length, 2);
  assert.notEqual(validated[0], sourceInput);
  assert.notEqual(validated[1], sourceContext);
  assert.equal(handlerCalls, 0);
  await settle();
  assert.equal(handlerCalls, 1);
  assert.equal((await store.all())[0]?.state, "succeeded");
});

test("every context producer rejects hostile scalars synchronously before persistence", async () => {
  const target = operation("producer.target");
  const caught = new Set<string>();
  const cases: readonly {
    readonly suffix: string;
    readonly produce: (context: RunContext) => void;
  }[] = [
    {
      suffix: "progress-lone",
      produce: (context) => context.report({ phase: LONE_HIGH }),
    },
    {
      suffix: "progress-unsafe",
      produce: (context) => context.report({ current: UNSAFE_NON_EXPONENTIAL }),
    },
    {
      suffix: "log-lone",
      produce: (context) => context.log({ level: "info", message: LONE_LOW }),
    },
    {
      suffix: "log-unsafe",
      produce: (context) => context.log({
        level: "info",
        message: "count",
        fields: { count: UNSAFE_NON_EXPONENTIAL },
      }),
    },
    {
      suffix: "warn-lone",
      produce: (context) => context.warn(LONE_HIGH),
    },
    {
      suffix: "artifact-lone",
      produce: (context) => context.addArtifact({
        id: "notice-lone",
        kind: "notice",
        level: "info",
        message: LONE_HIGH,
      }),
    },
    {
      suffix: "artifact-unsafe",
      produce: (context) => context.addArtifact({
        id: "metrics-unsafe",
        kind: "metrics",
        metrics: [{ name: "count", value: UNSAFE_NON_EXPONENTIAL }],
      }),
    },
    {
      suffix: "action-lone",
      produce: (context) => context.addAction({
        kind: "open-link",
        label: LONE_LOW,
        url: "https://example.com/next",
      }),
    },
    {
      suffix: "action-unsafe",
      produce: (context) => context.addAction({
        kind: "invoke-operation",
        label: "Invoke",
        operationId: target.definition.id,
        input: { count: UNSAFE_NON_EXPONENTIAL },
      }),
    },
  ];
  const operations = cases.map(({ suffix, produce }) => operation(
    `producer.${suffix}`,
    (_input, context) => {
      try {
        produce(context);
      } catch (error) {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /canonical plain JSON/i);
        caught.add(suffix);
      }
      return { output: { safe: true } };
    },
  ));
  const { manager, store, settle } = harness([target, ...operations]);

  const created = await Promise.all(operations.map((registered) =>
    manager.create(registered.definition.id, requestFor(registered))));
  assert.equal(created.every(({ ok }) => ok), true);
  await settle();

  assert.deepEqual([...caught].sort(), cases.map(({ suffix }) => suffix).sort());
  for (const result of created) {
    if (!result.ok) continue;
    const history = await store.history(result.run.id);
    const terminal = history.at(-1);
    assert.equal(terminal?.state, "succeeded", result.run.operationId);
    assert.deepEqual(terminal?.output, { safe: true });
    assert.deepEqual(terminal?.artifacts, []);
    assert.deepEqual(terminal?.actions, []);
    assert.equal(history.some((snapshot) => hasRejectedScalar(snapshot)), false);
  }
});

test("result output, artifact, action, and Problem reject hostile scalars atomically", async () => {
  const variants = [
    { suffix: "lone", value: LONE_HIGH },
    { suffix: "unsafe", value: UNSAFE_NON_EXPONENTIAL },
  ] as const;
  const operations: RegisteredOperation[] = [];
  for (const { suffix, value } of variants) {
    const safeArtifact = {
      id: `safe-artifact-${suffix}`,
      kind: "notice",
      level: "info",
      message: "safe sibling",
    } as const;
    const safeAction = {
      kind: "open-link",
      label: `safe-action-${suffix}`,
      url: "https://example.com/safe",
    } as const;
    operations.push(
      operation(`result.output-${suffix}`, () => ({
        output: { value },
        artifacts: [safeArtifact],
        actions: [safeAction],
      })),
      operation(`result.artifact-${suffix}`, () => ({
        output: {},
        artifacts: [safeArtifact, typeof value === "string"
          ? {
              id: `hostile-artifact-${suffix}`,
              kind: "notice",
              level: "warning",
              message: value,
            }
          : {
              id: `hostile-artifact-${suffix}`,
              kind: "metrics",
              metrics: [{ name: "count", value }],
            }],
        actions: [safeAction],
      }) as never),
      operation(`result.action-${suffix}`, () => ({
        output: {},
        artifacts: [safeArtifact],
        actions: [safeAction, typeof value === "string"
          ? {
              kind: "open-link",
              label: value,
              url: "https://example.com/hostile",
            }
          : {
              kind: "invoke-operation",
              label: "Unsafe invoke",
              operationId: "producer.target",
              input: { count: value },
            }],
      }) as never),
      operation(`result.problem-${suffix}`, () => ({
        outcome: "partial",
        problem: typeof value === "string"
          ? {
              type: "urn:gauntlet:problem:adapter-internal-error",
              title: "Partial",
              status: 500,
              detail: value,
            }
          : {
              type: "urn:gauntlet:problem:adapter-internal-error",
              title: "Partial",
              status: 500,
              extensions: { "urn:test:unsafe": value },
            },
        output: {},
        artifacts: [safeArtifact],
        actions: [safeAction],
      }) as never),
    );
  }
  const target = operation("producer.target");
  const { manager, store, settle } = harness([target, ...operations]);

  const created = await Promise.all(operations.map((registered) =>
    manager.create(registered.definition.id, requestFor(registered))));
  assert.equal(created.every(({ ok }) => ok), true);
  await settle();

  for (const result of created) {
    if (!result.ok) continue;
    const history = await store.history(result.run.id);
    const terminal = history.at(-1);
    assert.equal(terminal?.state, "failed", result.run.operationId);
    assert.deepEqual(terminal?.problem, FIXED_HANDLER_PROBLEM);
    assert.deepEqual(terminal?.artifacts, []);
    assert.deepEqual(terminal?.actions, []);
    assert.equal(history.some((snapshot) => hasRejectedScalar(snapshot)), false);
    assert.equal(history.some((snapshot) => snapshot.artifacts.some(({ id }) =>
      id.startsWith("safe-artifact-"))), false);
    assert.equal(history.some((snapshot) => snapshot.actions.some(({ label }) =>
      label.startsWith("safe-action-"))), false);
  }
});

test("paired-surrogate producer values retain a normal lifecycle", async () => {
  const registered = operation("producer.valid-pair", (_input, context) => {
    context.report({ phase: PAIRED });
    context.log({ level: "info", message: PAIRED });
    context.addArtifact({
      id: "paired-artifact",
      kind: "notice",
      level: "success",
      message: PAIRED,
    });
    context.addAction({
      kind: "open-link",
      label: PAIRED,
      url: "https://example.com/paired",
    });
    return {
      summary: { title: PAIRED, tone: "success" },
      output: { value: PAIRED },
    };
  });
  const { manager, store, settle } = harness([registered]);
  const created = await manager.create(registered.definition.id, requestFor(registered));
  assert.equal(created.ok, true);
  await settle();
  if (!created.ok) return;
  const terminal = (await store.history(created.run.id)).at(-1);
  assert.equal(terminal?.state, "succeeded");
  assert.equal(terminal?.progress?.phase, PAIRED);
  assert.equal(terminal?.output !== undefined && hasRejectedScalar(terminal.output), false);
});

test("schema validator diagnostics are owned before inspection and map only to a fixed 500", async () => {
  let accessorCalls = 0;
  const sparse = new Array<ValidationError>(1);
  const withExtra = [] as ValidationError[] & Record<string, unknown>;
  withExtra.extra = validError();
  const accessor = [] as ValidationError[];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get: () => {
      accessorCalls += 1;
      return validError();
    },
  });
  const hostileParamsKey = ownData(LONE_LOW, "value") as JsonObject;
  const cases: readonly [string, readonly ValidationError[]][] = [
    ["instance-path", [{ ...validError(), instancePath: LONE_HIGH }]],
    ["schema-path", [{ ...validError(), schemaPath: LONE_LOW }]],
    ["keyword", [{ ...validError(), keyword: LONE_HIGH }]],
    ["message", [{ ...validError(), message: LONE_LOW }]],
    ["params-key", [validError(hostileParamsKey)]],
    ["params-value", [validError({ value: LONE_HIGH })]],
    ["params-unsafe", [validError({ value: UNSAFE_NON_EXPONENTIAL })]],
    ["extension-unsafe", [{
      ...validError(),
      extensions: { "urn:test:unsafe": UNSAFE_NON_EXPONENTIAL },
    }]],
    ["sparse-array", sparse],
    ["extra-array-property", withExtra],
    ["accessor-array", accessor],
  ];

  for (const [suffix, errors] of cases) {
    let scheduleCalls = 0;
    let handlerCalls = 0;
    const registered = operation(`validator.${suffix}`, () => {
      handlerCalls += 1;
      return { output: {} };
    });
    const store = new CountingStore();
    const { manager } = harness([registered], {
      validateSchema: () => errors,
      schedule: () => {
        scheduleCalls += 1;
      },
    }, store);

    const result = await manager.create(registered.definition.id, requestFor(registered));
    assert.deepEqual(result, { ok: false, problem: FIXED_INTERNAL_PROBLEM }, suffix);
    assert.equal(hasRejectedScalar(result), false, suffix);
    assert.equal(scheduleCalls, 0, suffix);
    assert.equal(handlerCalls, 0, suffix);
    assert.equal(store.createCalls, 0, suffix);
    assert.equal(store.updateCalls, 0, suffix);
    assert.deepEqual(await store.all(), [], suffix);
  }
  assert.equal(accessorCalls, 0);
});

test("file validator diagnostics cross the same ownership boundary", async () => {
  let accessorCalls = 0;
  let scheduleCalls = 0;
  let handlerCalls = 0;
  const accessor = [] as ValidationError[];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get: () => {
      accessorCalls += 1;
      return validError();
    },
  });
  const registered = operation("validator.file", () => {
    handlerCalls += 1;
    return { output: {} };
  }, {
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
  });
  const reference: FileReference = {
    kind: "file",
    uploadId: "upload-1",
    name: "test.txt",
    mediaType: "text/plain",
    sizeBytes: 12,
    expiresAt: "2026-08-29T13:00:00.000Z",
  };
  const store = new CountingStore();
  const { manager } = harness([registered], {
    validateFileReference: () => accessor,
    schedule: () => {
      scheduleCalls += 1;
    },
  }, store);

  const result = await manager.create(
    registered.definition.id,
    requestFor(registered, { attachment: reference as unknown as JsonObject }),
  );
  assert.deepEqual(result, { ok: false, problem: FIXED_INTERNAL_PROBLEM });
  assert.equal(accessorCalls, 0);
  assert.equal(scheduleCalls, 0);
  assert.equal(handlerCalls, 0);
  assert.equal(store.createCalls, 0);
  assert.equal(store.updateCalls, 0);
  assert.deepEqual(await store.all(), []);
});

test("valid validator diagnostics preserve null prototypes, __proto__ data, pairs, and source isolation", async () => {
  const params = ownData("__proto__", { value: PAIRED }, null) as JsonObject;
  const source = validError(params);
  const registered = operation("validator.valid");
  const { manager } = harness([registered], { validateSchema: () => [source] });

  const result = await manager.create(registered.definition.id, requestFor(registered));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problem.status, 422);
  const returned = result.problem.errors?.[0];
  assert.notEqual(returned, source);
  assert.notEqual(returned?.params, params);
  assert.equal(Object.getPrototypeOf(returned?.params), null);
  assert.equal(Object.hasOwn(returned?.params ?? {}, "__proto__"), true);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.deepEqual((returned?.params as Record<string, unknown>).__proto__, { value: PAIRED });
  assertDeepFrozen(result.problem);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(params), false);
});

test("validationFailedProblem owns the entire diagnostic array before any read", () => {
  let accessorCalls = 0;
  const sparse = new Array<ValidationError>(1);
  const withExtra = [] as ValidationError[] & Record<string, unknown>;
  withExtra.extra = validError();
  const accessor = [] as ValidationError[];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get: () => {
      accessorCalls += 1;
      return validError();
    },
  });
  const hostile: readonly (readonly ValidationError[])[] = [
    sparse,
    withExtra,
    accessor,
    [{ ...validError(), message: LONE_HIGH }],
    [validError({ value: UNSAFE_NON_EXPONENTIAL })],
  ];

  for (const errors of hostile) {
    assert.throws(() => validationFailedProblem(errors), /canonical plain JSON/i);
  }
  assert.equal(accessorCalls, 0);

  const params = ownData("__proto__", PAIRED, null) as JsonObject;
  const sourceError = validError(params);
  const sourceErrors = [sourceError];
  const problem = validationFailedProblem(sourceErrors);
  assert.notEqual(problem.errors, sourceErrors);
  assert.notEqual(problem.errors?.[0], sourceError);
  assert.notEqual(problem.errors?.[0]?.params, params);
  assert.equal(Object.getPrototypeOf(problem.errors?.[0]?.params), null);
  assert.equal(Object.hasOwn(problem.errors?.[0]?.params ?? {}, "__proto__"), true);
  assert.equal((problem.errors?.[0]?.params as Record<string, unknown>).__proto__, PAIRED);
  assertDeepFrozen(problem);
  assert.equal(Object.isFrozen(sourceErrors), false);
  assert.equal(Object.isFrozen(sourceError), false);
  assert.equal(Object.isFrozen(params), false);
});

function invalidRunFixtures(
  registered: RegisteredOperation,
  onAccessor: () => void,
): readonly [string, Run][] {
  const outputAccessor: Record<string, unknown> = {};
  Object.defineProperty(outputAccessor, "value", {
    enumerable: true,
    configurable: true,
    get: () => {
      onAccessor();
      return "must-not-read";
    },
  });
  return [
    ["output-value", { ...queuedRunFor(registered), output: { value: LONE_HIGH } }],
    ["output-key", {
      ...queuedRunFor(registered),
      output: ownData(LONE_LOW, "value") as JsonObject,
    }],
    ["unsafe-number", {
      ...queuedRunFor(registered),
      output: { value: UNSAFE_NON_EXPONENTIAL },
    }],
    ["sparse-array", {
      ...queuedRunFor(registered),
      output: new Array(1) as never,
    }],
    ["exotic-object", {
      ...queuedRunFor(registered),
      output: new Date("2026-08-29T12:00:00.000Z") as never,
    }],
    ["accessor", {
      ...queuedRunFor(registered),
      output: outputAccessor as never,
    }],
  ];
}

test("custom store reads hide every invalid scalar and structural Run without invoking accessors", async () => {
  const registered = operation("store.custom-get");
  let accessorCalls = 0;
  let current: Run | undefined;
  const store: RunStore = {
    create: async () => undefined,
    get: async () => current,
    findByIdempotencyKey: async () => undefined,
    update: async () => undefined,
  };
  const { manager } = harness([registered], {}, store);

  for (const [name, invalid] of invalidRunFixtures(registered, () => {
    accessorCalls += 1;
  })) {
    current = invalid;
    assert.equal(await manager.get(invalid.id), undefined, name);
  }
  assert.equal(accessorCalls, 0);
});

test("custom store get hides an otherwise canonical failed Run with a hostile Problem detail", async () => {
  const registered = operation("store.custom-terminal-problem");
  const terminalBase = {
    ...queuedRunFor(registered, "custom-terminal-run"),
    state: "failed" as const,
    sequence: 2,
    updatedAt: "2026-08-29T12:02:00.000Z",
    startedAt: "2026-08-29T12:01:00.000Z",
    completedAt: "2026-08-29T12:02:00.000Z",
    problem: {
      type: "urn:gauntlet:problem:adapter-internal-error" as const,
      title: "Failed",
      status: 500,
    },
  };
  const canonicalTerminal: Run = {
    ...terminalBase,
    problem: { ...terminalBase.problem, detail: "entirely canonical detail" },
  };
  const hostileTerminal: Run = {
    ...terminalBase,
    problem: { ...terminalBase.problem, detail: LONE_HIGH },
  };
  let current: Run = canonicalTerminal;
  let getCalls = 0;
  const store: RunStore = {
    create: async () => undefined,
    get: async () => {
      getCalls += 1;
      return current;
    },
    findByIdempotencyKey: async () => undefined,
    update: async () => undefined,
  };
  const { manager } = harness([registered], {}, store);

  const canonical = await manager.get(canonicalTerminal.id);
  assert.deepEqual(canonical, canonicalTerminal);
  assert.notEqual(canonical, canonicalTerminal);
  assertDeepFrozen(canonical);

  current = hostileTerminal;
  assert.equal(await manager.get(hostileTerminal.id), undefined);
  assert.equal(getCalls, 2);
});

test("invalid idempotency replay is a fixed internal failure without scheduling or creating", async () => {
  const registered = operation("store.invalid-replay");
  const replay = {
    ...queuedRunFor(registered, "replayed-run"),
    output: { value: LONE_HIGH },
  };
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
  const { manager } = harness([registered], {
    schedule: () => {
      scheduleCalls += 1;
    },
  }, store);

  const result = await manager.create(registered.definition.id, {
    ...requestFor(registered),
    idempotencyKey: "existing-key",
  });
  assert.deepEqual(result, { ok: false, problem: FIXED_INTERNAL_PROBLEM });
  assert.equal(createCalls, 0);
  assert.equal(scheduleCalls, 0);
});

test("invalid recovery reread cannot cause a follow-up store update or task rejection", async () => {
  const registered = operation("store.invalid-recovery", () => {
    throw new Error("handler failed");
  });
  const invalidRecovery = {
    ...queuedRunFor(registered, "runtime-scalar-1"),
    output: { value: LONE_LOW },
  };
  let updateCalls = 0;
  const store: RunStore = {
    create: async () => undefined,
    get: async () => invalidRecovery,
    findByIdempotencyKey: async () => undefined,
    update: async () => {
      updateCalls += 1;
    },
  };
  const { manager, tasks } = harness([registered], {}, store);
  const result = await manager.create(registered.definition.id, requestFor(registered));
  assert.equal(result.ok, true);
  assert.equal(tasks.length, 1);
  await assert.doesNotReject(tasks[0]!());
  assert.equal(updateCalls, 1);
});

test("in-memory store rejects invalid create and update snapshots before mutation", async () => {
  const registered = operation("store.in-memory-invalid");
  let accessorCalls = 0;
  const fixtures = invalidRunFixtures(registered, () => {
    accessorCalls += 1;
  });

  for (const [name, invalid] of fixtures) {
    const createStore = new InMemoryRunStore();
    await assert.rejects(createStore.create(invalid), /canonical plain JSON/i, name);
    assert.deepEqual(await createStore.all(), [], name);
    assert.deepEqual(await createStore.history(invalid.id), [], name);

    const updateStore = new InMemoryRunStore();
    const queued = queuedRunFor(registered, invalid.id);
    await updateStore.create(queued);
    const invalidUpdate: Run = {
      ...invalid,
      id: queued.id,
      state: "running",
      sequence: 1,
      updatedAt: "2026-08-29T12:01:00.000Z",
      startedAt: "2026-08-29T12:01:00.000Z",
    } as Run;
    const beforeAll = await updateStore.all();
    const beforeHistory = await updateStore.history(queued.id);
    await assert.rejects(updateStore.update(invalidUpdate, 0), /canonical plain JSON/i, name);
    assert.deepEqual(await updateStore.all(), beforeAll, name);
    assert.deepEqual(await updateStore.history(queued.id), beforeHistory, name);
  }
  assert.equal(accessorCalls, 0);
});

test("in-memory store isolates terminal Problem scalar rejection from transition invariants", async () => {
  const registered = operation("store.terminal-problem");
  const terminalId = "runtime-scalar-terminal";
  const queued = queuedRunFor(registered, terminalId);
  const running: Run = {
    ...queued,
    state: "running",
    sequence: 1,
    updatedAt: "2026-08-29T12:01:00.000Z",
    startedAt: "2026-08-29T12:01:00.000Z",
  };
  const terminalBase = {
    ...running,
    state: "failed" as const,
    sequence: 2,
    updatedAt: "2026-08-29T12:02:00.000Z",
    completedAt: "2026-08-29T12:02:00.000Z",
    problem: {
      type: "urn:gauntlet:problem:adapter-internal-error" as const,
      title: "Failed",
      status: 500,
    },
  };
  const hostileTerminal: Run = {
    ...terminalBase,
    problem: { ...terminalBase.problem, detail: LONE_HIGH },
  };
  const canonicalTerminal: Run = {
    ...terminalBase,
    problem: { ...terminalBase.problem, detail: "entirely canonical detail" },
  };

  const hostileStore = new InMemoryRunStore();
  await hostileStore.create(queued);
  await hostileStore.update(running, 0);
  const beforeHostileAll = await hostileStore.all();
  const beforeHostileHistory = await hostileStore.history(terminalId);
  await assert.rejects(
    hostileStore.update(hostileTerminal, 1),
    /canonical plain JSON/i,
    "terminal Problem detail",
  );
  assert.deepEqual(await hostileStore.all(), beforeHostileAll);
  assert.deepEqual(await hostileStore.history(terminalId), beforeHostileHistory);

  const controlStore = new InMemoryRunStore();
  await controlStore.create(queued);
  await controlStore.update(running, 0);
  await assert.doesNotReject(controlStore.update(canonicalTerminal, 1));
  assert.deepEqual(await controlStore.all(), [canonicalTerminal]);
  assert.deepEqual(await controlStore.history(terminalId), [queued, running, canonicalTerminal]);
  assert.equal(hasRejectedScalar((await controlStore.all())[0]), false);
});

test("valid store round trips preserve owned frozen null-prototype __proto__ data and pairs", async () => {
  const registered = operation("store.valid-roundtrip");
  const output = ownData("__proto__", { value: PAIRED }, null) as JsonObject;
  const source = { ...queuedRunFor(registered), output };
  const store = new InMemoryRunStore();
  await store.create(source);
  const { manager } = harness([registered], {}, store);

  const fromGet = await manager.get(source.id);
  const fromAll = (await store.all())[0];
  const fromHistory = (await store.history(source.id))[0];
  for (const owned of [fromGet, fromAll, fromHistory]) {
    assert.notEqual(owned, source);
    assertDeepFrozen(owned);
    assert.equal(Object.getPrototypeOf(owned?.output), null);
    assert.equal(Object.hasOwn(owned?.output as object, "__proto__"), true);
    assert.deepEqual((owned?.output as Record<string, unknown>).__proto__, { value: PAIRED });
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  }
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(output), false);
});
