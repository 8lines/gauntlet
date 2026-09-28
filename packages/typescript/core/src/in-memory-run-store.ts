import type { Run } from "@8lines/gauntlet-protocol";
import { cloneAndDeepFreeze } from "./operation-internals.js";
import { assertCanonicalRun } from "./runtime-validation.js";
import {
  DuplicateIdempotencyKeyError,
  RunStoreConflictError,
  type RunStore,
} from "./run-store.js";

function immutableSnapshot(run: Run): Run {
  return cloneAndDeepFreeze(run);
}

function assertValidSnapshot(run: Run): void {
  assertCanonicalRun(run);
  const terminal = ["succeeded", "failed", "partial", "cancelled", "timed_out", "expired"].includes(run.state);
  const failed = ["failed", "partial", "cancelled", "timed_out", "expired"].includes(run.state);

  if (terminal !== (run.completedAt !== undefined)) {
    throw new TypeError("Terminal runs must have completedAt and active runs must not");
  }
  if (failed !== (run.problem !== undefined)) {
    throw new TypeError("Failed terminal runs must have a Problem and other states must not");
  }
}

function assertTimestampOrder(run: Run, previous?: Run): void {
  const createdAt = Date.parse(run.createdAt);
  const updatedAt = Date.parse(run.updatedAt);
  const startedAt = run.startedAt === undefined ? undefined : Date.parse(run.startedAt);
  const completedAt = run.completedAt === undefined ? undefined : Date.parse(run.completedAt);
  if (updatedAt < createdAt
    || (startedAt !== undefined && (startedAt < createdAt || startedAt > updatedAt))
    || (completedAt !== undefined && (completedAt > updatedAt
      || (startedAt !== undefined && completedAt < startedAt)))
    || (previous !== undefined && updatedAt < Date.parse(previous.updatedAt))) {
    throw new TypeError("Run timestamps must be chronological and nondecreasing");
  }
}

function assertTransition(previous: Run, next: Run): void {
  if (next.id !== previous.id || next.operationId !== previous.operationId
    || next.operationRevision !== previous.operationRevision || next.createdAt !== previous.createdAt) {
    throw new TypeError("Run identity cannot change");
  }
  if (next.sequence !== previous.sequence + 1) {
    throw new TypeError("Run sequence must increase by exactly one");
  }
  if (previous.state === "queued" && next.state !== "running" && ![
    "succeeded",
    "failed",
    "partial",
    "cancelled",
    "timed_out",
    "expired",
  ].includes(next.state)) {
    throw new TypeError("A queued run can only transition to running or terminal");
  }
  if (previous.state === "running" && ![
    "running",
    "succeeded",
    "failed",
    "partial",
    "cancelled",
    "timed_out",
    "expired",
  ].includes(next.state)) {
    throw new TypeError("Invalid running transition");
  }
  if (previous.state !== "queued" && previous.state !== "running") {
    throw new TypeError("Terminal runs cannot be updated");
  }
}

export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, Run>();
  readonly #history = new Map<string, readonly Run[]>();
  readonly #idempotency = new Map<string, Map<string, string>>();

  async create(run: Run, idempotencyFingerprint?: string): Promise<void> {
    assertValidSnapshot(run);
    if (run.state !== "queued" || run.sequence !== 0) {
      throw new TypeError("A newly created run must be queued at sequence zero");
    }
    assertTimestampOrder(run);
    if (this.#runs.has(run.id)) {
      throw new TypeError("Run ID already exists");
    }

    if (idempotencyFingerprint !== undefined) {
      const keys = this.#idempotency.get(run.operationId);
      if (keys?.has(idempotencyFingerprint) === true) {
        throw new DuplicateIdempotencyKeyError();
      }
    }

    const snapshot = immutableSnapshot(run);
    this.#runs.set(run.id, snapshot);
    this.#history.set(run.id, Object.freeze([snapshot]));
    if (idempotencyFingerprint !== undefined) {
      const keys = this.#idempotency.get(run.operationId) ?? new Map<string, string>();
      keys.set(idempotencyFingerprint, run.id);
      this.#idempotency.set(run.operationId, keys);
    }
  }

  async get(runId: string): Promise<Run | undefined> {
    return this.#runs.get(runId);
  }

  async findByIdempotencyKey(
    operationId: string,
    idempotencyFingerprint: string,
  ): Promise<Run | undefined> {
    const runId = this.#idempotency.get(operationId)?.get(idempotencyFingerprint);
    return runId === undefined ? undefined : this.#runs.get(runId);
  }

  async update(run: Run, expectedPreviousSequence: number): Promise<void> {
    assertValidSnapshot(run);
    const previous = this.#runs.get(run.id);
    if (previous === undefined) {
      throw new TypeError("Cannot update an unknown run");
    }
    if (previous.sequence !== expectedPreviousSequence) {
      throw new RunStoreConflictError();
    }
    assertTimestampOrder(run, previous);
    assertTransition(previous, run);

    const snapshot = immutableSnapshot(run);
    this.#runs.set(run.id, snapshot);
    const history = this.#history.get(run.id) ?? [];
    this.#history.set(run.id, Object.freeze([...history, snapshot]));
  }

  async all(): Promise<readonly Run[]> {
    return Object.freeze([...this.#runs.values()].sort((left, right) => left.id.localeCompare(right.id)));
  }

  async history(runId: string): Promise<readonly Run[]> {
    return this.#history.get(runId) ?? Object.freeze([]);
  }
}
