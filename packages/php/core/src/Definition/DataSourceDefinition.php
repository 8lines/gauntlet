<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;

final readonly class DataSourceDefinition
{
    public function __construct(
        public string $id,
        public string $label,
        public bool $search = true,
        public string $pagination = 'cursor',
        public bool $resolve = true,
        public int $defaultLimit = 20,
        public int $maxLimit = 100,
        public ?string $description = null,
        public ?JsonObject $dependencySchema = null,
        public ?JsonObject $contextSchema = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($id);
        ProtocolValue::assertNonBlank($label, 'Data source label');
        if ($pagination !== 'cursor' || !$resolve) {
            throw new \InvalidArgumentException('Gauntlet v1 requires cursor pagination and resolve support.');
        }
        if ($defaultLimit < 1 || $maxLimit < $defaultLimit || $maxLimit > ProtocolValue::MAX_SAFE_INTEGER) {
            throw new \InvalidArgumentException('Invalid data source limits.');
        }
        if ($dependencySchema !== null) {
            TcSchemaCore::assert($dependencySchema, true);
        }
        if ($contextSchema !== null) {
            TcSchemaCore::assert($contextSchema, true);
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'id' => $this->id,
            'label' => $this->label,
            'capabilities' => [
                'search' => $this->search,
                'pagination' => $this->pagination,
                'resolve' => $this->resolve,
                'defaultLimit' => $this->defaultLimit,
                'maxLimit' => $this->maxLimit,
            ],
        ];
        if ($this->description !== null) {
            $document['description'] = $this->description;
        }
        if ($this->dependencySchema !== null) {
            $document['dependencySchema'] = $this->dependencySchema;
        }
        if ($this->contextSchema !== null) {
            $document['contextSchema'] = $this->contextSchema;
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
