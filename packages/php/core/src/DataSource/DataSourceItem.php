<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\DataSource;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;

final readonly class DataSourceItem
{
    public function __construct(
        public string $value,
        public string $label,
        public ?string $description = null,
        public ?string $group = null,
        public ?bool $disabled = null,
        public ?JsonObject $metadata = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['value' => $this->value, 'label' => $this->label];
        foreach ([
            'description' => $this->description,
            'group' => $this->group,
            'disabled' => $this->disabled,
            'metadata' => $this->metadata,
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
}
