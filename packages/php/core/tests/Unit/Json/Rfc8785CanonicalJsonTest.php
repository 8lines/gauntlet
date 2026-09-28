<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Json;

use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use PHPUnit\Framework\TestCase;

final class Rfc8785CanonicalJsonTest extends TestCase
{
    public function testItSortsObjectKeysRecursivelyWithoutReorderingLists(): void
    {
        self::assertSame(
            '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2},3]}',
            Rfc8785CanonicalJson::encode(JsonOwnership::object([
                'z' => [['b' => 2, 'a' => 1], 3],
                'a' => ['d' => 4, 'c' => 3],
            ])),
        );
    }
}
