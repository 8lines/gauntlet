<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Manifest;

use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\Core\Manifest\ManifestBuilder;
use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use EightLines\Gauntlet\Core\Schema\ProtocolSemantics;
use PHPUnit\Framework\TestCase;

final class ManifestBuilderTest extends TestCase
{
    public function testItSortsFeaturesAndComputesManifestRevision(): void
    {
        $manifest = (new ManifestBuilder(
            'app',
            'App',
            ['tc-schema-core@1'],
            environment: EnvironmentDescriptor::fromProtocolValue(['name' => 'app-dev', 'kind' => 'development']),
        ))->build([new FeatureDefinition('z', 'Z'), new FeatureDefinition('a', 'A')], [], []);
        $wire = $manifest->toProtocolArray();
        self::assertSame('a', $wire['features'][0]['id']);
        self::assertSame(
            ['name' => 'app-dev', 'kind' => 'development'],
            $wire['application']['environment'],
        );
        self::assertMatchesRegularExpression('/^sha256:[a-f0-9]{64}$/', $wire['manifestRevision']);
        self::assertTrue(ProtocolSemantics::manifestIsValid($manifest));

        $wire['application']['environment']['name'] = 'mutated-output';
        self::assertSame('app-dev', $manifest->toProtocolArray()['application']['environment']['name']);
    }

    public function testManifestSemanticsRejectsNonObjectApplicationWithoutTouchingHostileMembers(): void
    {
        $manifest = self::manifestFixture();
        $hostile = new class {
            public int $reads = 0;

            public function __get(string $name): never
            {
                ++$this->reads;

                throw new \RuntimeException('hostile application: ' . $name);
            }
        };
        $manifest->application = $hostile;

        self::assertFalse(ProtocolSemantics::manifestSemanticsAreValid($manifest));
        self::assertSame(0, $hostile->reads);
    }

    private static function manifestFixture(): \stdClass
    {
        $path = dirname(__DIR__, 6) . '/packages/protocol/fixtures/v1/manifest.valid.json';
        $bytes = file_get_contents($path);
        self::assertIsString($bytes);

        return json_decode($bytes, false, 512, JSON_THROW_ON_ERROR);
    }
}
