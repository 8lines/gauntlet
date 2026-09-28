import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  JsonObject,
  OperationDefinition,
  Run,
} from "@8lines/gauntlet-protocol";
import {
  defineOperation,
  InMemoryExecutionCoordinator,
  InMemoryRunStore,
  OperationRegistry,
  RunManager,
  RunStoreConflictError,
  type ExecutionCoordinator,
  type OperationHandler,
  type RegisteredOperation,
  type RunContext,
} from "../src/index.js";

const objectSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
} as const;

function operation(
  id: string,
  execution: Partial<OperationDefinition["execution"]>,
  handler: OperationHandler<JsonObject> = () => ({ output: {} }),
): RegisteredOperation<JsonObject> {
  return defineOperation({
    id,
    label: id,
    featureId: "policy",
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
      ...execution,
    },
    output: { schema: objectSchema },
  }, handler);
}

function requestFor(
  value: RegisteredOperation<JsonObject>,
  idempotencyKey?: string,
  input: JsonObject = {},
) {
  return {
    operationRevision: value.definition.revision,
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

async function eventuallyAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

interface PolicyHarness {
  readonly manager: RunManager;
  readonly store: InMemoryRunStore;
  readonly scheduled: Array<() => Promise<void>>;
}

function harness(value: RegisteredOperation<JsonObject>): PolicyHarness {
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new InMemoryRunStore();
  const scheduled: Array<() => Promise<void>> = [];
  let sequence = 0;
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => `run-${++sequence}`,
    now: () => `2026-08-30T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(7),
  });
  return { manager, store, scheduled };
}

test("propagates immutable dry-run mode without calling the mutating dependency", async () => {
  let handlerCalls = 0;
  let applicationWrites = 0;
  const seen: boolean[] = [];
  const frozen: boolean[] = [];
  const value = operation("policy.dry-run-context", {
    impact: "write",
    confirmationRequired: true,
    dryRunSupported: true,
    idempotency: "required",
  }, (_input, context) => {
    handlerCalls += 1;
    seen.push(context.dryRun);
    frozen.push(Object.isFrozen(context));
    assert.equal(Reflect.set(context, "dryRun", !context.dryRun), false);
    if (!context.dryRun) applicationWrites += 1;
    return { output: {} };
  });
  const { manager, store, scheduled } = harness(value);
  const confirmation = {
    operationId: value.definition.id,
    operationRevision: value.definition.revision,
    impact: value.definition.execution.impact,
  } as const;

  const rejectedWithoutConfirmation = await manager.create(value.definition.id, {
    ...requestFor(value, "missing-confirmation"),
    dryRun: true,
  });
  assert.equal(rejectedWithoutConfirmation.ok, false);
  if (!rejectedWithoutConfirmation.ok) {
    assert.equal(rejectedWithoutConfirmation.problem.errors?.[0]?.instancePath, "/confirmation");
  }
  assert.equal(handlerCalls, 0);
  assert.equal(scheduled.length, 0);

  for (const request of [
    { ...requestFor(value, "preview"), confirmation, dryRun: true },
    { ...requestFor(value, "explicit-live"), confirmation, dryRun: false },
    { ...requestFor(value, "omitted-live"), confirmation },
  ]) {
    const created = await manager.create(value.definition.id, request);
    assert.equal(created.ok, true);
    const task = scheduled.shift();
    assert.notEqual(task, undefined);
    await task!();
    if (created.ok) assert.equal((await store.get(created.run.id))?.state, "succeeded");
  }

  assert.deepEqual(seen, [true, false, false]);
  assert.deepEqual(frozen, [true, true, true]);
  assert.equal(handlerCalls, 3);
  assert.equal(applicationWrites, 2);
});

test("forbid rejects a second queued run without reserving it", async () => {
  let calls = 0;
  const value = operation("policy.forbid", { concurrency: "forbid" }, () => {
    calls += 1;
    return { output: {} };
  });
  const { manager, store, scheduled } = harness(value);

  const first = await manager.create(value.definition.id, requestFor(value));
  const second = await manager.create(value.definition.id, requestFor(value));

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.deepEqual(second.problem, {
      type: "urn:gauntlet:problem:operation-busy",
      title: "Operation busy",
      status: 409,
    });
  }
  assert.deepEqual((await store.all()).map((run: Run) => run.id), ["run-1"]);
  assert.equal(scheduled.length, 1);
  assert.equal(calls, 0);
});

test("forbid preserves concurrent idempotency replay before reporting busy", async () => {
  const value = operation("policy.forbid-idempotent", {
    concurrency: "forbid",
    idempotency: "required",
  });
  const { manager, store, scheduled } = harness(value);

  const [first, replay] = await Promise.all([
    manager.create(value.definition.id, requestFor(value, "same-request")),
    manager.create(value.definition.id, requestFor(value, "same-request")),
  ]);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) assert.equal(replay.run.id, first.run.id);
  assert.equal((await store.all()).length, 1);
  assert.equal(scheduled.length, 1);
});

test("queue starts one handler at a time in run admission order", async () => {
  const completions = [deferred<{ output: JsonObject }>(), deferred<{ output: JsonObject }>(), deferred<{ output: JsonObject }>()];
  const starts: number[] = [];
  const value = operation("policy.queue", { concurrency: "queue" }, (input) => {
    const position = input.position as number;
    starts.push(position);
    return completions[position]!.promise;
  });
  const { manager, store, scheduled } = harness(value);
  const created = await Promise.all([0, 1, 2].map((position) =>
    manager.create(value.definition.id, requestFor(value, undefined, { position }))));
  assert.equal(created.every((result) => result.ok), true);
  const tasks = scheduled.splice(0).map((task) => task());

  try {
    await eventually(() => starts.length >= 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(starts, [0]);

    completions[0]!.resolve({ output: {} });
    await eventually(() => starts.length >= 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(starts, [0, 1]);

    completions[1]!.resolve({ output: {} });
    await eventually(() => starts.length >= 3);
    assert.deepEqual(starts, [0, 1, 2]);
    completions[2]!.resolve({ output: {} });
    await Promise.all(tasks);
  } finally {
    for (const completion of completions) completion.resolve({ output: {} });
    await Promise.all(tasks);
  }

  assert.deepEqual((await store.all()).map(({ state }) => state), [
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
});

test("cancel aborts the active context and ignores late writes and results", async () => {
  const completion = deferred<{ output: JsonObject }>();
  let context: RunContext | undefined;
  const value = operation("policy.cancel", {
    cancellationSupported: true,
  }, (_input, activeContext) => {
    context = activeContext;
    return completion.promise;
  });
  const { manager, store, scheduled } = harness(value);
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const task = scheduled.shift();
  assert.notEqual(task, undefined);
  const running = task!();
  let taskSettled = false;
  void running.finally(() => {
    taskSettled = true;
  });

  try {
    await eventually(() => context !== undefined);
    const cancelled = await manager.cancel(created.run.id);
    assert.equal("state" in cancelled ? cancelled.state : undefined, "cancelled");
    const repeated = await manager.cancel(created.run.id);
    assert.deepEqual(repeated, cancelled);
    assert.equal(context!.signal.aborted, true);
    assert.throws(() => context!.throwIfCancelled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(taskSettled, false);

    const beforeLateWrites = await store.history(created.run.id);
    context!.report({ current: 1, total: 1, phase: "late" });
    context!.addArtifact({
      id: "late",
      kind: "notice",
      level: "info",
      message: "must not persist",
    });
    context!.warn("must not persist");
    completion.resolve({ output: { late: true } });
    await running;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await store.history(created.run.id), beforeLateWrites);
  } finally {
    completion.resolve({ output: {} });
    await running;
  }

  const history = await store.history(created.run.id);
  assert.deepEqual(history.map(({ state }) => state), ["queued", "running", "cancelled"]);
  assert.equal(history.at(-1)?.sequence, 2);
  assert.deepEqual(history.at(-1)?.problem, {
    type: "urn:gauntlet:problem:run-cancelled",
    title: "Run cancelled",
    status: 409,
  });
});

test("cancel returns run-not-cancellable without changing the run", async () => {
  const value = operation("policy.not-cancellable", {
    cancellationSupported: false,
  });
  const { manager, store } = harness(value);
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.deepEqual(await manager.cancel(created.run.id), {
    type: "urn:gauntlet:problem:run-not-cancellable",
    title: "Run is not cancellable",
    status: 409,
  });
  assert.deepEqual(await store.history(created.run.id), [created.run]);
});

test("cancel checks operation policy before replaying a terminal run", async () => {
  const value = operation("policy.terminal-not-cancellable", {
    cancellationSupported: false,
  });
  const { manager, store, scheduled } = harness(value);
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await Promise.all(scheduled.splice(0).map((task) => task()));
  const beforeCancel = await store.history(created.run.id);

  const result = await manager.cancel(created.run.id);

  assert.deepEqual(result, {
    type: "urn:gauntlet:problem:run-not-cancellable",
    title: "Run is not cancellable",
    status: 409,
  });
  assert.deepEqual(await store.history(created.run.id), beforeCancel);
});

test("timeout aborts an unfinished handler and terminalizes it exactly once", async (contextTest) => {
  contextTest.mock.timers.enable({ apis: ["setTimeout"] });
  const completion = deferred<{ output: JsonObject }>();
  let context: RunContext | undefined;
  const value = operation("policy.timeout", {
    timeoutSeconds: 1,
  }, (_input, activeContext) => {
    context = activeContext;
    return completion.promise;
  });
  const { manager, store, scheduled } = harness(value);
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const task = scheduled.shift();
  assert.notEqual(task, undefined);
  const running = task!();
  let taskSettled = false;
  void running.finally(() => {
    taskSettled = true;
  });

  try {
    await eventually(() => context !== undefined);
    contextTest.mock.timers.tick(999);
    assert.equal((await manager.get(created.run.id))?.state, "running");
    contextTest.mock.timers.tick(1);
    await eventuallyAsync(async () => (await manager.get(created.run.id))?.state === "timed_out");
    assert.equal(context!.signal.aborted, true);
    assert.equal(taskSettled, false);
    assert.deepEqual((await store.history(created.run.id)).map(({ state }) => state), [
      "queued",
      "running",
      "timed_out",
    ]);
    assert.deepEqual((await store.history(created.run.id)).at(-1)?.problem, {
      type: "urn:gauntlet:problem:run-timed-out",
      title: "Run timed out",
      status: 504,
    });

    completion.resolve({ output: { late: true } });
    await running;
    contextTest.mock.timers.tick(10_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await store.history(created.run.id)).length, 3);
  } finally {
    completion.resolve({ output: {} });
    await running;
  }
});

for (const coordinatorFailure of ["throw", "reject", "never"] as const) {
  test(`timeout terminalizes locally when coordinator cancellation ${coordinatorFailure}s`, async (contextTest) => {
    contextTest.mock.timers.enable({ apis: ["setTimeout"] });
    const completion = deferred<{ output: JsonObject }>();
    let handlerSignal: AbortSignal | undefined;
    const value = operation(`policy.timeout-coordinator-${coordinatorFailure}`, {
      timeoutSeconds: 1,
    }, (_input, context) => {
      handlerSignal = context.signal;
      return completion.promise;
    });
    const registry = new OperationRegistry();
    registry.registerFeature({ id: "policy", label: "Policy" });
    registry.register(value);
    const store = new InMemoryRunStore();
    const scheduled: Array<() => Promise<void>> = [];
    const base = new InMemoryExecutionCoordinator();
    const coordinator: ExecutionCoordinator = {
      acquire: (request) => base.acquire(request),
      requestCancellation() {
        if (coordinatorFailure === "throw") throw new Error("coordinator unavailable");
        if (coordinatorFailure === "reject") {
          return Promise.reject(new Error("coordinator unavailable"));
        }
        return new Promise<boolean>(() => undefined);
      },
    };
    const manager = new RunManager(registry, store, {
      validateSchema: () => [],
      validateFileReference: () => [],
      createId: () => `timeout-${coordinatorFailure}-run`,
      now: () => "2026-08-30T12:10:00.000Z",
      schedule: (task) => scheduled.push(task),
      executionCoordinator: coordinator,
      idempotencySecret: new Uint8Array(32).fill(6),
    });
    const created = await manager.create(value.definition.id, requestFor(value));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const running = scheduled.shift()!();
    try {
      await eventually(() => handlerSignal !== undefined);
      contextTest.mock.timers.tick(1_000);
      await eventuallyAsync(async () => (await manager.get(created.run.id))?.state === "timed_out");
      assert.equal(handlerSignal!.aborted, true);
    } finally {
      completion.resolve({ output: {} });
      await running;
    }
  });
}

test("run store compare-and-set rejects a stale writer before mutation", async () => {
  const value = operation("policy.cas", {});
  const { manager, store } = harness(value);
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const running: Run = {
    ...created.run,
    state: "running",
    sequence: 1,
    startedAt: "2026-08-30T12:00:02.000Z",
    updatedAt: "2026-08-30T12:00:02.000Z",
  };

  await assert.rejects(
    store.update(running, 99),
    /conflict|sequence|compare/i,
  );
  assert.deepEqual(await store.get(created.run.id), created.run);
});

test("a regressing clock is clamped across running and successful terminal writes", async () => {
  const value = operation("policy.regressing-success-clock", {});
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new InMemoryRunStore();
  const scheduled: Array<() => Promise<void>> = [];
  const timestamps = [
    "2026-08-30T12:00:00.000Z",
    "2026-08-30T11:00:00.000Z",
    "2026-08-30T10:00:00.000Z",
  ];
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "regressing-success-run",
    now: () => timestamps.shift() ?? "2026-08-30T09:00:00.000Z",
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(8),
  });

  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  await Promise.all(scheduled.splice(0).map((task) => task()));
  const history = await store.history("regressing-success-run");
  assert.deepEqual(history.map(({ state }) => state), ["queued", "running", "succeeded"]);
  assert.deepEqual(history.map(({ updatedAt }) => updatedAt), [
    "2026-08-30T12:00:00.000Z",
    "2026-08-30T12:00:00.000Z",
    "2026-08-30T12:00:00.000Z",
  ]);
});

test("a regressing clock cannot strand direct queued cancellation", async () => {
  const value = operation("policy.regressing-cancel-clock", {
    cancellationSupported: true,
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new InMemoryRunStore();
  const scheduled: Array<() => Promise<void>> = [];
  let firstTimestamp = true;
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "regressing-cancel-run",
    now: () => {
      if (firstTimestamp) {
        firstTimestamp = false;
        return "2026-08-30T12:00:00.000Z";
      }
      return "2026-08-30T11:00:00.000Z";
    },
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(8),
  });

  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const cancelled = await manager.cancel(created.run.id);
  assert.equal("state" in cancelled ? cancelled.state : undefined, "cancelled");
  await Promise.all(scheduled.splice(0).map((task) => task()));
  assert.deepEqual((await store.history(created.run.id)).map(({ state }) => state), [
    "queued",
    "cancelled",
  ]);
});

test("coordinator rejects a duplicate run ID without replacing its cancellation lease", async () => {
  const coordinator = new InMemoryExecutionCoordinator();
  const first = coordinator.acquire({
    operationId: "policy.duplicate-id",
    runId: "same-run",
    concurrency: "allow",
  });
  assert.equal(first.kind, "acquired");

  assert.throws(() => coordinator.acquire({
    operationId: "policy.duplicate-id",
    runId: "same-run",
    concurrency: "allow",
  }), /duplicate|run id/i);
  if (first.kind !== "acquired") return;
  await first.commitAdmission();
  const published = await coordinator.requestCancellation({
    operationId: "policy.duplicate-id",
    runId: "same-run",
    reason: {
      type: "urn:gauntlet:problem:run-cancelled",
      title: "Run cancelled",
      status: 409,
    },
  });
  assert.equal(published, true);
  assert.equal(first.signal.aborted, true);
  await first.release();
});

test("an abort published during admission commit cannot strand a queued run", async () => {
  const base = new InMemoryExecutionCoordinator();
  const coordinator: ExecutionCoordinator = {
    acquire(request) {
      const acquisition = base.acquire(request);
      if (acquisition.kind === "conflict") return acquisition;
      return {
        ...acquisition,
        async commitAdmission() {
          await acquisition.commitAdmission();
          await base.requestCancellation({
            operationId: request.operationId,
            runId: request.runId,
            reason: {
              type: "urn:gauntlet:problem:run-cancelled",
              title: "Run cancelled",
              status: 409,
            },
          });
        },
      };
    },
    requestCancellation: (request) => base.requestCancellation(request),
  };
  const value = operation("policy.commit-abort", {
    cancellationSupported: true,
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new InMemoryRunStore();
  const scheduled: Array<() => Promise<void>> = [];
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "commit-abort-run",
    now: () => "2026-08-30T12:00:00.000Z",
    schedule: (task) => scheduled.push(task),
    executionCoordinator: coordinator,
    idempotencySecret: new Uint8Array(32).fill(4),
  });

  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await eventuallyAsync(async () => (await manager.get(created.run.id))?.state === "cancelled");
  await Promise.all(scheduled.splice(0).map((task) => task()));
  assert.deepEqual((await store.history(created.run.id)).map(({ state }) => state), [
    "queued",
    "cancelled",
  ]);
});

test("a coordinator failure after durable create terminalizes the reserved run", async () => {
  const base = new InMemoryExecutionCoordinator();
  const coordinator: ExecutionCoordinator = {
    acquire(request) {
      const acquisition = base.acquire(request);
      if (acquisition.kind === "conflict") return acquisition;
      return {
        ...acquisition,
        async commitAdmission() {
          await acquisition.commitAdmission();
          throw new Error("coordinator commit failed");
        },
      };
    },
    requestCancellation: (request) => base.requestCancellation(request),
  };
  const value = operation("policy.commit-failure", {});
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new InMemoryRunStore();
  const scheduled: Array<() => Promise<void>> = [];
  let tick = 0;
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "commit-failure-run",
    now: () => `2026-08-30T12:30:${String(tick++).padStart(2, "0")}.000Z`,
    schedule: (task) => scheduled.push(task),
    executionCoordinator: coordinator,
    idempotencySecret: new Uint8Array(32).fill(6),
  });

  const result = await manager.create(value.definition.id, requestFor(value));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.status, 500);
  await Promise.all(scheduled.splice(0).map((task) => task()));
  assert.deepEqual((await store.history("commit-failure-run")).map(({ state }) => state), [
    "queued",
    "failed",
  ]);
});

test("a rejected execution turn terminalizes the durable queued run", async () => {
  let rejectTurn!: (reason?: unknown) => void;
  const ready = new Promise<boolean>((_resolve, reject) => {
    rejectTurn = reject;
  });
  const base = new InMemoryExecutionCoordinator();
  const coordinator: ExecutionCoordinator = {
    acquire(request) {
      const acquisition = base.acquire(request);
      return acquisition.kind === "conflict" ? acquisition : { ...acquisition, ready };
    },
    requestCancellation: (request) => base.requestCancellation(request),
  };
  const value = operation("policy.ready-failure", {});
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new InMemoryRunStore();
  const scheduled: Array<() => Promise<void>> = [];
  let tick = 0;
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "ready-failure-run",
    now: () => `2026-08-30T12:45:${String(tick++).padStart(2, "0")}.000Z`,
    schedule: (task) => scheduled.push(task),
    executionCoordinator: coordinator,
    idempotencySecret: new Uint8Array(32).fill(5),
  });
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  const task = scheduled.shift();
  assert.notEqual(task, undefined);
  const running = task!();
  await Promise.resolve();
  rejectTurn(new Error("distributed turn failed"));
  await running;

  assert.deepEqual((await store.history("ready-failure-run")).map(({ state }) => state), [
    "queued",
    "failed",
  ]);
});

test("the outer scheduled-task boundary recovers when execution recovery also throws", async () => {
  class TwiceRejectingStore extends InMemoryRunStore {
    updateAttempts = 0;

    override async update(run: Run, expectedPreviousSequence: number): Promise<void> {
      this.updateAttempts += 1;
      if (this.updateAttempts <= 2) throw new Error("transient store failure");
      await super.update(run, expectedPreviousSequence);
    }
  }
  const value = operation("policy.outer-recovery", {});
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new TwiceRejectingStore();
  const scheduled: Array<() => Promise<void>> = [];
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "outer-recovery-run",
    now: () => "2026-08-30T12:50:00.000Z",
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(1),
  });

  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  await scheduled.shift()!();

  assert.equal(store.updateAttempts, 3);
  assert.deepEqual((await store.history("outer-recovery-run")).map(({ state }) => state), [
    "queued",
    "failed",
  ]);
});

test("a store create that commits before throwing cannot leave its run queued", async () => {
  class CommitThenThrowStore extends InMemoryRunStore {
    override async create(run: Run, idempotencyFingerprint?: string): Promise<void> {
      await super.create(run, idempotencyFingerprint);
      throw new Error("acknowledgement lost after commit");
    }
  }
  let handlerCalls = 0;
  const value = operation("policy.create-commit-throw", {
    idempotency: "required",
  }, () => {
    handlerCalls += 1;
    return { output: {} };
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new CommitThenThrowStore();
  const scheduled: Array<() => Promise<void>> = [];
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "committed-before-throw-run",
    now: () => "2026-08-30T12:51:00.000Z",
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(2),
  });

  await manager.create(value.definition.id, requestFor(value, "commit-throw-key"));
  await Promise.all(scheduled.splice(0).map((task) => task()));
  const stored = await store.get("committed-before-throw-run");

  assert.equal(stored?.state === "succeeded" || stored?.state === "failed", true);
  assert.equal(handlerCalls <= 1, true);
});

test("a committed candidate is recovered by fingerprint when its first id lookup fails", async () => {
  class CommitThenThrowWithTransientGetStore extends InMemoryRunStore {
    #failNextGet = true;

    override async create(run: Run, idempotencyFingerprint?: string): Promise<void> {
      await super.create(run, idempotencyFingerprint);
      throw new Error("acknowledgement lost after commit");
    }

    override async get(runId: string): Promise<Run | undefined> {
      if (this.#failNextGet) {
        this.#failNextGet = false;
        throw new Error("transient run-id lookup failure");
      }
      return super.get(runId);
    }
  }
  let handlerCalls = 0;
  const value = operation("policy.create-fingerprint-recovery", {
    idempotency: "required",
  }, () => {
    handlerCalls += 1;
    return { output: {} };
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new CommitThenThrowWithTransientGetStore();
  const scheduled: Array<() => Promise<void>> = [];
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "fingerprint-recovered-candidate",
    now: () => "2026-08-30T12:51:30.000Z",
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(2),
  });

  const created = await manager.create(value.definition.id, requestFor(value, "fingerprint-recovery-key"));
  assert.equal(created.ok, true);
  await Promise.all(scheduled.splice(0).map((task) => task()));

  assert.equal((await store.get("fingerprint-recovered-candidate"))?.state, "succeeded");
  assert.equal(handlerCalls, 1);
});

test("a create error recovers the authoritative fingerprint winner", async () => {
  class WinnerThenThrowStore extends InMemoryRunStore {
    override async create(run: Run, idempotencyFingerprint?: string): Promise<void> {
      await super.create({ ...run, id: "authoritative-winner" }, idempotencyFingerprint);
      throw new Error("winner committed by another writer");
    }
  }
  let handlerCalls = 0;
  const value = operation("policy.create-winner-throw", {
    idempotency: "required",
  }, () => {
    handlerCalls += 1;
    return { output: {} };
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new WinnerThenThrowStore();
  const scheduled: Array<() => Promise<void>> = [];
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "losing-candidate",
    now: () => "2026-08-30T12:52:00.000Z",
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(3),
  });

  const created = await manager.create(value.definition.id, requestFor(value, "winner-key"));
  assert.equal(created.ok && created.run.id, "authoritative-winner");
  await Promise.all(scheduled.splice(0).map((task) => task()));
  assert.equal(handlerCalls, 0);
});

test("a custom scheduler callback is revocable and one-shot", async () => {
  const completion = deferred<{ output: JsonObject }>();
  let handlerCalls = 0;
  let releaseCalls = 0;
  const base = new InMemoryExecutionCoordinator();
  const coordinator: ExecutionCoordinator = {
    acquire(request) {
      const acquisition = base.acquire(request);
      if (acquisition.kind === "conflict") return acquisition;
      return {
        ...acquisition,
        release() {
          releaseCalls += 1;
          return acquisition.release();
        },
      };
    },
    requestCancellation: (request) => base.requestCancellation(request),
  };
  const value = operation("policy.one-shot-scheduler", {}, () => {
    handlerCalls += 1;
    return completion.promise;
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new InMemoryRunStore();
  let callback: (() => Promise<void>) | undefined;
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "one-shot-run",
    now: () => "2026-08-30T12:53:00.000Z",
    schedule: (task) => { callback = task; },
    executionCoordinator: coordinator,
    idempotencySecret: new Uint8Array(32).fill(4),
  });
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  assert.notEqual(callback, undefined);
  const invocations = [callback!(), callback!(), callback!()];
  try {
    await eventually(() => handlerCalls > 0);
    assert.equal(handlerCalls, 1);
    completion.resolve({ output: {} });
    await Promise.all(invocations);
  } finally {
    completion.resolve({ output: {} });
    await Promise.all(invocations);
  }

  assert.equal(releaseCalls, 1);
  assert.equal((await store.get("one-shot-run"))?.state, "succeeded");
});

test("queued cancellation revokes a retained scheduler callback", async () => {
  let handlerCalls = 0;
  let releaseCalls = 0;
  const base = new InMemoryExecutionCoordinator();
  const coordinator: ExecutionCoordinator = {
    acquire(request) {
      const acquisition = base.acquire(request);
      if (acquisition.kind === "conflict") return acquisition;
      return {
        ...acquisition,
        release() {
          releaseCalls += 1;
          return acquisition.release();
        },
      };
    },
    requestCancellation: (request) => base.requestCancellation(request),
  };
  const value = operation("policy.revoked-scheduler", {
    cancellationSupported: true,
  }, () => {
    handlerCalls += 1;
    return { output: {} };
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new InMemoryRunStore();
  let callback: (() => Promise<void>) | undefined;
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "revoked-scheduler-run",
    now: () => "2026-08-30T12:54:00.000Z",
    schedule: (task) => { callback = task; },
    executionCoordinator: coordinator,
    idempotencySecret: new Uint8Array(32).fill(5),
  });
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const cancelled = await manager.cancel(created.run.id);
  assert.equal("state" in cancelled ? cancelled.state : undefined, "cancelled");
  await callback!();
  await callback!();

  assert.equal(handlerCalls, 0);
  assert.equal(releaseCalls, 1);
  assert.deepEqual((await store.history(created.run.id)).map(({ state }) => state), [
    "queued",
    "cancelled",
  ]);
});

test("a shared coordinator carries cancellation between RunManager replicas", async () => {
  const completion = deferred<{ output: JsonObject }>();
  let activeContext: RunContext | undefined;
  const value = operation("policy.shared-cancel", {
    cancellationSupported: true,
    concurrency: "queue",
  }, (_input, context) => {
    activeContext = context;
    return completion.promise;
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const bothTerminalWritersEntered = deferred<void>();
  class BarrierTerminalStore extends InMemoryRunStore {
    terminalAttempts = 0;

    override async update(run: Run, expectedPreviousSequence: number): Promise<void> {
      if (run.state === "cancelled") {
        this.terminalAttempts += 1;
        if (this.terminalAttempts === 2) bothTerminalWritersEntered.resolve();
        await bothTerminalWritersEntered.promise;
      }
      await super.update(run, expectedPreviousSequence);
    }
  }
  const store = new BarrierTerminalStore();
  const coordinator = new InMemoryExecutionCoordinator();
  const scheduled: Array<() => Promise<void>> = [];
  let tick = 0;
  const common = {
    validateSchema: () => [],
    validateFileReference: () => [],
    now: () => `2026-08-30T13:00:${String(tick++).padStart(2, "0")}.000Z`,
    executionCoordinator: coordinator,
    idempotencySecret: new Uint8Array(32).fill(9),
  } as const;
  const replicaA = new RunManager(registry, store, {
    ...common,
    createId: () => "shared-run",
    schedule: (task) => scheduled.push(task),
  });
  const replicaB = new RunManager(registry, store, {
    ...common,
    createId: () => "unused-run",
    schedule: () => assert.fail("replica B must not schedule the remote run"),
  });

  const created = await replicaA.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const task = scheduled.shift();
  assert.notEqual(task, undefined);
  const running = task!();
  try {
    await eventually(() => activeContext !== undefined);
    const cancelled = await replicaB.cancel(created.run.id);
    assert.equal("state" in cancelled ? cancelled.state : undefined, "cancelled");
    assert.equal(activeContext!.signal.aborted, true);
    const beforeLateResult = await store.history(created.run.id);
    activeContext!.warn("late remote warning");
    completion.resolve({ output: { late: true } });
    await running;
    assert.deepEqual(await store.history(created.run.id), beforeLateResult);
  } finally {
    completion.resolve({ output: {} });
    await running;
  }
  assert.deepEqual((await store.history(created.run.id)).map(({ state }) => state), [
    "queued",
    "running",
    "cancelled",
  ]);
  assert.equal(store.terminalAttempts, 2);
});

test("queue keeps the slot until an aborted handler actually settles", async () => {
  const firstCompletion = deferred<{ output: JsonObject }>();
  const secondCompletion = deferred<{ output: JsonObject }>();
  const starts: number[] = [];
  const value = operation("policy.cooperative-slot", {
    cancellationSupported: true,
    concurrency: "queue",
  }, (input) => {
    const position = input.position as number;
    starts.push(position);
    return position === 0 ? firstCompletion.promise : secondCompletion.promise;
  });
  const { manager, scheduled } = harness(value);
  const [first, second] = await Promise.all([0, 1].map((position) =>
    manager.create(value.definition.id, requestFor(value, undefined, { position }))));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  const tasks = scheduled.splice(0).map((task) => task());

  try {
    await eventually(() => starts.length === 1);
    const cancelled = await manager.cancel(first.run.id);
    assert.equal("state" in cancelled ? cancelled.state : undefined, "cancelled");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(starts, [0]);

    firstCompletion.resolve({ output: { late: true } });
    await eventually(() => starts.length === 2);
    assert.deepEqual(starts, [0, 1]);
    secondCompletion.resolve({ output: {} });
    await Promise.all(tasks);
  } finally {
    firstCompletion.resolve({ output: {} });
    secondCompletion.resolve({ output: {} });
    await Promise.all(tasks);
  }
});

test("cancel wins a compare-and-set race with success without a second terminal snapshot", async () => {
  const successWriteEntered = deferred<void>();
  const allowSuccessWrite = deferred<void>();
  class GatedSuccessStore extends InMemoryRunStore {
    override async update(run: Run, expectedPreviousSequence: number): Promise<void> {
      if (run.state === "succeeded") {
        successWriteEntered.resolve();
        await allowSuccessWrite.promise;
      }
      await super.update(run, expectedPreviousSequence);
    }
  }
  const value = operation("policy.cancel-success-race", {
    cancellationSupported: true,
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new GatedSuccessStore();
  const scheduled: Array<() => Promise<void>> = [];
  let tick = 0;
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "cancel-success-run",
    now: () => `2026-08-30T14:00:${String(tick++).padStart(2, "0")}.000Z`,
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(3),
  });
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const running = scheduled.shift()!();

  try {
    await successWriteEntered.promise;
    const cancelled = await manager.cancel(created.run.id);
    assert.equal("state" in cancelled ? cancelled.state : undefined, "cancelled");
  } finally {
    allowSuccessWrite.resolve();
    await running;
  }

  assert.deepEqual((await store.history(created.run.id)).map(({ state }) => state), [
    "queued",
    "running",
    "cancelled",
  ]);
});

test("cancel rereads the authoritative terminal after losing compare-and-set", async () => {
  class SimulatedRaceStore extends InMemoryRunStore {
    conflictInjected = false;

    override async update(run: Run, expectedPreviousSequence: number): Promise<void> {
      if (run.state === "cancelled" && !this.conflictInjected) {
        this.conflictInjected = true;
        await super.update(run, expectedPreviousSequence);
        throw new RunStoreConflictError();
      }
      await super.update(run, expectedPreviousSequence);
    }
  }
  const value = operation("policy.cancel-cas-loser", {
    cancellationSupported: true,
  });
  const registry = new OperationRegistry();
  registry.registerFeature({ id: "policy", label: "Policy" });
  registry.register(value);
  const store = new SimulatedRaceStore();
  const scheduled: Array<() => Promise<void>> = [];
  let tick = 0;
  const manager = new RunManager(registry, store, {
    validateSchema: () => [],
    validateFileReference: () => [],
    createId: () => "cancel-cas-loser-run",
    now: () => `2026-08-30T15:00:${String(tick++).padStart(2, "0")}.000Z`,
    schedule: (task) => scheduled.push(task),
    idempotencySecret: new Uint8Array(32).fill(2),
  });
  const created = await manager.create(value.definition.id, requestFor(value));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const cancelled = await manager.cancel(created.run.id);
  assert.equal("state" in cancelled ? cancelled.state : undefined, "cancelled");
  assert.equal(store.conflictInjected, true);
  await Promise.all(scheduled.splice(0).map((task) => task()));
  assert.deepEqual((await store.history(created.run.id)).map(({ state }) => state), [
    "queued",
    "cancelled",
  ]);
});
