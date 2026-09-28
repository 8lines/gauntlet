<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Definition;

use EightLines\Gauntlet\Core\Definition\DataSourceReference;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\InputHandling;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Definition\OperationPreset;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\TestCase;

final class OperationDefinitionTest extends TestCase
{
    public function testItEmitsExactlyProtocolFieldsAndHashesTheRootRevisionProjection(): void
    {
        $operation = new OperationDefinition(
            id: 'test.echo',
            featureId: 'test',
            label: 'Echo',
            description: 'Safe description',
            inputSchema: self::objectSchema(),
            inputHandling: null,
            contextSchema: self::objectSchema(),
            uiSchema: null,
            dataSources: [new DataSourceReference('users', '/userId')],
            presets: [],
            execution: new ExecutionPolicy(OperationImpact::READ, false, false, 'optional', false),
            output: new OperationOutput(self::anySchema()),
            inputClass: 'Private\\Application\\EchoInput',
        );

        $wire = $operation->toProtocolArray();
        self::assertSame([
            'id',
            'featureId',
            'label',
            'inputSchema',
            'dataSources',
            'presets',
            'execution',
            'output',
            'order',
            'tags',
            'description',
            'contextSchema',
            'revision',
        ], array_keys($wire));
        self::assertSame([], $wire['dataSources'][0]['dependencyPointers']);
        self::assertArrayNotHasKey('inputClass', $wire);
        self::assertStringNotContainsString('Private\\Application', json_encode($wire, JSON_THROW_ON_ERROR));
        self::assertSame($operation->revision(), $wire['revision']);
    }

    public function testSchemasMustUseThePortableDraft202012Profile(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new OperationOutput(JsonOwnership::object(['type' => 'object']));
    }

    public function testInputRulesAreAClosedUnionAndSecretPresetsAreRejected(): void
    {
        $handling = new InputHandling([
            ['kind' => 'secret', 'schemaPointer' => '/properties/token', 'retention' => 'none'],
        ]);

        $this->expectException(\InvalidArgumentException::class);
        new OperationDefinition(
            'test.echo',
            'test',
            'Echo',
            null,
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'properties' => ['token' => ['type' => 'string']],
            ]),
            $handling,
            null,
            null,
            [],
            [new OperationPreset('unsafe', 'Unsafe', JsonOwnership::object(['token' => 'must-not-leak']))],
            new ExecutionPolicy(OperationImpact::READ, false, false, 'optional', false),
            new OperationOutput(self::anySchema()),
        );
    }

    private static function objectSchema(): \EightLines\Gauntlet\Core\Json\JsonObject
    {
        return JsonOwnership::object([
            '$schema' => TcSchemaCore::DIALECT,
            'type' => 'object',
        ]);
    }

    private static function anySchema(): \EightLines\Gauntlet\Core\Json\JsonObject
    {
        return JsonOwnership::object(['$schema' => TcSchemaCore::DIALECT]);
    }
}
