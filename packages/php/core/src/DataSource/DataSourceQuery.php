<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\DataSource;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;
use EightLines\Gauntlet\Core\Run\InvocationContext;

final readonly class DataSourceQuery
{
    public function __construct(
        public ?string $search,
        public ?string $cursor,
        public ?int $limit,
        public JsonObject $dependencies,
        public ?InvocationContext $context = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        if ($limit !== null && ($limit < 1 || $limit > ProtocolValue::MAX_SAFE_INTEGER)) {
            throw new \InvalidArgumentException('Invalid data source query limit.');
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['dependencies' => $this->dependencies];
        foreach (['search' => $this->search, 'cursor' => $this->cursor, 'limit' => $this->limit] as $key => $value) {
            if ($value !== null) {
                $document[$key] = $value;
            }
        }
        if ($this->context !== null) {
            $document['context'] = $this->context->toProtocolArray();
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
