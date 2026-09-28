<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;

final readonly class ConfirmationAcknowledgement
{
    public function __construct(
        public string $operationId,
        public string $operationRevision,
        public OperationImpact $impact,
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($operationId);
        ProtocolId::assertRevision($operationRevision);
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'operationId' => $this->operationId,
            'operationRevision' => $this->operationRevision,
            'impact' => $this->impact->value,
        ];
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
