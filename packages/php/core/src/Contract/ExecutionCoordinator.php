<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Run\ExecutionRegistration;

/**
 * Coordinates admission, FIFO execution and cooperative cancellation.
 *
 * Multi-process deployments must bind this SPI to the same shared backend as
 * their RunStore. Implementations must never receive raw idempotency keys.
 */
interface ExecutionCoordinator
{
    /**
     * Atomically registers admission. A matching non-null fingerprint must
     * resolve as DUPLICATE before forbid/busy evaluation, and DUPLICATE may be
     * returned only after the winner's RunStore reservation is readable.
     */
    public function register(
        string $operationId,
        string $runId,
        string $concurrency,
        ?string $idempotencyFingerprint,
    ): ExecutionRegistration;

    /** Makes a registration visible as an accepted queued Run. */
    public function publish(string $runId): void;

    /** Removes a registration whose Run reservation failed. */
    public function abort(string $runId): void;

    /**
     * Blocks cooperatively until this registered Run owns its execution turn.
     * Returns null when the current execution mechanism cannot wait; the task
     * remains registered and may be retried later without changing the Run.
     */
    public function awaitTurn(string $operationId, string $runId): ?bool;

    public function release(string $operationId, string $runId): void;

    public function requestCancellation(string $runId): void;

    public function isCancellationRequested(string $runId): bool;
}
