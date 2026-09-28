<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Definition\DataSourceReference;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Definition\OperationPreset;
use EightLines\Gauntlet\Core\Definition\OperationUiSchema;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Protocol\ProtocolRequirements;

final class FixtureOperationDefinitions
{
    public static function definition(
        string $id,
        string $label,
        ?ProtocolRequirements $requirements = null,
    ): OperationDefinition {
        return new OperationDefinition(
            id: $id,
            featureId: 'fixture',
            label: $label,
            description: 'A typed fixture operation.',
            inputSchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['applicationId'],
                'properties' => [
                    'applicationId' => ['type' => 'string', 'format' => 'uuid'],
                ],
                'additionalProperties' => false,
            ]),
            inputHandling: null,
            contextSchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['requestId'],
                'properties' => [
                    'requestId' => ['type' => 'string'],
                    'target' => ['type' => 'object'],
                ],
                'additionalProperties' => false,
            ]),
            uiSchema: new OperationUiSchema(JsonOwnership::object([
                'profile' => 'tc-rich-forms@1',
                'root' => [
                    'type' => 'group',
                    'children' => [[
                        'type' => 'field',
                        'pointer' => '/applicationId',
                        'dataSourceId' => 'fixture.users',
                    ]],
                ],
            ])),
            dataSources: [new DataSourceReference(
                id: 'fixture.users',
                inputPointer: '/applicationId',
                dependencyPointers: ['/agencyId'],
            )],
            presets: [new OperationPreset(
                id: 'fixture.default',
                label: 'Default',
                input: JsonOwnership::object([]),
            )],
            execution: new ExecutionPolicy(
                impact: OperationImpact::READ,
                confirmationRequired: false,
                dryRunSupported: false,
                idempotency: 'optional',
                cancellationSupported: false,
            ),
            output: new OperationOutput(JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['applicationId'],
                'properties' => [
                    'applicationId' => ['type' => 'string', 'format' => 'uuid'],
                ],
                'additionalProperties' => false,
            ])),
            order: 10,
            tags: ['fixture'],
            requirements: $requirements ?? new ProtocolRequirements(
                profiles: ['tc-schema-core@1', 'tc-rich-forms@1'],
            ),
            inputClass: EchoInput::class,
        );
    }

    private function __construct()
    {
    }
}
