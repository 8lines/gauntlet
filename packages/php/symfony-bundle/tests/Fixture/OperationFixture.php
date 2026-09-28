<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class OperationFixture implements OperationHandler
{
    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'fixture.echo',
            featureId: 'fixture',
            label: 'Echo',
            description: null,
            inputSchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'additionalProperties' => false,
            ]),
            inputHandling: null,
            contextSchema: null,
            uiSchema: null,
            dataSources: [],
            presets: [],
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
            ])),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        return new OperationResult(JsonOwnership::object([]));
    }
}
