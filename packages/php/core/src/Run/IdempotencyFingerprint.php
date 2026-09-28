<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

final class IdempotencyFingerprint
{
    public static function from(string $operationId, string $key, string $secret): string
    {
        if (strlen($secret) < 32) {
            throw new \InvalidArgumentException('Idempotency fingerprint secret must contain at least 32 bytes.');
        }

        return hash_hmac('sha256', "tc-idempotency:v1\0" . $operationId . "\0" . $key, $secret);
    }
}
