import type { Run } from "@8lines/gauntlet-protocol";

export interface RunStore {
  create(run: Run, idempotencyFingerprint?: string): Promise<void>;
  get(runId: string): Promise<Run | undefined>;
  findByIdempotencyKey(operationId: string, idempotencyFingerprint: string): Promise<Run | undefined>;
  /** Atomically rejects when the stored sequence no longer matches the caller's snapshot. */
  update(run: Run, expectedPreviousSequence: number): Promise<void>;
}

export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super("Idempotency key already exists");
    this.name = "DuplicateIdempotencyKeyError";
  }
}

export class RunStoreConflictError extends Error {
  constructor() {
    super("Run store compare-and-set conflict");
    this.name = "RunStoreConflictError";
  }
}
