<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class FailingOperation implements OperationHandler
{
    public function definition(): OperationDefinition
    {
        return FixtureOperationDefinitions::definition('fixture.failing', 'Failing operation');
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        throw new \RuntimeException('fixture exception detail');
    }
}
