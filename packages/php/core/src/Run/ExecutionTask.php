<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Protocol\ProtocolId;

/**
 * Retryable process-local task envelope. A callback may decline an early turn,
 * but it is never invoked again after completion or revocation. The task cannot
 * be serialized because its closure may retain mapped input and secret values.
 */
final class ExecutionTask
{
    private bool $running = false;

    private bool $completed = false;

    private bool $discarded = false;

    private bool $discardRequested = false;

    private ?\Closure $execute;

    /** @param \Closure(): bool $execute Returns false when the task should be retried. */
    public function __construct(
        public readonly string $runId,
        public readonly string $operationId,
        \Closure $execute,
    ) {
        ProtocolId::assert($runId);
        ProtocolId::assert($operationId);
        $this->execute = $execute;
    }

    /** Returns false only while this task still needs a later retry. */
    public function run(): bool
    {
        if ($this->completed || $this->discarded) {
            return true;
        }
        if ($this->running) {
            return false;
        }
        $this->running = true;
        $execute = $this->execute ?? throw new \LogicException('Execution task has no callback.');
        try {
            $this->completed = $execute();

            return $this->completed;
        } catch (\Throwable $exception) {
            $this->completed = true;

            throw $exception;
        } finally {
            $this->running = false;
            if ($this->completed || $this->discardRequested) {
                $this->discarded = $this->discardRequested;
                $this->execute = null;
            }
        }
    }

    /**
     * Revokes a pending callback and releases everything captured by it.
     * A callback already on the stack cannot be revoked synchronously; the
     * cooperative cancellation signal must let it unwind first.
     */
    public function discard(): bool
    {
        if ($this->completed || $this->discarded) {
            return true;
        }
        if ($this->running) {
            $this->discardRequested = true;

            return false;
        }
        $this->discarded = true;
        $this->execute = null;

        return true;
    }

    public function isDiscarded(): bool
    {
        return $this->discarded;
    }

    /** @return never */
    public function __serialize(): array
    {
        throw new \LogicException('Execution tasks must never be serialized.');
    }
}
