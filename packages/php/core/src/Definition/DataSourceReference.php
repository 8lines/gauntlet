<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Protocol\JsonPointer;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class DataSourceReference
{
    /**
     * @param list<string> $dependencyPointers
     * @param list<string> $contextPointers
     */
    public function __construct(
        public string $id,
        public string $inputPointer,
        public array $dependencyPointers = [],
        public array $contextPointers = [],
        public ?bool $required = null,
    ) {
        ProtocolId::assert($id);
        JsonPointer::assert($inputPointer);
        ProtocolValue::assertUniqueStrings($dependencyPointers, 'dependency pointers');
        ProtocolValue::assertUniqueStrings($contextPointers, 'context pointers');
        foreach ([...$dependencyPointers, ...$contextPointers] as $pointer) {
            JsonPointer::assert($pointer);
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'id' => $this->id,
            'inputPointer' => $this->inputPointer,
            // Required by the v1 envelope even when no dependencies exist.
            'dependencyPointers' => $this->dependencyPointers,
        ];
        if ($this->contextPointers !== []) {
            $document['contextPointers'] = $this->contextPointers;
        }
        if ($this->required !== null) {
            $document['required'] = $this->required;
        }

        return $document;
    }
}
