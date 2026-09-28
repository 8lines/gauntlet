<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class InvalidDefinitionOperation implements OperationHandler
{
    public function definition(): OperationDefinition
    {
        throw new \RuntimeException('private invalid definition detail 731904');
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        throw new \LogicException('Invalid operation must never execute.');
    }
}
