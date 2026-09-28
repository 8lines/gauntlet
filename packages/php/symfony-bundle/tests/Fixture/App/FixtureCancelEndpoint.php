<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunStatus;
use EightLines\Gauntlet\SymfonyBundle\Capability\CancelRunEndpoint;

final class FixtureCancelEndpoint implements CancelRunEndpoint
{
    public function cancel(string $runId): Run|Problem
    {
        return new Run(
            id: $runId,
            operationId: 'fixture.echo',
            operationRevision: FixtureOperationDefinitions::definition('fixture.echo', 'Echo')->revision(),
            sequence: 1,
            state: RunStatus::RUNNING,
            createdAt: '2030-01-01T00:00:00Z',
            updatedAt: '2030-01-01T00:00:00Z',
            startedAt: '2030-01-01T00:00:00Z',
        );
    }
}
