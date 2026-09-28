<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Protocol;

use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use EightLines\Gauntlet\Core\Protocol\EnvironmentKind;
use PHPUnit\Framework\TestCase;

final class EnvironmentDescriptorTest extends TestCase
{
    public function testItOwnsEverySupportedEnvironmentKindAndReturnsFreshProtocolValues(): void
    {
        $expectedKinds = ['development', 'test', 'qa', 'staging', 'uat', 'preview', 'sandbox'];
        self::assertSame($expectedKinds, array_map(
            static fn (EnvironmentKind $kind): string => $kind->value,
            EnvironmentKind::cases(),
        ));

        foreach ($expectedKinds as $kind) {
            $source = ['name' => 'client-' . $kind, 'kind' => $kind];
            $environment = EnvironmentDescriptor::fromProtocolValue($source);
            $source['name'] = 'changed-after-construction';

            $first = $environment->toProtocolArray();
            $first['name'] = 'changed-output';

            self::assertSame(
                ['name' => 'client-' . $kind, 'kind' => $kind],
                $environment->toProtocolArray(),
                $kind,
            );
        }
    }

    public function testItRejectsProductionTokensButAllowsOrdinaryWordsContainingTheirLetters(): void
    {
        foreach ([
            'prod',
            'PRODUCTION',
            'live',
            'pp-prod',
            'prod-eu',
            'client.production',
            'live_eu',
            'sandbox:prod:blue',
            'non-production',
        ] as $name) {
            self::assertInvalid(['name' => $name, 'kind' => 'staging'], $name);
        }

        self::assertSame(
            'product-demo',
            EnvironmentDescriptor::fromProtocolValue(['name' => 'product-demo', 'kind' => 'preview'])->name,
        );
        self::assertSame(
            'lively',
            EnvironmentDescriptor::fromProtocolValue(['name' => 'lively', 'kind' => 'test'])->name,
        );
    }

    public function testItRejectsEveryNonClosedOrInvalidProtocolValueWithOneBoundedError(): void
    {
        foreach ([
            null,
            'development',
            new \stdClass(),
            [],
            ['dev', 'test'],
            ['name' => 'dev'],
            ['kind' => 'test'],
            ['name' => 'dev', 'kind' => 'production'],
            ['name' => 'dev', 'kind' => 'test', 'extra' => true],
            ['name' => '', 'kind' => 'test'],
            ['name' => 123, 'kind' => 'test'],
            ['name' => 'dev', 'kind' => 123],
        ] as $index => $value) {
            self::assertInvalid($value, 'invalid-' . $index);
        }
    }

    public function testItRejectsHostileObjectsWithoutReadingTheirMembers(): void
    {
        $hostile = new class {
            public int $reads = 0;

            public function __get(string $name): never
            {
                ++$this->reads;

                throw new \RuntimeException('hostile value: ' . $name);
            }
        };

        self::assertInvalid($hostile, 'hostile object');
        self::assertSame(0, $hostile->reads);
    }

    private static function assertInvalid(mixed $value, string $label): void
    {
        try {
            EnvironmentDescriptor::fromProtocolValue($value);
            self::fail($label . ' must be rejected.');
        } catch (\InvalidArgumentException $exception) {
            self::assertSame('Invalid non-production environment descriptor', $exception->getMessage(), $label);
        }
    }
}
