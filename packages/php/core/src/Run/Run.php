<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;
use EightLines\Gauntlet\Core\Result\Artifact;

final readonly class Run
{
    /**
     * @param list<Artifact> $artifacts
     * @param list<FollowUpAction> $actions
     */
    public function __construct(
        public string $id,
        public string $operationId,
        public string $operationRevision,
        public int $sequence,
        public RunStatus $state,
        public string $createdAt,
        public string $updatedAt,
        public ?string $startedAt = null,
        public ?string $completedAt = null,
        public ?RunProgress $progress = null,
        public ?RunSummary $summary = null,
        public ?JsonValue $output = null,
        public array $artifacts = [],
        public array $actions = [],
        public ?Problem $problem = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($id);
        ProtocolId::assert($operationId);
        ProtocolId::assertRevision($operationRevision);
        if ($sequence < 0 || $sequence > ProtocolValue::MAX_SAFE_INTEGER) {
            throw new \InvalidArgumentException('Invalid Run sequence.');
        }
        ProtocolValue::assertRfc3339($createdAt);
        ProtocolValue::assertRfc3339($updatedAt);
        foreach ([$startedAt, $completedAt] as $timestamp) {
            if ($timestamp !== null) {
                ProtocolValue::assertRfc3339($timestamp);
            }
        }
        foreach ($artifacts as $artifact) {
            if (!$artifact instanceof Artifact) {
                throw new \InvalidArgumentException('Run artifacts must be typed Artifact values.');
            }
        }
        foreach ($actions as $action) {
            if (!$action instanceof FollowUpAction) {
                throw new \InvalidArgumentException('Run actions must be typed FollowUpAction values.');
            }
        }
        self::assertStateUnion($state, $completedAt, $problem);
    }

    /** @param array<string, mixed> $changes */
    public function with(array $changes): self
    {
        $allowed = array_fill_keys(array_keys(get_object_vars($this)), true);
        foreach (array_keys($changes) as $key) {
            if (!isset($allowed[$key])) {
                throw new \InvalidArgumentException('Unknown Run member.');
            }
        }

        return new self(...array_replace(get_object_vars($this), $changes));
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'id' => $this->id,
            'operationId' => $this->operationId,
            'operationRevision' => $this->operationRevision,
            'sequence' => $this->sequence,
            'state' => $this->state->value,
            'createdAt' => $this->createdAt,
            'updatedAt' => $this->updatedAt,
            'artifacts' => array_map(
                static fn (Artifact $artifact): array => $artifact->toProtocolArray(),
                $this->artifacts,
            ),
            'actions' => array_map(
                static fn (FollowUpAction $action): array => $action->toProtocolArray(),
                $this->actions,
            ),
        ];
        foreach ([
            'startedAt' => $this->startedAt,
            'completedAt' => $this->completedAt,
            'progress' => $this->progress?->toProtocolArray(),
            'summary' => $this->summary?->toProtocolArray(),
            'output' => $this->output,
            'problem' => $this->problem?->toProtocolArray(),
        ] as $key => $value) {
            if ($value !== null) {
                $document[$key] = $value;
            }
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }

    private static function assertStateUnion(
        RunStatus $state,
        ?string $completedAt,
        ?Problem $problem,
    ): void {
        if (!$state->terminal()) {
            if ($completedAt !== null || $problem !== null) {
                throw new \InvalidArgumentException('Active Runs cannot be completed or contain a problem.');
            }

            return;
        }
        if ($completedAt === null) {
            throw new \InvalidArgumentException('Terminal Runs require completedAt.');
        }
        if ($state === RunStatus::SUCCEEDED && $problem !== null) {
            throw new \InvalidArgumentException('Succeeded Runs cannot contain a problem.');
        }
        if ($state !== RunStatus::SUCCEEDED && $problem === null) {
            throw new \InvalidArgumentException('Unsuccessful terminal Runs require a problem.');
        }
        $canonicalProblem = match ($state) {
            RunStatus::CANCELLED => [
                'urn:gauntlet:problem:run-cancelled',
                'Run cancelled',
                409,
            ],
            RunStatus::TIMED_OUT => [
                'urn:gauntlet:problem:run-timed-out',
                'Run timed out',
                504,
            ],
            default => null,
        };
        if ($canonicalProblem !== null && (
            $problem?->type !== $canonicalProblem[0]
            || $problem->title !== $canonicalProblem[1]
            || $problem->status !== $canonicalProblem[2]
        )) {
            throw new \InvalidArgumentException('Execution terminal Run contains a non-canonical problem.');
        }
    }
}
