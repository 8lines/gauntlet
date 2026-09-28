<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\DataSource;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;

final readonly class DataSourceResolveResponse
{
    /** @param list<array{value: string, item: DataSourceItem|null}> $results */
    public function __construct(
        public array $results,
        public ?ProtocolExtensions $extensions = null,
    ) {
        foreach ($results as $result) {
            if (!is_array($result)
                || array_keys($result) !== ['value', 'item']
                || !is_string($result['value'])
                || ($result['item'] !== null && !$result['item'] instanceof DataSourceItem)
                || ($result['item'] !== null && $result['item']->value !== $result['value'])) {
                throw new \InvalidArgumentException('Invalid data source resolve result.');
            }
        }
    }

    public static function fromRequest(DataSourceResolveRequest $request, callable $resolve): self
    {
        $results = [];
        foreach ($request->values as $value) {
            $item = $resolve($value);
            if ($item !== null && !$item instanceof DataSourceItem) {
                throw new \InvalidArgumentException('Resolver must return DataSourceItem or null.');
            }
            $results[] = ['value' => $value, 'item' => $item];
        }

        return new self($results);
    }

    /** @return array{results: list<array{value: string, item: array<string, mixed>|null}>} */
    public function toProtocolArray(): array
    {
        $document = [
            'results' => array_map(
                static fn (array $result): array => [
                    'value' => $result['value'],
                    'item' => $result['item']?->toProtocolArray(),
                ],
                $this->results,
            ),
        ];
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
