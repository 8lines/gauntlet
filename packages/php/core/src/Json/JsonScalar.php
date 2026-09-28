<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Json;

/** Immutable, deeply validated JSON primitive, including JSON null. */
final readonly class JsonScalar implements JsonValue
{
    private null|bool|string|int|float $value;

    public function __construct(null|bool|string|int|float $value)
    {
        $owned = JsonOwnership::own($value);
        if (!is_null($owned)
            && !is_bool($owned)
            && !is_string($owned)
            && !is_int($owned)
            && !is_float($owned)) {
            throw CanonicalJsonException::invalidValue();
        }
        $this->value = $owned;
    }

    public function jsonSerialize(): null|bool|string|int|float
    {
        return $this->value;
    }

    public function value(): null|bool|string|int|float
    {
        return $this->value;
    }
}
