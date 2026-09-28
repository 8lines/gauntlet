<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class ExecutionPolicy
{
    public function __construct(
        public OperationImpact $impact,
        public bool $confirmationRequired,
        public bool $dryRunSupported,
        public string $idempotency,
        public bool $cancellationSupported,
        public ?int $timeoutSeconds = null,
        public ?string $concurrency = null,
    ) {
        if (!in_array($idempotency, ['none', 'optional', 'required'], true)) {
            throw new \InvalidArgumentException('Invalid idempotency policy.');
        }
        if ($impact === OperationImpact::DESTRUCTIVE
            && (!$confirmationRequired || $idempotency !== 'required')) {
            throw new \InvalidArgumentException(
                'Destructive operations require confirmation and required idempotency.',
            );
        }
        if ($timeoutSeconds !== null
            && ($timeoutSeconds < 1 || $timeoutSeconds > ProtocolValue::MAX_SAFE_INTEGER)) {
            throw new \InvalidArgumentException('Invalid execution timeout.');
        }
        if ($concurrency !== null && !in_array($concurrency, ['allow', 'forbid', 'queue'], true)) {
            throw new \InvalidArgumentException('Invalid concurrency policy.');
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'impact' => $this->impact->value,
            'confirmationRequired' => $this->confirmationRequired,
            'dryRunSupported' => $this->dryRunSupported,
            'idempotency' => $this->idempotency,
            'cancellationSupported' => $this->cancellationSupported,
        ];
        if ($this->timeoutSeconds !== null) {
            $document['timeoutSeconds'] = $this->timeoutSeconds;
        }
        if ($this->concurrency !== null) {
            $document['concurrency'] = $this->concurrency;
        }

        return $document;
    }
}
