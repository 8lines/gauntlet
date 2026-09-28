<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\DataSourceReference;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class MissingDataSourceOperation implements OperationHandler
{
    public int $executions = 0;

    public function definition(): OperationDefinition
    {
        $base = FixtureOperationDefinitions::definition(
            'fixture.missing-data-source',
            'Missing data source binding',
        );

        return new OperationDefinition(...array_replace(
            get_object_vars($base),
            ['dataSources' => [new DataSourceReference(
                id: 'fixture-source-does-not-exist',
                inputPointer: '/applicationId',
            )]],
        ));
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;
        throw new \LogicException('Omitted operation executed.');
    }
}
