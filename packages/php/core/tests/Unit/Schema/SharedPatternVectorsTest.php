<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Schema;

use EightLines\Gauntlet\Core\Schema\PortablePattern;
use PHPUnit\Framework\TestCase;

final class SharedPatternVectorsTest extends TestCase
{
    private const SHA256 = '1f84ff58db9996f86a34be8a38f25287cb6122fee6023cbef149ea40a4031a09';

    public function testEverySharedPortablePatternVector(): void
    {
        $path = dirname(__DIR__, 6) . '/packages/protocol/fixtures/v1/tc-schema-core-pattern-vectors.json';
        $bytes = file_get_contents($path);
        self::assertIsString($bytes);
        self::assertSame(self::SHA256, hash('sha256', $bytes));

        $fixture = json_decode($bytes, true, 512, JSON_THROW_ON_ERROR);
        self::assertSame('tc-schema-core@1', $fixture['profile']);
        self::assertSame('ecmascript-unicode-search', $fixture['semantics']);
        self::assertSame('unicode-scalar-sequences', $fixture['instanceDomain']);
        self::assertCount(113, $fixture['vectors']);

        foreach ($fixture['vectors'] as $row) {
            try {
                $pattern = json_decode($row['sourceJson'], true, 512, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                self::assertFalse($row['valid'], $row['name']);
                continue;
            }
            self::assertIsString($pattern);

            try {
                PortablePattern::assert($pattern);
                $valid = true;
            } catch (\InvalidArgumentException) {
                $valid = false;
            }
            self::assertSame($row['valid'], $valid, $row['name']);

            if (!$valid) {
                continue;
            }

            $delimiter = '~';
            $pcre = $delimiter . str_replace($delimiter, '\\' . $delimiter, $pattern) . $delimiter . 'uD';
            foreach ($row['matches'] ?? [] as $candidate) {
                self::assertSame(1, preg_match($pcre, $candidate), $row['name'] . ' must match');
            }
            foreach ($row['nonMatches'] ?? [] as $candidate) {
                self::assertSame(0, preg_match($pcre, $candidate), $row['name'] . ' must not match');
            }
        }
    }
}
