<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Gauntlet;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\DataSourceReference;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\InputHandling;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Definition\OperationPlacement;
use EightLines\Gauntlet\Core\Definition\OperationUiSchema;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Protocol\ProtocolRequirements;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;
use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyJsonSchemaFactory;

#[AsGauntletOperation]
final class FinalizeAgencyApplicationOperation implements OperationHandler
{
    public ?RunContext $retainedContext = null;

    public function __construct(
        private readonly SymfonyJsonSchemaFactory $schemas,
        private readonly CustomFinalizeController $controller,
    ) {
    }

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'agency-applications.finalize',
            featureId: 'agency-applications',
            label: 'Finalize agency application',
            description: 'Finalizes one synthetic application through an application-owned binding.',
            inputSchema: $this->schemas->forClass(FinalizeAgencyApplicationInput::class),
            inputHandling: new InputHandling([
                [
                    'kind' => 'secret',
                    'schemaPointer' => '/properties/confirmationCode',
                    'retention' => 'none',
                ],
            ]),
            contextSchema: null,
            uiSchema: new OperationUiSchema(JsonOwnership::object([
                'profile' => 'tc-rich-forms@1',
                'root' => [
                    'type' => 'group',
                    'label' => 'Application finalization',
                    'children' => [
                        [
                            'type' => 'field',
                            'pointer' => '/applicationId',
                            'widget' => 'autocomplete',
                            'dataSourceId' => 'pending-applications',
                            'label' => 'Application',
                        ],
                        [
                            'type' => 'field',
                            'pointer' => '/confirmationCode',
                            'widget' => 'secret',
                            'label' => 'Confirmation code',
                        ],
                    ],
                ],
            ])),
            dataSources: [new DataSourceReference(
                id: 'pending-applications',
                inputPointer: '/applicationId',
                dependencyPointers: ['/workflowState'],
                required: true,
            )],
            presets: [],
            execution: new ExecutionPolicy(
                impact: OperationImpact::DESTRUCTIVE,
                confirmationRequired: true,
                dryRunSupported: false,
                idempotency: 'required',
                cancellationSupported: false,
                timeoutSeconds: 30,
                concurrency: 'forbid',
            ),
            output: new OperationOutput(
                schema: JsonOwnership::object([
                    '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                    'type' => 'object',
                    'required' => ['finalized'],
                    'properties' => [
                        'finalized' => ['type' => 'boolean'],
                    ],
                    'additionalProperties' => false,
                ]),
                presentation: JsonOwnership::object([
                    'profile' => 'tc-rich-results@1',
                    'defaultView' => 'summary',
                ]),
            ),
            order: 10,
            tags: ['agency', 'finalize'],
            requirements: new ProtocolRequirements(
                profiles: ['tc-schema-core@1', 'tc-rich-forms@1', 'tc-rich-results@1'],
                capabilities: [],
            ),
            inputClass: FinalizeAgencyApplicationInput::class,
            placements: [OperationPlacement::subject('agency-application', ['/applicationId' => 'applicationId'])],
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        if (!$input instanceof FinalizeAgencyApplicationInput) {
            throw new \LogicException('Typed operation input mapping was bypassed.');
        }

        $this->retainedContext = $context;

        return ($this->controller)($input, $context);
    }
}
