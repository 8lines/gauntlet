<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Protocol;

final class JsonPointer
{
    public static function assert(string $pointer): void
    {
        if (preg_match('/^(?:\/(?:[^~\/]|~[01])*)*$/Du', $pointer) !== 1) {
            throw new \InvalidArgumentException('Invalid JSON Pointer.');
        }
    }

    /** @return list<string> */
    public static function segments(string $pointer): array
    {
        self::assert($pointer);
        if ($pointer === '') {
            return [];
        }

        return array_map(
            static fn (string $segment): string => str_replace(['~1', '~0'], ['/', '~'], $segment),
            explode('/', substr($pointer, 1)),
        );
    }

    public static function escape(string $segment): string
    {
        return str_replace(['~', '/'], ['~0', '~1'], $segment);
    }
}
