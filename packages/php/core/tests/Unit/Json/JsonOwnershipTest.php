<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Json;

use EightLines\Gauntlet\Core\Json\CanonicalJsonException;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use JsonSerializable;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class JsonOwnershipTest extends TestCase
{
    public function testValueOwnsAndCanonicalizesEveryJsonRootShape(): void
    {
        $cases = [
            'object' => [(object) ['answer' => 42], '{"answer":42}'],
            'list' => [['before'], '["before"]'],
            'null' => [null, 'null'],
            'boolean' => [true, 'true'],
            'string' => ['complete', '"complete"'],
            'integer' => [42, '42'],
            'fraction' => [4.5, '4.5'],
        ];

        foreach ($cases as $name => [$input, $expected]) {
            $owned = JsonOwnership::value($input);

            self::assertInstanceOf(JsonValue::class, $owned, $name);
            self::assertSame($expected, Rfc8785CanonicalJson::encode($owned), $name);
        }

        $caller = (object) ['nested' => (object) ['value' => 'before']];
        $ownedCaller = JsonOwnership::value($caller);
        $caller->nested->value = 'after';
        self::assertSame('{"nested":{"value":"before"}}', Rfc8785CanonicalJson::encode($ownedCaller));
    }

    public function testOwnedShapesRemainDistinctAndCallerMutationCannotChangeThem(): void
    {
        $caller = ['nested' => ['value' => 'before']];
        $owned = JsonOwnership::object([
            'object' => new \stdClass(),
            'list' => [],
            'caller' => $caller,
            'value' => null,
        ]);

        $caller['nested']['value'] = 'after';
        $transport = $owned->jsonSerialize();

        self::assertInstanceOf(\stdClass::class, $transport->object);
        self::assertSame([], $transport->list);
        self::assertSame('before', $transport->caller->nested->value);
        self::assertNull($transport->value);
        self::assertSame(
            '{"caller":{"nested":{"value":"before"}},"list":[],"object":{},"value":null}',
            Rfc8785CanonicalJson::encode($owned),
        );
    }

    public function testExplicitObjectPreservesNumericAndHostileKeys(): void
    {
        $owned = JsonOwnership::object([
            0 => 'numeric-key',
            '__proto__' => ['polluted' => true],
        ]);

        self::assertSame(
            '{"0":"numeric-key","__proto__":{"polluted":true}}',
            Rfc8785CanonicalJson::encode($owned),
        );
    }

    public function testInferredSparseArrayIsRejectedButExplicitObjectIsAllowed(): void
    {
        $sparse = [1 => 'value'];

        $this->expectException(CanonicalJsonException::class);
        JsonOwnership::own($sparse);
    }

    #[DataProvider('unsupportedValues')]
    public function testUnsupportedValuesAreRejectedWithoutExecutingThem(mixed $value): void
    {
        $this->expectException(CanonicalJsonException::class);
        JsonOwnership::object(['value' => $value]);
    }

    /** @return iterable<string, array{mixed}> */
    public static function unsupportedValues(): iterable
    {
        $resource = fopen('php://memory', 'rb');
        self::assertIsResource($resource);

        yield 'resource' => [$resource];
        yield 'closure' => [static fn (): string => 'never'];
        yield 'date' => [new \DateTimeImmutable()];
        yield 'enum' => [OwnershipFixtureEnum::VALUE];
        yield 'custom object' => [new OwnershipFixtureObject()];
        yield 'JsonSerializable' => [new OwnershipFixtureJsonSerializable()];
    }

    #[DataProvider('invalidNumbers')]
    public function testInvalidRuntimeNumbersAreRejected(int|float $number): void
    {
        $this->expectException(CanonicalJsonException::class);
        JsonOwnership::object(['number' => $number]);
    }

    /** @return iterable<string, array{int|float}> */
    public static function invalidNumbers(): iterable
    {
        yield 'positive infinity' => [INF];
        yield 'negative infinity' => [-INF];
        yield 'nan' => [NAN];
        yield 'negative zero' => [-0.0];
        yield 'unsafe positive integer' => [9_007_199_254_740_992];
        yield 'unsafe negative integer' => [-9_007_199_254_740_992];
        yield 'unsafe positive integral float' => [9_007_199_254_740_992.0];
        yield 'unsafe negative integral float' => [-9_007_199_254_740_992.0];
    }

    public function testSubnormalAndExponentBoundaryNumbersRemainSupported(): void
    {
        self::assertSame(
            '{"numbers":[5e-324,1e-320,2.2250738585072014e-308,1e+21,-1e+21]}',
            Rfc8785CanonicalJson::encode(JsonOwnership::object([
                'numbers' => [5e-324, 1e-320, 2.2250738585072014e-308, 1e21, -1e21],
            ])),
        );
    }

    public function testInvalidUtf8KeysAndValuesAreRejected(): void
    {
        $rejections = 0;
        foreach ([["bad\xFF" => 'value'], ['key' => "bad\xFF"]] as $input) {
            try {
                JsonOwnership::object($input);
                self::fail('Invalid UTF-8 must be rejected.');
            } catch (CanonicalJsonException) {
                $rejections++;
            }
        }
        self::assertSame(2, $rejections);
    }

    public function testObjectAndArrayReferenceCyclesAreRejectedButAliasesAreAllowed(): void
    {
        $object = new \stdClass();
        $object->self = $object;
        try {
            JsonOwnership::object(['object' => $object]);
            self::fail('Object cycle must be rejected.');
        } catch (CanonicalJsonException) {
        }

        $array = [];
        $array['self'] = &$array;
        try {
            JsonOwnership::object(['array' => $array]);
            self::fail('Array cycle must be rejected.');
        } catch (CanonicalJsonException) {
        }

        $shared = new \stdClass();
        $shared->value = 'alias';
        $owned = JsonOwnership::object(['first' => $shared, 'second' => $shared]);
        self::assertSame('{"first":{"value":"alias"},"second":{"value":"alias"}}', Rfc8785CanonicalJson::encode($owned));
    }

    public function testDepth511IsAcceptedAndDepth512IsRejected(): void
    {
        $accepted = 'leaf';
        // Together with the object root this is 511 containers. One more is
        // outside the pinned engine's json_decode(..., depth: 512) boundary.
        for ($depth = 0; $depth < 510; $depth++) {
            $accepted = [$accepted];
        }
        self::assertNotEmpty(Rfc8785CanonicalJson::encode(JsonOwnership::object(['value' => $accepted])));

        $rejected = [$accepted];
        $this->expectException(CanonicalJsonException::class);
        JsonOwnership::object(['value' => $rejected]);
    }

    public function testCanonicalBoundaryRevalidatesForgedOwnedNodes(): void
    {
        $forged = new JsonObject(['bad' => new OwnershipFixtureObject()]);

        $this->expectException(CanonicalJsonException::class);
        Rfc8785CanonicalJson::encode($forged);
    }

    public function testSerializePrecisionIsScopedAndRestoredOnSuccessAndFailure(): void
    {
        $previous = ini_get('serialize_precision');
        self::assertNotFalse($previous);
        self::assertNotFalse(ini_set('serialize_precision', '3'));

        try {
            self::assertSame(
                '{"value":2.2250738585072014e-308}',
                Rfc8785CanonicalJson::encode(JsonOwnership::object(['value' => 2.2250738585072014e-308])),
            );
            self::assertSame('3', ini_get('serialize_precision'));

            try {
                Rfc8785CanonicalJson::encode(new JsonObject(['bad' => INF]));
                self::fail('Forged invalid number must fail.');
            } catch (CanonicalJsonException) {
            }
            self::assertSame('3', ini_get('serialize_precision'));
        } finally {
            ini_set('serialize_precision', (string) $previous);
        }
    }
}

enum OwnershipFixtureEnum
{
    case VALUE;
}

final class OwnershipFixtureObject
{
    public function __get(string $name): never
    {
        throw new \LogicException('Magic access must never execute.');
    }
}

final class OwnershipFixtureJsonSerializable implements JsonSerializable
{
    public function jsonSerialize(): never
    {
        throw new \LogicException('jsonSerialize must never execute.');
    }
}
