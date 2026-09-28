<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationUiSchema;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class InvalidSemanticsOperation implements OperationHandler
{
    public int $executions = 0;

    public function definition(): OperationDefinition
    {
        $base = FixtureOperationDefinitions::definition(
            'fixture.invalid-semantics',
            'Invalid semantic definition',
        );

        return new OperationDefinition(...array_replace(
            get_object_vars($base),
            ['uiSchema' => new OperationUiSchema(JsonOwnership::object([
                'profile' => 'tc-rich-forms@1',
                'root' => [
                    'type' => 'field',
                    'pointer' => '/applicationId',
                    'dataSourceId' => 'fixture.undeclared-source',
                ],
            ]))],
        ));
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;
        throw new \LogicException('Semantically invalid operation executed.');
    }
}
