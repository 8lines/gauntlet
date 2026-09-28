<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;

final readonly class CreateRunRequest
{
    public function __construct(
        public string $operationRevision,
        public JsonObject $input,
        public ?InvocationContext $context = null,
        public bool $dryRun = false,
        public ?string $idempotencyKey = null,
        public ?ProtocolExtensions $extensions = null,
        public ?ConfirmationAcknowledgement $confirmation = null,
    ) {
        ProtocolId::assertRevision($operationRevision);
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'operationRevision' => $this->operationRevision,
            'input' => $this->input,
        ];
        if ($this->context !== null) {
            $document['context'] = $this->context->toProtocolArray();
        }
        if ($this->dryRun) {
            $document['dryRun'] = true;
        }
        if ($this->idempotencyKey !== null) {
            $document['idempotencyKey'] = $this->idempotencyKey;
        }
        if ($this->confirmation !== null) {
            $document['confirmation'] = $this->confirmation->toProtocolArray();
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
