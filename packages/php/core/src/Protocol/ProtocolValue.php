<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Protocol;

final class ProtocolValue
{
    public const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

    public static function assertNonBlank(string $value, string $name): void
    {
        if (trim($value) === '') {
            throw new \InvalidArgumentException($name . ' must not be blank.');
        }
    }

    public static function assertRfc3339(string $value): void
    {
        if (preg_match(
            '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/D',
            $value,
        ) !== 1) {
            throw new \InvalidArgumentException('Invalid RFC 3339 timestamp.');
        }

        try {
            new \DateTimeImmutable($value);
        } catch (\Throwable) {
            throw new \InvalidArgumentException('Invalid RFC 3339 timestamp.');
        }
        $parseErrors = \DateTimeImmutable::getLastErrors();
        if (is_array($parseErrors)
            && ($parseErrors['warning_count'] > 0 || $parseErrors['error_count'] > 0)) {
            throw new \InvalidArgumentException('Invalid RFC 3339 timestamp.');
        }
    }

    public static function assertHttpUrl(string $value): void
    {
        $scheme = parse_url($value, PHP_URL_SCHEME);
        $host = parse_url($value, PHP_URL_HOST);
        if (preg_match('/^[Hh][Tt][Tt][Pp][Ss]?:\/\//D', $value) !== 1
            || !is_string($scheme)
            || !in_array(strtolower($scheme), ['http', 'https'], true)
            || !is_string($host)
            || $host === ''
            || filter_var($value, FILTER_VALIDATE_URL) === false) {
            throw new \InvalidArgumentException('Invalid HTTP URL.');
        }
    }

    /** @param list<string> $values */
    public static function assertUniqueStrings(array $values, string $name, bool $versioned = false): void
    {
        $seen = [];
        foreach ($values as $value) {
            if (!is_string($value) || isset($seen[$value])) {
                throw new \InvalidArgumentException('Invalid ' . $name . '.');
            }
            if ($versioned) {
                ProtocolId::assertVersioned($value);
            }
            $seen[$value] = true;
        }
    }
}
