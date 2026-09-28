<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class CancellableOperation implements OperationHandler
{
    public int $executions = 0;

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'fixture.cancellable',
            featureId: 'fixture',
            label: 'Cancellable',
            description: null,
            inputSchema: JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'additionalProperties' => false,
            ]),
            inputHandling: null,
            contextSchema: null,
            uiSchema: null,
            dataSources: [],
            presets: [],
            execution: new ExecutionPolicy(
                impact: OperationImpact::WRITE,
                confirmationRequired: false,
                dryRunSupported: false,
                idempotency: 'required',
                cancellationSupported: true,
                timeoutSeconds: 30,
                concurrency: 'forbid',
            ),
            output: new OperationOutput(JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'additionalProperties' => false,
            ])),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;

        return new OperationResult(JsonOwnership::object([]));
    }
}
