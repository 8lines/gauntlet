<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Json;

use EightLines\Gauntlet\Core\Json\JsonList;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use PHPUnit\Framework\TestCase;

final class ComposedCanonicalBoundaryTest extends TestCase
{
    public function testApprovedComposedBoundaryPassesAll71Cases(): void
    {
        $cases = self::successCases() + self::rejectionCases();
        if (count($cases) !== 71) {
            throw new \LogicException('The approved composed boundary must contain exactly 71 cases.');
        }

        foreach ($cases as $name => $assertion) {
            try {
                $assertion();
            } catch (\PHPUnit\Framework\AssertionFailedError $failure) {
                throw new \LogicException('Composed boundary case failed: ' . $name, 0, $failure);
            }
        }
    }

    /** @return array<string, \Closure():void> */
    private static function successCases(): array
    {
        $canonical = static fn (JsonValue $value, string $expected): \Closure =>
            static fn (): mixed => self::assertSame($expected, Rfc8785CanonicalJson::encode($value));

        $sharedObject = (object) ['value' => 'alias'];
        $sharedArray = ['value' => 'alias'];
        $depth511 = 'leaf';
        for ($depth = 0; $depth < 510; ++$depth) {
            $depth511 = [$depth511];
        }

        return [
            'empty object' => $canonical(JsonOwnership::object([]), '{}'),
            'empty list' => $canonical(JsonOwnership::list([]), '[]'),
            'null member' => $canonical(JsonOwnership::object(['v' => null]), '{"v":null}'),
            'true member' => $canonical(JsonOwnership::object(['v' => true]), '{"v":true}'),
            'false member' => $canonical(JsonOwnership::object(['v' => false]), '{"v":false}'),
            'zero' => $canonical(JsonOwnership::object(['v' => 0]), '{"v":0}'),
            'positive integer' => $canonical(JsonOwnership::object(['v' => 42]), '{"v":42}'),
            'negative integer' => $canonical(JsonOwnership::object(['v' => -42]), '{"v":-42}'),
            'maximum safe integer' => $canonical(
                JsonOwnership::object(['v' => 9_007_199_254_740_991]),
                '{"v":9007199254740991}',
            ),
            'minimum safe integer' => $canonical(
                JsonOwnership::object(['v' => -9_007_199_254_740_991]),
                '{"v":-9007199254740991}',
            ),
            'fraction' => $canonical(JsonOwnership::object(['v' => 4.5]), '{"v":4.5}'),
            'smallest subnormal' => $canonical(JsonOwnership::object(['v' => 5e-324]), '{"v":5e-324}'),
            'second subnormal sample' => $canonical(JsonOwnership::object(['v' => 1e-320]), '{"v":1e-320}'),
            'smallest normal' => $canonical(
                JsonOwnership::object(['v' => 2.2250738585072014e-308]),
                '{"v":2.2250738585072014e-308}',
            ),
            'positive exponent boundary' => $canonical(JsonOwnership::object(['v' => 1e21]), '{"v":1e+21}'),
            'negative exponent boundary' => $canonical(JsonOwnership::object(['v' => -1e21]), '{"v":-1e+21}'),
            'parsed negative zero' => static function (): void {
                self::assertSame('{"v":0}', Rfc8785CanonicalJson::encode(JsonOwnership::fromJson('{"v":-0}')));
            },
            'object key sort' => $canonical(JsonOwnership::object(['z' => 1, 'a' => 2]), '{"a":2,"z":1}'),
            'recursive key sort' => $canonical(
                JsonOwnership::object(['z' => ['d' => 4, 'c' => 3], 'a' => 1]),
                '{"a":1,"z":{"c":3,"d":4}}',
            ),
            'list order' => $canonical(JsonOwnership::list([3, 2, 1]), '[3,2,1]'),
            'hostile proto key' => $canonical(
                JsonOwnership::object(['__proto__' => ['polluted' => true]]),
                '{"__proto__":{"polluted":true}}',
            ),
            'numeric object key' => $canonical(JsonOwnership::object([0 => 'zero']), '{"0":"zero"}'),
            'numeric looking object keys' => static function (): void {
                $value = JsonObject::fromEntries([['10', 'ten'], ['2', 'two']]);
                self::assertSame('{"10":"ten","2":"two"}', Rfc8785CanonicalJson::encode($value));
            },
            'nested empty shapes' => $canonical(
                JsonOwnership::object(['object' => new \stdClass(), 'list' => []]),
                '{"list":[],"object":{}}',
            ),
            'unicode payload' => $canonical(JsonOwnership::object(['v' => 'Zażółć']), '{"v":"Zażółć"}'),
            'utf16 key ordering' => static function (): void {
                self::assertSame(
                    "{\"\u{10000}\":1,\"\u{E000}\":2}",
                    Rfc8785CanonicalJson::encode(JsonOwnership::object(["\u{E000}" => 2, "\u{10000}" => 1])),
                );
            },
            'control escaping' => $canonical(JsonOwnership::object(['v' => "line\nfeed"]), '{"v":"line\\nfeed"}'),
            'slash remains unescaped' => $canonical(JsonOwnership::object(['v' => 'a/b']), '{"v":"a/b"}'),
            'object alias is copied' => $canonical(
                JsonOwnership::object(['a' => $sharedObject, 'b' => $sharedObject]),
                '{"a":{"value":"alias"},"b":{"value":"alias"}}',
            ),
            'array alias is copied' => $canonical(
                JsonOwnership::object(['a' => $sharedArray, 'b' => $sharedArray]),
                '{"a":{"value":"alias"},"b":{"value":"alias"}}',
            ),
            'maximum supported depth' => static function () use ($depth511): void {
                self::assertNotSame('', Rfc8785CanonicalJson::encode(JsonOwnership::object(['v' => $depth511])));
            },
            'root revision projection' => static function (): void {
                $document = JsonOwnership::object(['revision' => 'old', 'value' => 1]);
                self::assertSame(
                    'sha256:' . hash('sha256', '{"value":1}'),
                    Rfc8785CanonicalJson::revision($document),
                );
            },
            'manifest revision projection' => static function (): void {
                $document = JsonOwnership::object(['manifestRevision' => 'old', 'value' => 1]);
                self::assertSame(
                    'sha256:' . hash('sha256', '{"value":1}'),
                    Rfc8785CanonicalJson::revision($document, 'manifestRevision'),
                );
            },
            'nested revision retained' => static function (): void {
                $document = JsonOwnership::object(['revision' => 'old', 'nested' => ['revision' => 'keep']]);
                self::assertSame(
                    'sha256:' . hash('sha256', '{"nested":{"revision":"keep"}}'),
                    Rfc8785CanonicalJson::revision($document),
                );
            },
            'serialize precision restored' => static function (): void {
                $previous = ini_get('serialize_precision');
                if ($previous === false || ini_set('serialize_precision', '3') === false) {
                    throw new \RuntimeException('serialize_precision is unavailable.');
                }
                try {
                    Rfc8785CanonicalJson::encode(JsonOwnership::object(['v' => 2.2250738585072014e-308]));
                    self::assertSame('3', ini_get('serialize_precision'));
                } finally {
                    ini_set('serialize_precision', (string) $previous);
                }
            },
        ];
    }

    /** @return array<string, \Closure():void> */
    private static function rejectionCases(): array
    {
        $reject = static fn (callable $candidate): \Closure => static function () use ($candidate): void {
            $rejected = false;
            try {
                $candidate();
            } catch (\Throwable) {
                $rejected = true;
            }
            self::assertTrue($rejected);
        };

        return [
            'resource' => $reject(static function (): void {
                $resource = fopen('php://memory', 'rb');
                try {
                    JsonOwnership::object(['v' => $resource]);
                } finally {
                    if (is_resource($resource)) {
                        fclose($resource);
                    }
                }
            }),
            'closure' => $reject(static fn () => JsonOwnership::object(['v' => static fn (): null => null])),
            'date object' => $reject(static fn () => JsonOwnership::object(['v' => new \DateTimeImmutable()])),
            'enum' => $reject(static fn () => JsonOwnership::object(['v' => BoundaryFixtureEnum::VALUE])),
            'custom object' => $reject(static fn () => JsonOwnership::object(['v' => new BoundaryFixtureObject()])),
            'json serializable' => $reject(
                static fn () => JsonOwnership::object(['v' => new BoundaryFixtureSerializable()]),
            ),
            'positive infinity' => $reject(static fn () => JsonOwnership::object(['v' => INF])),
            'negative infinity' => $reject(static fn () => JsonOwnership::object(['v' => -INF])),
            'nan' => $reject(static fn () => JsonOwnership::object(['v' => NAN])),
            'programmatic negative zero' => $reject(static fn () => JsonOwnership::object(['v' => -0.0])),
            'unsafe positive integer' => $reject(
                static fn () => JsonOwnership::object(['v' => 9_007_199_254_740_992]),
            ),
            'unsafe negative integer' => $reject(
                static fn () => JsonOwnership::object(['v' => -9_007_199_254_740_992]),
            ),
            'unsafe positive integral float' => $reject(
                static fn () => JsonOwnership::object(['v' => 9_007_199_254_740_992.0]),
            ),
            'unsafe negative integral float' => $reject(
                static fn () => JsonOwnership::object(['v' => -9_007_199_254_740_992.0]),
            ),
            'invalid utf8 key' => $reject(static fn () => JsonOwnership::object(["bad\xFF" => true])),
            'invalid utf8 value' => $reject(static fn () => JsonOwnership::object(['v' => "bad\xFF"])),
            'lone surrogate key' => $reject(static fn () => JsonOwnership::fromJson('{"\\ud800":true}')),
            'lone surrogate value' => $reject(static fn () => JsonOwnership::fromJson('{"v":"\\udc00"}')),
            'sparse array' => $reject(static fn () => JsonOwnership::own([1 => 'value'])),
            'mixed integer object key' => $reject(static fn () => JsonOwnership::own(['name' => 'value', 0 => 'zero'])),
            'object self cycle' => $reject(static function (): void {
                $value = new \stdClass();
                $value->self = $value;
                JsonOwnership::object(['v' => $value]);
            }),
            'two object cycle' => $reject(static function (): void {
                $left = new \stdClass();
                $right = new \stdClass();
                $left->right = $right;
                $right->left = $left;
                JsonOwnership::object(['v' => $left]);
            }),
            'array self cycle' => $reject(static function (): void {
                $value = [];
                $value['self'] = &$value;
                JsonOwnership::object(['v' => $value]);
            }),
            'two array cycle' => $reject(static function (): void {
                $left = [];
                $right = [];
                $left['right'] = &$right;
                $right['left'] = &$left;
                JsonOwnership::object(['v' => $left]);
            }),
            'depth 512' => $reject(static function (): void {
                $value = 'leaf';
                for ($depth = 0; $depth < 511; ++$depth) {
                    $value = [$value];
                }
                JsonOwnership::object(['v' => $value]);
            }),
            'null scalar root' => $reject(static fn () => Rfc8785CanonicalJson::encode(null)),
            'boolean scalar root' => $reject(static fn () => Rfc8785CanonicalJson::encode(true)),
            'string scalar root' => $reject(static fn () => Rfc8785CanonicalJson::encode('value')),
            'integer scalar root' => $reject(static fn () => Rfc8785CanonicalJson::encode(1)),
            'float scalar root' => $reject(static fn () => Rfc8785CanonicalJson::encode(1.5)),
            'custom JsonValue root' => $reject(
                static fn () => Rfc8785CanonicalJson::encode(new BoundaryFixtureJsonValue()),
            ),
            'forged custom child' => $reject(
                static fn () => Rfc8785CanonicalJson::encode(new JsonObject(['v' => new BoundaryFixtureObject()])),
            ),
            'forged infinity child' => $reject(
                static fn () => Rfc8785CanonicalJson::encode(new JsonObject(['v' => INF])),
            ),
            'forged invalid utf8 child' => $reject(
                static fn () => Rfc8785CanonicalJson::encode(new JsonObject(['v' => "bad\xFF"])),
            ),
            'forged duplicate object keys' => $reject(static fn () => Rfc8785CanonicalJson::encode(
                JsonObject::fromEntries([['duplicate', 1], ['duplicate', 2]]),
            )),
            'forged non-string object key' => $reject(static fn () => Rfc8785CanonicalJson::encode(
                new JsonObject([[1, 'value']], true),
            )),
        ];
    }
}

enum BoundaryFixtureEnum
{
    case VALUE;
}

final class BoundaryFixtureObject
{
}

final class BoundaryFixtureSerializable implements \JsonSerializable
{
    public function jsonSerialize(): mixed
    {
        return ['must' => 'not execute'];
    }
}

final class BoundaryFixtureJsonValue implements JsonValue
{
    public function jsonSerialize(): mixed
    {
        return ['must' => 'not execute'];
    }
}
