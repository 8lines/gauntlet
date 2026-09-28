<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Json;

use EightLines\Gauntlet\Core\Json\CanonicalJsonException;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use PHPUnit\Framework\TestCase;

final class JcsRevisionVectorsTest extends TestCase
{
    private const FIXTURE_SHA256 = '63f9ba7a02c03e062dada836757d8d885c3fd1304d13993fa2cda7aa4a823152';

    public function testCheckedInRevisionVectors(): void
    {
        $path = dirname(__DIR__, 6) . '/packages/protocol/fixtures/v1/jcs-revision-vectors.json';
        $bytes = file_get_contents($path);
        self::assertIsString($bytes);
        self::assertSame(self::FIXTURE_SHA256, hash('sha256', $bytes));
        $fixture = json_decode($bytes, true, 512, JSON_THROW_ON_ERROR);
        self::assertSame('RFC8785+SHA-256', $fixture['algorithm']);
        self::assertCount(16, $fixture['vectors']);
        $successes = 0;
        $rejections = 0;
        foreach ($fixture['vectors'] as $row) {
            if (isset($row['expectedError'])) {
                ++$rejections;
                $rejected = false;
                try {
                    JsonOwnership::fromJson($row['inputJson']);
                } catch (CanonicalJsonException) {
                    $rejected = true;
                }
                self::assertTrue($rejected, $row['name']);
            } else {
                ++$successes;
                $value = JsonOwnership::fromJson($row['inputJson']);
                self::assertSame(
                    $row['expectedCanonicalJson'],
                    Rfc8785CanonicalJson::encode($value->without($row['revisionField'])),
                    $row['name'],
                );
                self::assertSame(
                    $row['expectedRevision'],
                    Rfc8785CanonicalJson::revision($value, $row['revisionField']),
                    $row['name'],
                );
            }
        }
        self::assertSame(13, $successes);
        self::assertSame(3, $rejections);
    }
}
