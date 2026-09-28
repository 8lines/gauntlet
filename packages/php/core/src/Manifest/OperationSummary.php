<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Manifest;

use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationPlacement;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolRequirements;

final readonly class OperationSummary
{
    /** @param list<OperationPlacement> $placements */
    private function __construct(
        public string $id,
        public string $revision,
        public string $label,
        public string $featureId,
        public ?Problem $problem,
        public ?ProtocolRequirements $requirements,
        public ?ProtocolExtensions $extensions,
        public array $placements,
    ) {
    }

    public static function available(OperationDefinition $operation): self
    {
        return new self(
            $operation->id,
            $operation->revision(),
            $operation->label,
            $operation->featureId,
            null,
            $operation->requirements,
            $operation->extensions,
            $operation->placements,
        );
    }

    public static function unavailable(OperationDefinition $operation, Problem $problem): self
    {
        return new self(
            $operation->id,
            $operation->revision(),
            $operation->label,
            $operation->featureId,
            $problem,
            $operation->requirements,
            $operation->extensions,
            $operation->placements,
        );
    }

    public function isAvailable(): bool
    {
        return $this->problem === null;
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'id' => $this->id,
            'revision' => $this->revision,
            'label' => $this->label,
            'featureId' => $this->featureId,
            'availability' => $this->problem === null
                ? ['state' => 'available']
                : ['state' => 'unavailable', 'problem' => $this->problem->toProtocolArray()],
        ];
        if ($this->requirements !== null) {
            $document['requirements'] = $this->requirements->toProtocolArray();
        }
        if ($this->placements !== []) {
            $document['placements'] = array_map(
                static fn (OperationPlacement $placement): array => $placement->toProtocolArray(),
                $this->placements,
            );
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
