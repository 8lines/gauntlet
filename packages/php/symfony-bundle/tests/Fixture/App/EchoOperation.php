<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Run\FollowUpAction;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class EchoOperation implements OperationHandler
{
    public int $executions = 0;

    public ?RunContext $retainedContext = null;

    public function definition(): OperationDefinition
    {
        return FixtureOperationDefinitions::definition('fixture.echo', 'Echo');
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        if (!$input instanceof EchoInput) {
            throw new \LogicException('DTO mapping was bypassed.');
        }
        ++$this->executions;
        $this->retainedContext = $context;

        return new OperationResult(
            output: JsonOwnership::object(['applicationId' => $input->applicationId]),
            summary: ['title' => 'Echo completed', 'tone' => 'success'],
            artifacts: [new Artifact(
                id: 'echo-result',
                kind: 'key-value',
                data: JsonOwnership::object([
                    'entries' => [[
                        'key' => 'applicationId',
                        'label' => 'Application',
                        'value' => $input->applicationId,
                    ]],
                ]),
            )],
            actions: [new FollowUpAction(
                kind: 'invoke-operation',
                label: 'Echo again',
                operationId: 'fixture.echo',
                input: JsonOwnership::object(['applicationId' => $input->applicationId]),
            )],
        );
    }
}
