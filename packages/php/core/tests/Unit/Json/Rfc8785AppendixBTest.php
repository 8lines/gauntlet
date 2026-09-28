<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Json;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Tracing\Sdk\Canonicalize\JsonCanonicalizer;

/** RFC 8785 Appendix B, Table 1, at the pinned vendor-engine boundary. */
final class Rfc8785AppendixBTest extends TestCase
{
    #[DataProvider('appendixBNumbers')]
    public function testPinnedEngineUsesEcmaScriptNumberSerialization(
        string $ieee754,
        ?string $expected,
    ): void {
        $bytes = hex2bin($ieee754);
        self::assertIsString($bytes);
        $number = unpack('Evalue', $bytes);
        self::assertIsArray($number);
        $value = $number['value'];

        if ($expected === null) {
            $this->expectException(\JsonException::class);
            json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);

            return;
        }

        $previous = ini_get('serialize_precision');
        self::assertNotFalse($previous);
        self::assertNotFalse(ini_set('serialize_precision', '-1'));
        try {
            $raw = json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
        } finally {
            ini_set('serialize_precision', (string) $previous);
        }

        self::assertSame($expected, (new JsonCanonicalizer())->canonicalize($raw));
    }

    /** @return iterable<string, array{string, ?string}> */
    public static function appendixBNumbers(): iterable
    {
        yield 'zero' => ['0000000000000000', '0'];
        yield 'minus zero' => ['8000000000000000', '0'];
        yield 'minimum positive' => ['0000000000000001', '5e-324'];
        yield 'minimum negative' => ['8000000000000001', '-5e-324'];
        yield 'maximum positive' => ['7fefffffffffffff', '1.7976931348623157e+308'];
        yield 'maximum negative' => ['ffefffffffffffff', '-1.7976931348623157e+308'];
        yield 'maximum positive integer sample' => ['4340000000000000', '9007199254740992'];
        yield 'maximum negative integer sample' => ['c340000000000000', '-9007199254740992'];
        yield 'two to the sixty eight' => ['4430000000000000', '295147905179352830000'];
        yield 'nan' => ['7fffffffffffffff', null];
        yield 'infinity' => ['7ff0000000000000', null];
        yield 'below one e twenty three' => ['44b52d02c7e14af5', '9.999999999999997e+22'];
        yield 'one e twenty three' => ['44b52d02c7e14af6', '1e+23'];
        yield 'above one e twenty three' => ['44b52d02c7e14af7', '1.0000000000000001e+23'];
        yield 'below one e twenty one a' => ['444b1ae4d6e2ef4e', '999999999999999700000'];
        yield 'below one e twenty one b' => ['444b1ae4d6e2ef4f', '999999999999999900000'];
        yield 'one e twenty one' => ['444b1ae4d6e2ef50', '1e+21'];
        yield 'below one e minus six' => ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'];
        yield 'one e minus six' => ['3eb0c6f7a0b5ed8d', '0.000001'];
        yield 'rounding sample a' => ['41b3de4355555553', '333333333.3333332'];
        yield 'rounding sample b' => ['41b3de4355555554', '333333333.33333325'];
        yield 'rounding sample c' => ['41b3de4355555555', '333333333.3333333'];
        yield 'rounding sample d' => ['41b3de4355555556', '333333333.3333334'];
        yield 'rounding sample e' => ['41b3de4355555557', '333333333.33333343'];
        yield 'negative small sample' => ['becbf647612f3696', '-0.0000033333333333333333'];
        yield 'round to even' => ['43143ff3c1cb0959', '1424953923781206.2'];
    }
}
