<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Protocol\JsonPointer;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class InputHandling
{
    /** @param list<array<string, mixed>> $rules */
    public function __construct(public array $rules)
    {
        foreach ($rules as $rule) {
            self::assertRule($rule);
        }
    }

    /** @return array{rules: list<array<string, mixed>>} */
    public function toProtocolArray(): array
    {
        return ['rules' => $this->rules];
    }

    public function hasSecrets(): bool
    {
        return $this->secretSchemaPointers() !== [];
    }

    /** @return list<string> */
    public function secretSchemaPointers(): array
    {
        $pointers = [];
        foreach ($this->rules as $rule) {
            if ($rule['kind'] === 'secret') {
                $pointers[] = $rule['schemaPointer'];
            }
        }

        return $pointers;
    }

    public function hasFiles(): bool
    {
        foreach ($this->rules as $rule) {
            if ($rule['kind'] === 'file') {
                return true;
            }
        }

        return false;
    }

    /** @param array<string, mixed> $rule */
    private static function assertRule(array $rule): void
    {
        $kind = $rule['kind'] ?? null;
        $pointer = $rule['schemaPointer'] ?? null;
        if (!is_string($pointer)) {
            throw new \InvalidArgumentException('Input rule requires a schemaPointer.');
        }
        JsonPointer::assert($pointer);

        if ($kind === 'secret') {
            self::assertExactKeys($rule, ['kind', 'schemaPointer', 'retention']);
            if (($rule['retention'] ?? null) !== 'none') {
                throw new \InvalidArgumentException('Secret retention must be none.');
            }

            return;
        }

        if ($kind !== 'file') {
            throw new \InvalidArgumentException('Input rule kind is not supported.');
        }
        self::assertAllowedKeys($rule, ['kind', 'schemaPointer', 'multiple', 'mediaTypes', 'maxBytes']);
        if (!array_key_exists('multiple', $rule) || !is_bool($rule['multiple'])) {
            throw new \InvalidArgumentException('File rule requires a boolean multiple member.');
        }
        if (isset($rule['mediaTypes'])) {
            if (!is_array($rule['mediaTypes']) || !array_is_list($rule['mediaTypes'])) {
                throw new \InvalidArgumentException('File mediaTypes must be a list.');
            }
            ProtocolValue::assertUniqueStrings($rule['mediaTypes'], 'file media types');
            foreach ($rule['mediaTypes'] as $mediaType) {
                ProtocolValue::assertNonBlank($mediaType, 'File media type');
            }
        }
        if (isset($rule['maxBytes'])
            && (!is_int($rule['maxBytes']) || $rule['maxBytes'] < 1 || $rule['maxBytes'] > ProtocolValue::MAX_SAFE_INTEGER)) {
            throw new \InvalidArgumentException('Invalid file maximum size.');
        }
    }

    /** @param array<string, mixed> $value @param list<string> $keys */
    private static function assertExactKeys(array $value, array $keys): void
    {
        self::assertAllowedKeys($value, $keys);
        foreach ($keys as $key) {
            if (!array_key_exists($key, $value)) {
                throw new \InvalidArgumentException('Input rule is incomplete.');
            }
        }
    }

    /** @param array<string, mixed> $value @param list<string> $keys */
    private static function assertAllowedKeys(array $value, array $keys): void
    {
        foreach (array_keys($value) as $key) {
            if (!is_string($key) || !in_array($key, $keys, true)) {
                throw new \InvalidArgumentException('Input rule contains an unsupported member.');
            }
        }
    }
}
