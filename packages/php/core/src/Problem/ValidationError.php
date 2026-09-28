<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Problem;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;

final readonly class ValidationError
{
    public function __construct(
        public string $instancePath,
        public string $schemaPath,
        public string $keyword,
        public string $message,
        public JsonObject $params,
        public ?ProtocolExtensions $extensions = null,
    ) {
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'instancePath' => $this->instancePath,
            'schemaPath' => $this->schemaPath,
            'keyword' => $this->keyword,
            'message' => $this->message,
            'params' => $this->params,
        ];
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
