<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunStoreCreateResult;

interface RunStore
{
    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult;

    public function get(string $runId): ?Run;

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run;

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool;
}
