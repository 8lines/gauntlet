<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunEvent;
use EightLines\Gauntlet\Core\Run\RunStatus;
use EightLines\Gauntlet\SymfonyBundle\Capability\RunEventsEndpoint;

final class FixtureEventsEndpoint implements RunEventsEndpoint
{
    public ?string $lastEventId = null;

    public int $invocations = 0;

    public int $yielded = 0;

    public bool $closed = false;

    /** @return iterable<RunEvent>|Problem */
    public function events(string $runId, ?string $lastEventId = null): iterable|Problem
    {
        ++$this->invocations;
        $this->lastEventId = $lastEventId;

        $revision = FixtureOperationDefinitions::definition('fixture.echo', 'Echo')->revision();

        return (function () use ($runId, $revision): iterable {
            try {
                foreach ([1, 2] as $sequence) {
                    ++$this->yielded;
                    $timestamp = '2030-01-01T00:00:0' . ($sequence - 1) . 'Z';
                    yield new RunEvent(
                        id: 'event-' . $sequence,
                        sequence: $sequence,
                        occurredAt: $timestamp,
                        run: new Run(
                            id: $runId,
                            operationId: 'fixture.echo',
                            operationRevision: $revision,
                            sequence: $sequence,
                            state: RunStatus::RUNNING,
                            createdAt: '2030-01-01T00:00:00Z',
                            updatedAt: $timestamp,
                            startedAt: '2030-01-01T00:00:00Z',
                        ),
                    );
                }
            } finally {
                $this->closed = true;
            }
        })();
    }
}
