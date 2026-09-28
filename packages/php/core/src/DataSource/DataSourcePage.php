<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\DataSource;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;

final readonly class DataSourcePage
{
    /** @param list<DataSourceItem> $items */
    public function __construct(
        public array $items,
        public ?string $nextCursor = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        foreach ($items as $item) {
            if (!$item instanceof DataSourceItem) {
                throw new \InvalidArgumentException('Data source page items must be typed values.');
            }
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'items' => array_map(
                static fn (DataSourceItem $item): array => $item->toProtocolArray(),
                $this->items,
            ),
        ];
        if ($this->nextCursor !== null) {
            $document['nextCursor'] = $this->nextCursor;
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
