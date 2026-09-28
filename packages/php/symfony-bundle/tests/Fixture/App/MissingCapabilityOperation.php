<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Protocol\ProtocolRequirements;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;

#[AsGauntletOperation]
final class MissingCapabilityOperation implements OperationHandler
{
    public int $executions = 0;

    public function definition(): OperationDefinition
    {
        return FixtureOperationDefinitions::definition(
            'fixture.missing-capability',
            'Missing capability',
            new ProtocolRequirements(capabilities: ['tc-uploads@1']),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;
        throw new \LogicException('Unavailable operation executed.');
    }
}
