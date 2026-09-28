<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\JsonPointer;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class OperationPreset
{
    /** @param list<string> $lockedPointers */
    public function __construct(
        public string $id,
        public string $label,
        public JsonObject $input,
        public ?string $description = null,
        public array $lockedPointers = [],
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($id);
        ProtocolValue::assertNonBlank($label, 'Preset label');
        ProtocolValue::assertUniqueStrings($lockedPointers, 'locked pointers');
        foreach ($lockedPointers as $pointer) {
            JsonPointer::assert($pointer);
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['id' => $this->id, 'label' => $this->label, 'input' => $this->input];
        if ($this->description !== null) {
            $document['description'] = $this->description;
        }
        if ($this->lockedPointers !== []) {
            $document['lockedPointers'] = $this->lockedPointers;
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
