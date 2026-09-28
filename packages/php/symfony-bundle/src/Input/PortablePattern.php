<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Input;

final class PortablePattern
{
    public static function fromSymfonyRegex(string $regex): string
    {
        $pattern = self::stripPcreDelimiters($regex);
        self::assertPortable($pattern);

        return $pattern;
    }

    private static function stripPcreDelimiters(string $regex): string
    {
        if ($regex === '') {
            throw new UnsupportedInputShapeException('Regex must not be empty.');
        }

        $delimiter = $regex[0];
        if (ctype_alnum($delimiter) || $delimiter === '\\') {
            return $regex;
        }

        $end = strrpos($regex, $delimiter);
        if ($end === false || $end === 0 || substr($regex, $end + 1) !== '') {
            throw new UnsupportedInputShapeException('Regex modifiers are not portable.');
        }

        return substr($regex, 1, $end - 1);
    }

    private static function assertPortable(string $pattern): void
    {
        if (!mb_check_encoding($pattern, 'UTF-8')
            || preg_match('/\(\?(?:[=!]|<[=!]|P?<|[a-zA-Z-]+:|\()/', $pattern) === 1
            || preg_match('/\\\\(?:[1-9]|k[<{]|g[<{])/', $pattern) === 1
            || preg_match('/\(\?>|[+*?}]\+/', $pattern) === 1) {
            throw new UnsupportedInputShapeException('Regex is outside the portable profile.');
        }

        $probe = '~' . str_replace('~', '\\~', $pattern) . '~u';
        if (@preg_match($probe, '') === false) {
            throw new UnsupportedInputShapeException('Regex is invalid.');
        }
    }

    private function __construct()
    {
    }
}
