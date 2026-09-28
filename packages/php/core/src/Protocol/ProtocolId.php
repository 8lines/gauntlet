<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Protocol;

final class ProtocolId
{
    private const PATTERN = '/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/D';

    public static function assert(string $id): void
    {
        if (!self::isValid($id)) {
            throw new \InvalidArgumentException('Invalid protocol ID.');
        }
    }

    public static function isValid(string $id): bool
    {
        return preg_match(self::PATTERN, $id) === 1;
    }

    public static function assertRevision(string $revision): void
    {
        if (preg_match('/^sha256:[0-9a-f]{64}$/D', $revision) !== 1) {
            throw new \InvalidArgumentException('Invalid protocol revision.');
        }
    }

    public static function assertVersioned(string $id): void
    {
        if (preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*@[1-9][0-9]*$/D', $id) !== 1) {
            throw new \InvalidArgumentException('Invalid versioned protocol ID.');
        }
    }
}
