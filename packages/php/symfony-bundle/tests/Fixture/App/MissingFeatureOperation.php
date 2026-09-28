<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class MissingFeatureOperation implements OperationHandler
{
    public int $executions = 0;

    public function definition(): OperationDefinition
    {
        $base = FixtureOperationDefinitions::definition(
            'fixture.missing-feature',
            'Missing feature binding',
        );

        return new OperationDefinition(...array_replace(
            get_object_vars($base),
            ['featureId' => 'fixture-feature-does-not-exist'],
        ));
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;
        throw new \LogicException('Omitted operation executed.');
    }
}
