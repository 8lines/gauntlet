<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class FeatureDefinition
{
    public function __construct(
        public string $id,
        public string $label,
        public ?string $parentId = null,
        public int $order = 0,
        public ?string $description = null,
        public ?string $icon = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($id);
        ProtocolValue::assertNonBlank($label, 'Feature label');
        if ($parentId !== null) {
            ProtocolId::assert($parentId);
            if ($parentId === $id) {
                throw new \InvalidArgumentException('Feature cannot be its own parent.');
            }
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['id' => $this->id, 'label' => $this->label, 'order' => $this->order];
        foreach (['description' => $this->description, 'icon' => $this->icon, 'parentId' => $this->parentId] as $key => $value) {
            if ($value !== null) {
                $document[$key] = $value;
            }
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
