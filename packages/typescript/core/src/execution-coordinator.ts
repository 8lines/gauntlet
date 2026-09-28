import type {
  ExecutionPolicy,
  Problem,
  ProtocolId,
} from "@8lines/gauntlet-protocol";

type MaybePromise<T> = T | Promise<T>;

export interface ExecutionReservationRequest {
  readonly operationId: ProtocolId;
  readonly runId: ProtocolId;
  readonly concurrency: NonNullable<ExecutionPolicy["concurrency"]>;
}

export interface ExecutionCancellationRequest {
  readonly operationId: ProtocolId;
  readonly runId: ProtocolId;
  readonly reason: Problem;
}

export interface ExecutionLease {
  readonly kind: "acquired";
  /** Resolves to false when a queued reservation is released before its turn. */
  readonly ready: Promise<boolean>;
  /** Carries local or distributed cancellation publication to the handler. */
  readonly signal: AbortSignal;
  /** Resolves conflicts only after durable run reservation succeeds. */
  commitAdmission(): MaybePromise<void>;
  release(): MaybePromise<void>;
}

export interface ExecutionConflict {
  readonly kind: "conflict";
  /** True means the conflicting run was durably admitted; false permits a retry. */
  readonly admissionSettled: Promise<boolean>;
}

export type ExecutionAcquireResult = ExecutionLease | ExecutionConflict;

/**
 * Admission, ordering, and cancellation-publication boundary for execution.
 * The default implementation coordinates one JavaScript process. Multi-replica
 * adapters must inject a shared implementation backed by durable locks/pub-sub.
 */
export interface ExecutionCoordinator {
  acquire(request: ExecutionReservationRequest): MaybePromise<ExecutionAcquireResult>;
  requestCancellation(request: ExecutionCancellationRequest): MaybePromise<boolean>;
}

interface Entry {
  readonly request: ExecutionReservationRequest;
  readonly controller: AbortController;
  readonly settleReady: (ready: boolean) => void;
  readonly admissionSettled: Promise<boolean>;
  readonly settleAdmission: (committed: boolean) => void;
  admissionCommitted: boolean;
  released: boolean;
  readonly lease: ExecutionLease;
}

export class InMemoryExecutionCoordinator implements ExecutionCoordinator {
  readonly #serialized = new Map<string, Entry[]>();
  readonly #byRun = new Map<string, Entry>();

  acquire(request: ExecutionReservationRequest): ExecutionAcquireResult {
    if (this.#byRun.has(request.runId)) {
      throw new TypeError("Duplicate execution run ID");
    }
    const queue = this.#serialized.get(request.operationId) ?? [];
    if (request.concurrency === "forbid" && queue.length > 0) {
      return Object.freeze({
        kind: "conflict" as const,
        admissionSettled: queue[0]!.admissionSettled,
      });
    }

    let settleReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      settleReady = resolve;
    });
    let settleAdmission!: (committed: boolean) => void;
    const admissionSettled = new Promise<boolean>((resolve) => {
      settleAdmission = resolve;
    });
    const entry = {} as Entry;
    const controller = new AbortController();
    const lease: ExecutionLease = Object.freeze({
      kind: "acquired" as const,
      ready,
      signal: controller.signal,
      commitAdmission: () => {
        if (entry.released || entry.admissionCommitted) return;
        entry.admissionCommitted = true;
        settleAdmission(true);
      },
      release: () => this.#release(entry),
    });
    Object.assign(entry, {
      request,
      controller,
      settleReady,
      admissionSettled,
      settleAdmission,
      admissionCommitted: false,
      released: false,
      lease,
    });
    this.#byRun.set(request.runId, entry);

    if (request.concurrency === "allow") {
      settleReady(true);
    } else {
      queue.push(entry);
      this.#serialized.set(request.operationId, queue);
      if (queue.length === 1) settleReady(true);
    }
    return lease;
  }

  requestCancellation(request: ExecutionCancellationRequest): boolean {
    const entry = this.#byRun.get(request.runId);
    if (entry === undefined || entry.request.operationId !== request.operationId) return false;
    if (!entry.controller.signal.aborted) entry.controller.abort(request.reason);
    return true;
  }

  #release(entry: Entry): void {
    if (entry.released) return;
    entry.released = true;
    if (!entry.admissionCommitted) entry.settleAdmission(false);
    if (this.#byRun.get(entry.request.runId) === entry) {
      this.#byRun.delete(entry.request.runId);
    }

    if (entry.request.concurrency === "allow") return;
    const queue = this.#serialized.get(entry.request.operationId);
    if (queue === undefined) return;
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    if (index > 0) entry.settleReady(false);
    if (index === 0) queue[0]?.settleReady(true);
    if (queue.length === 0) this.#serialized.delete(entry.request.operationId);
  }
}
