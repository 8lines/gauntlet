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
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class JsonValueOperation implements OperationHandler
{
    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'fixture.json-value',
            featureId: 'fixture',
            label: 'JSON value output',
            description: null,
            inputSchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['mode'],
                'properties' => [
                    'mode' => [
                        'enum' => ['object', 'list', 'null', 'boolean', 'string', 'number', 'absent'],
                    ],
                ],
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
                idempotency: 'none',
                cancellationSupported: false,
            ),
            output: new OperationOutput(JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
            ])),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        $mode = $input->mode ?? null;
        if (!is_string($mode)) {
            throw new \LogicException('JSON value mode was not mapped.');
        }
        if ($mode === 'absent') {
            return new OperationResult();
        }

        return new OperationResult(JsonOwnership::value(match ($mode) {
            'object' => (object) ['answer' => 42],
            'list' => [1, 'two'],
            'null' => null,
            'boolean' => true,
            'string' => 'done',
            'number' => 2.5,
            default => throw new \LogicException('Unknown JSON value mode.'),
        }));
    }
}
