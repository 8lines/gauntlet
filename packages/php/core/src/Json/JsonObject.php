<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Json;

/**
 * Immutable, explicitly object-shaped JSON node.
 *
 * Pair storage preserves numeric-looking JSON member names that PHP would
 * otherwise cast to integer array keys.
 */
final readonly class JsonObject implements JsonValue
{
    /** @var list<array{0: string, 1: mixed}> */
    private array $entries;

    /**
     * @param array<array-key, mixed>|list<array{0: string, 1: mixed}> $values
     * @internal The second parameter is reserved for JsonOwnership.
     */
    public function __construct(array $values, bool $ownedEntries = false)
    {
        if ($ownedEntries) {
            $this->entries = $values;

            return;
        }

        $entries = [];
        foreach ($values as $key => $value) {
            $entries[] = [(string) $key, $value];
        }
        $this->entries = $entries;
    }

    /** @param list<array{0: string, 1: mixed}> $entries */
    public static function fromEntries(array $entries): self
    {
        return new self($entries, true);
    }

    public function jsonSerialize(): object
    {
        $transport = new \stdClass();
        foreach ($this->entries as [$key, $value]) {
            $transport->{$key} = JsonOwnership::transport($value);
        }

        return $transport;
    }

    /**
     * @return array<string, mixed>
     *
     * Numeric-looking keys can be cast in this convenience projection. The
     * canonical transport always uses entries(), never this method.
     */
    public function values(): array
    {
        $values = [];
        foreach ($this->entries as [$key, $value]) {
            $values[$key] = $value;
        }

        return $values;
    }

    /** @return list<array{0: string, 1: mixed}> */
    public function entries(): array
    {
        return $this->entries;
    }

    public function has(string $name): bool
    {
        foreach ($this->entries as [$key]) {
            if ($key === $name) {
                return true;
            }
        }

        return false;
    }

    public function get(string $name): mixed
    {
        foreach ($this->entries as [$key, $value]) {
            if ($key === $name) {
                return $value;
            }
        }

        return null;
    }

    public function without(string $name): self
    {
        return self::fromEntries(array_values(array_filter(
            $this->entries,
            static fn (array $entry): bool => $entry[0] !== $name,
        )));
    }
}
