<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Json;

final readonly class JsonList implements JsonValue
{
    /** @param list<mixed> $values */
    public function __construct(private array $values)
    {
    }

    /** @return list<mixed> */
    public function jsonSerialize(): array
    {
        return array_map(JsonOwnership::transport(...), $this->values);
    }

    /** @return list<mixed> */
    public function values(): array
    {
        return $this->values;
    }
}
