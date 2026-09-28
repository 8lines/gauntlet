<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;

final readonly class OperationOutput
{
    public function __construct(
        public JsonObject $schema,
        public ?JsonObject $presentation = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        TcSchemaCore::assert($schema);
        if ($presentation !== null) {
            self::assertPresentation($presentation);
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['schema' => $this->schema];
        if ($this->presentation !== null) {
            $document['presentation'] = $this->presentation;
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }

    private static function assertPresentation(JsonObject $presentation): void
    {
        $value = $presentation->jsonSerialize();
        $allowed = ['profile', 'defaultView'];
        foreach (array_keys(get_object_vars($value)) as $key) {
            if (!in_array($key, $allowed, true)) {
                throw new \InvalidArgumentException('Invalid output presentation.');
            }
        }
        if (!property_exists($value, 'profile') || $value->profile !== 'tc-rich-results@1') {
            throw new \InvalidArgumentException('Invalid output presentation profile.');
        }
        if (property_exists($value, 'defaultView')
            && !in_array($value->defaultView, ['summary', 'details', 'artifacts'], true)) {
            throw new \InvalidArgumentException('Invalid default output view.');
        }
    }
}
