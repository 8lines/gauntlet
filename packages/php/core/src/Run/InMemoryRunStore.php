<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Contract\RunStore;

/** Process-local reference store used by tests and single-process development. */
final class InMemoryRunStore implements RunStore
{
    /** @var array<string, Run> */
    private array $runs = [];

    /** @var array<string, array<string, string>> */
    private array $fingerprints = [];

    /** @var array<string, list<Run>> */
    private array $snapshots = [];

    public function createQueued(Run $run, ?string $fingerprint = null): RunStoreCreateResult
    {
        if (
            $run->state !== RunStatus::QUEUED
            || $run->sequence !== 0
            || !RuntimeGuard::canonicalRunIsValid($run)
        ) {
            throw new \InvalidArgumentException('RunStore can only create a sequence-zero queued Run.');
        }
        if ($fingerprint !== null && isset($this->fingerprints[$run->operationId][$fingerprint])) {
            $winningId = $this->fingerprints[$run->operationId][$fingerprint];

            return RunStoreCreateResult::duplicate($this->runs[$winningId]);
        }
        if (isset($this->runs[$run->id])) {
            return RunStoreCreateResult::duplicate($this->runs[$run->id]);
        }

        $this->runs[$run->id] = $run;
        $this->snapshots[$run->id] = [$run];
        if ($fingerprint !== null) {
            $this->fingerprints[$run->operationId][$fingerprint] = $run->id;
        }

        return RunStoreCreateResult::created($run);
    }

    public function get(string $id): ?Run
    {
        return $this->runs[$id] ?? null;
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        $id = $this->fingerprints[$operationId][$fingerprint] ?? null;

        return $id === null ? null : ($this->runs[$id] ?? null);
    }

    public function updateExactSequence(Run $run, int $previous): bool
    {
        $stored = $this->runs[$run->id] ?? null;
        if ($stored === null
            || $stored->sequence !== $previous
            || $run->sequence !== $previous + 1
            || $run->operationId !== $stored->operationId
            || $run->operationRevision !== $stored->operationRevision
            || $run->createdAt !== $stored->createdAt
            || !RuntimeGuard::canonicalRunIsValid($run)
            || self::timestamp($run->updatedAt) < self::timestamp($stored->updatedAt)
            || !self::transitionIsValid($stored->state, $run->state)) {
            return false;
        }

        $this->runs[$run->id] = $run;
        $this->snapshots[$run->id][] = $run;

        return true;
    }

    /** @return list<Run> */
    public function all(): array
    {
        return array_values($this->runs);
    }

    /** @return list<Run> */
    public function snapshots(string $runId): array
    {
        return $this->snapshots[$runId] ?? [];
    }

    public function containsText(string $text): bool
    {
        return str_contains(serialize($this->runs), $text)
            || str_contains(serialize($this->fingerprints), $text)
            || str_contains(serialize($this->snapshots), $text);
    }

    private static function transitionIsValid(RunStatus $previous, RunStatus $next): bool
    {
        if ($previous === RunStatus::QUEUED) {
            return $next === RunStatus::RUNNING || $next->terminal();
        }

        return $previous === RunStatus::RUNNING
            && ($next === RunStatus::RUNNING || $next->terminal());
    }

    private static function timestamp(string $value): float
    {
        return (float) (new \DateTimeImmutable($value))->format('U.u');
    }
}
