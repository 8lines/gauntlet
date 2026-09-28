<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Definition;

use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\InputHandling;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Definition\OperationPlacement;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Manifest\ManifestBuilder;
use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use EightLines\Gauntlet\Core\Schema\PlacementRules;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class OperationPlacementTest extends TestCase
{
    public function testPlacementsAreEmittedAndHashed(): void
    {
        $plain = self::operation([]);
        $placed = self::operation([OperationPlacement::subject('order', ['/orderId' => 'orderId'])]);
        self::assertArrayNotHasKey('placements', $plain->toProtocolArray());
        self::assertSame(
            [['kind' => 'subject', 'subjectType' => 'order', 'bindings' => ['/orderId' => 'orderId']]],
            $placed->toProtocolArray()['placements'],
        );
        self::assertSame(['kind' => 'global'], OperationPlacement::global()->toProtocolArray());
        self::assertNotSame($plain->revision(), $placed->revision());
    }

    /** @return iterable<string, array{list<OperationPlacement>}> */
    public static function invalidPlacements(): iterable
    {
        yield 'missing property' => [[OperationPlacement::subject('order', ['/missing' => 'orderId'])]];
        yield 'secret field' => [[OperationPlacement::subject('order', ['/token' => 'token'])]];
        yield 'array field' => [[OperationPlacement::subject('order', ['/tags' => 'tags'])]];
        yield 'duplicate global' => [[OperationPlacement::global(), OperationPlacement::global()]];
        yield 'duplicate subject' => [[OperationPlacement::subject('order'), OperationPlacement::subject('order')]];
    }

    /** @param list<OperationPlacement> $placements */
    #[DataProvider('invalidPlacements')]
    public function testInvalidPlacementsAreRejected(array $placements): void
    {
        $this->expectException(\InvalidArgumentException::class);
        self::operation($placements);
    }

    public function testEscapedPointersResolveToTheDecodedProperty(): void
    {
        $schema = json_decode('{"type":"object","properties":{"a/b":{"type":"string"}}}');
        self::assertTrue(PlacementRules::areValid($schema, [], [(object) ['kind' => 'subject', 'subjectType' => 's', 'bindings' => (object) ['/a~1b' => 'k']]]));
        self::assertFalse(PlacementRules::areValid($schema, [], [(object) ['kind' => 'subject', 'subjectType' => 's', 'bindings' => (object) ['/a/b' => 'k']]]));
    }

    public function testInvalidPortableIdsAreRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        OperationPlacement::subject('bad id');
    }

    public function testCombinatorGuardedLeafIsRejected(): void
    {
        $schema = json_decode('{"type":"object","properties":{"message":{"type":"string","anyOf":[{"type":"string"}]}}}');
        self::assertFalse(PlacementRules::areValid($schema, [], [
            (object) ['kind' => 'subject', 'subjectType' => 's', 'bindings' => (object) ['/message' => 'message']],
        ]));
    }

    public function testManifestAdvertisesTheProfileOnceWhenPlacementsExist(): void
    {
        $environment = EnvironmentDescriptor::fromProtocolValue(['name' => 'fixture-test', 'kind' => 'test']);
        $features = [new FeatureDefinition('test', 'Test')];
        $placed = [self::operation([OperationPlacement::global()])];
        foreach ([['tc-schema-core@1'], ['tc-schema-core@1', PlacementRules::PROFILE]] as $profiles) {
            $manifest = (new ManifestBuilder('fixture', 'Fixture', $profiles, $environment))
                ->build($features, $placed, [])->toProtocolArray();
            self::assertSame(1, count(array_keys($manifest['profiles'], PlacementRules::PROFILE, true)));
            self::assertSame([['kind' => 'global']], $manifest['operations'][0]['placements']);
        }
        $plain = (new ManifestBuilder('fixture', 'Fixture', ['tc-schema-core@1'], $environment))
            ->build($features, [self::operation([])], [])->toProtocolArray();
        self::assertNotContains(PlacementRules::PROFILE, $plain['profiles']);
    }

    public function testManifestKeepsConfiguredProfileOrderWithoutPlacements(): void
    {
        $environment = EnvironmentDescriptor::fromProtocolValue(['name' => 'fixture-test', 'kind' => 'test']);
        $configured = ['tc-schema-core@1', 'tc-rich-forms@1'];
        $builder = new ManifestBuilder('fixture', 'Fixture', $configured, $environment);
        $features = [new FeatureDefinition('test', 'Test')];

        $plain = $builder->build($features, [self::operation([])], [])->toProtocolArray();
        self::assertSame($configured, $plain['profiles']);

        $placed = $builder->build($features, [self::operation([OperationPlacement::global()])], [])->toProtocolArray();
        self::assertSame([...$configured, PlacementRules::PROFILE], $placed['profiles']);

        $declared = ['tc-schema-core@1', PlacementRules::PROFILE, 'tc-rich-forms@1'];
        $explicit = (new ManifestBuilder('fixture', 'Fixture', $declared, $environment))
            ->build($features, [self::operation([OperationPlacement::global()])], [])->toProtocolArray();
        self::assertSame($declared, $explicit['profiles']);
    }

    /** @param list<OperationPlacement> $placements */
    private static function operation(array $placements): OperationDefinition
    {
        return new OperationDefinition(
            id: 'test.pay',
            featureId: 'test',
            label: 'Pay',
            description: null,
            inputSchema: JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'properties' => [
                    'orderId' => ['type' => 'string'],
                    'token' => ['type' => 'string'],
                    'tags' => ['type' => 'array', 'items' => ['type' => 'string']],
                ],
            ]),
            inputHandling: new InputHandling([
                ['kind' => 'secret', 'schemaPointer' => '/properties/token', 'retention' => 'none'],
            ]),
            contextSchema: null,
            uiSchema: null,
            dataSources: [],
            presets: [],
            execution: new ExecutionPolicy(OperationImpact::READ, false, false, 'optional', false),
            output: new OperationOutput(JsonOwnership::object(['$schema' => TcSchemaCore::DIALECT])),
            placements: $placements,
        );
    }
}
