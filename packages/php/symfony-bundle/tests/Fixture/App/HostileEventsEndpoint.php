<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunEvent;
use EightLines\Gauntlet\Core\Run\RunStatus;
use EightLines\Gauntlet\SymfonyBundle\Capability\RunEventsEndpoint;

final class HostileEventsEndpoint implements RunEventsEndpoint
{
    public int $yielded = 0;

    public bool $closed = false;

    /** @return iterable<RunEvent>|Problem */
    public function events(string $runId, ?string $lastEventId = null): iterable|Problem
    {
        return (function () use ($runId): iterable {
            if ($runId === 'iterator-throw') {
                throw new \RuntimeException('private iterator failure 731904');
            }
            if ($runId === 'wrong-shape') {
                yield new \stdClass();

                return;
            }

            $revision = FixtureOperationDefinitions::definition('fixture.echo', 'Echo')->revision();
            if ($runId === 'regressing-events') {
                try {
                    foreach ([
                        [2, '2030-01-01T00:00:01Z'],
                        [1, '2030-01-01T00:00:00Z'],
                    ] as [$sequence, $timestamp]) {
                        ++$this->yielded;
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

                return;
            }
            if ($runId === 'replayed-failed-events') {
                $failed = new Run(
                    id: $runId,
                    operationId: 'fixture.echo',
                    operationRevision: $revision,
                    sequence: 2,
                    state: RunStatus::FAILED,
                    createdAt: '2030-01-01T00:00:00Z',
                    updatedAt: '2030-01-01T00:00:01Z',
                    startedAt: '2030-01-01T00:00:00Z',
                    completedAt: '2030-01-01T00:00:01Z',
                    problem: new Problem(
                        'urn:gauntlet:problem:handler-failed',
                        'private title 731904',
                        500,
                        detail: 'private detail 731904',
                    ),
                );
                foreach (['event-replay-a', 'event-replay-b'] as $eventId) {
                    ++$this->yielded;
                    yield new RunEvent(
                        id: $eventId,
                        sequence: 2,
                        occurredAt: '2030-01-01T00:00:01Z',
                        run: $failed,
                    );
                }

                return;
            }
            if ($runId === 'no-output') {
                $succeeded = new Run(
                    id: $runId,
                    operationId: 'fixture.echo',
                    operationRevision: $revision,
                    sequence: 2,
                    state: RunStatus::SUCCEEDED,
                    createdAt: '2030-01-01T00:00:00Z',
                    updatedAt: '2030-01-01T00:00:01Z',
                    startedAt: '2030-01-01T00:00:00Z',
                    completedAt: '2030-01-01T00:00:01Z',
                );
                yield new RunEvent(
                    id: 'event-no-output',
                    sequence: $succeeded->sequence,
                    occurredAt: $succeeded->updatedAt,
                    run: $succeeded,
                );

                return;
            }
            if ($runId === 'mismatched-event') {
                yield new RunEvent(
                    id: 'event-hostile',
                    sequence: 2,
                    occurredAt: '2030-01-01T00:00:01Z',
                    run: new Run(
                        id: $runId,
                        operationId: 'fixture.echo',
                        operationRevision: $revision,
                        sequence: 1,
                        state: RunStatus::RUNNING,
                        createdAt: '2030-01-01T00:00:00Z',
                        updatedAt: '2030-01-01T00:00:00Z',
                        startedAt: '2030-01-01T00:00:00Z',
                    ),
                );

                return;
            }

            if ($runId === 'late-throw') {
                yield new RunEvent(
                    id: 'event-first',
                    sequence: 1,
                    occurredAt: '2030-01-01T00:00:00Z',
                    run: new Run(
                        id: $runId,
                        operationId: 'fixture.echo',
                        operationRevision: $revision,
                        sequence: 1,
                        state: RunStatus::RUNNING,
                        createdAt: '2030-01-01T00:00:00Z',
                        updatedAt: '2030-01-01T00:00:00Z',
                        startedAt: '2030-01-01T00:00:00Z',
                    ),
                );
                throw new \RuntimeException('private late iterator failure 731904');
            }

            yield new RunEvent(
                id: 'event-hostile',
                sequence: 1,
                occurredAt: '2030-01-01T00:00:00Z',
                run: new Run(
                    id: $runId,
                    operationId: 'fixture.echo',
                    operationRevision: $revision,
                    sequence: 1,
                    state: RunStatus::RUNNING,
                    createdAt: '2030-01-01T00:00:00Z',
                    updatedAt: '2030-01-01T00:00:00Z',
                    output: new JsonObject(['notFinite' => NAN]),
                ),
            );
        })();
    }
}
