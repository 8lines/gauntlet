<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Json;

final class CanonicalJsonException extends \InvalidArgumentException
{
    public static function invalidValue(): self
    {
        return new self('Value is not canonical Gauntlet JSON.');
    }

    public static function tooDeep(): self
    {
        return new self('JSON exceeds the maximum container depth.');
    }
}
