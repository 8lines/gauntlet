<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\InputHandling;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Protocol\ProtocolRequirements;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class FileOperation implements OperationHandler
{
    public int $executions = 0;

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'fixture.file',
            featureId: 'fixture',
            label: 'Consume fixture upload',
            description: null,
            inputSchema: JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['attachment'],
                'properties' => [
                    'attachment' => ['$ref' => '#/$defs/file'],
                ],
                '$defs' => [
                    'file' => [
                        'type' => 'object',
                        'required' => ['kind', 'uploadId', 'name', 'mediaType', 'sizeBytes', 'expiresAt'],
                        'properties' => [
                            'kind' => ['const' => 'file'],
                            'uploadId' => ['type' => 'string'],
                            'name' => ['type' => 'string'],
                            'mediaType' => ['type' => 'string'],
                            'sizeBytes' => ['type' => 'integer'],
                            'expiresAt' => ['type' => 'string'],
                        ],
                        'additionalProperties' => false,
                    ],
                ],
                'additionalProperties' => false,
            ]),
            inputHandling: new InputHandling([[
                'kind' => 'file',
                'schemaPointer' => '/$defs/file',
                'multiple' => false,
                'mediaTypes' => ['text/plain'],
                'maxBytes' => 100,
            ]]),
            contextSchema: null,
            uiSchema: null,
            dataSources: [],
            presets: [],
            execution: new ExecutionPolicy(
                impact: OperationImpact::WRITE,
                confirmationRequired: true,
                dryRunSupported: false,
                idempotency: 'optional',
                cancellationSupported: false,
            ),
            output: new OperationOutput(JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'additionalProperties' => false,
            ])),
            requirements: new ProtocolRequirements(profiles: ['tc-schema-core@1']),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;

        return new OperationResult(JsonOwnership::object([]));
    }
}
