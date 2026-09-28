<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Protocol;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;

final readonly class ProtocolExtensions
{
    public function __construct(public JsonObject $values)
    {
        foreach ($values->entries() as [$key]) {
            if (preg_match('/^urn:[A-Za-z0-9][A-Za-z0-9:._\/-]*$/D', $key) !== 1) {
                throw new \InvalidArgumentException('Invalid extension key.');
            }
        }
    }

    /** @param array<array-key, mixed> $values */
    public static function fromArray(array $values): self
    {
        return new self(JsonOwnership::object($values));
    }

    public function toProtocolArray(): object
    {
        return $this->values->jsonSerialize();
    }
}
