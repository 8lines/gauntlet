<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Registry;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class RegistryDiagnostic
{
    public function __construct(
        public string $code,
        public string $message,
        public string $severity = 'error',
        public ?string $operationId = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        if (preg_match('/^[a-z][a-z0-9_]*$/D', $code) !== 1) {
            throw new \InvalidArgumentException('Invalid diagnostic code.');
        }
        ProtocolValue::assertNonBlank($message, 'Diagnostic message');
        if (!in_array($severity, ['info', 'warning', 'error'], true)) {
            throw new \InvalidArgumentException('Invalid diagnostic severity.');
        }
        if ($operationId !== null) {
            ProtocolId::assert($operationId);
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['severity' => $this->severity, 'code' => $this->code, 'message' => $this->message];
        if ($this->operationId !== null) {
            $document['operationId'] = $this->operationId;
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
