<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Gauntlet;

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
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;
use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyJsonSchemaFactory;

#[AsGauntletOperation]
final readonly class FailingAgencyApplicationOperation implements OperationHandler
{
    public function __construct(private SymfonyJsonSchemaFactory $schemas)
    {
    }

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'agency-applications.fail',
            featureId: 'agency-applications',
            label: 'Fail agency application',
            description: 'A deliberate failure used to prove safe error normalization.',
            inputSchema: $this->schemas->forClass(FinalizeAgencyApplicationInput::class),
            inputHandling: new InputHandling([[
                'kind' => 'secret',
                'schemaPointer' => '/properties/confirmationCode',
                'retention' => 'none',
            ]]),
            contextSchema: null,
            uiSchema: null,
            dataSources: [],
            presets: [],
            execution: new ExecutionPolicy(
                impact: OperationImpact::WRITE,
                confirmationRequired: true,
                dryRunSupported: false,
                idempotency: 'required',
                cancellationSupported: false,
            ),
            output: new OperationOutput(JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'additionalProperties' => false,
            ])),
            order: 20,
            tags: ['fixture', 'failure'],
            requirements: new ProtocolRequirements(profiles: ['tc-schema-core@1']),
            inputClass: FinalizeAgencyApplicationInput::class,
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        throw new \RuntimeException('private failure detail with confirmation code ' . $input->confirmationCode);
    }
}
