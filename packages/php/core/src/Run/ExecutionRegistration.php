<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Protocol\ProtocolId;

final readonly class ExecutionRegistration
{
    private function __construct(
        public ExecutionRegistrationStatus $status,
        public ?string $duplicateRunId = null,
    ) {
        if (($status === ExecutionRegistrationStatus::DUPLICATE) !== ($duplicateRunId !== null)) {
            throw new \InvalidArgumentException('Duplicate registration requires exactly one Run ID.');
        }
        if ($duplicateRunId !== null) {
            ProtocolId::assert($duplicateRunId);
        }
    }

    public static function ready(): self
    {
        return new self(ExecutionRegistrationStatus::READY);
    }

    public static function queued(): self
    {
        return new self(ExecutionRegistrationStatus::QUEUED);
    }

    public static function rejected(): self
    {
        return new self(ExecutionRegistrationStatus::REJECTED);
    }

    public static function duplicate(string $runId): self
    {
        return new self(ExecutionRegistrationStatus::DUPLICATE, $runId);
    }
}
