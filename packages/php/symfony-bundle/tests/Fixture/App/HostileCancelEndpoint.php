<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\FollowUpAction;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunProgress;
use EightLines\Gauntlet\Core\Run\RunStatus;
use EightLines\Gauntlet\SymfonyBundle\Capability\CancelRunEndpoint;

final class HostileCancelEndpoint implements CancelRunEndpoint
{
    public function cancel(string $runId): Run|Problem
    {
        $revision = FixtureOperationDefinitions::definition('fixture.echo', 'Echo')->revision();
        $base = [
            'id' => $runId,
            'operationId' => 'fixture.echo',
            'operationRevision' => $revision,
            'sequence' => 1,
            'state' => RunStatus::RUNNING,
            'createdAt' => '2030-01-01T00:00:00Z',
            'updatedAt' => '2030-01-01T00:00:00Z',
            'startedAt' => '2030-01-01T00:00:00Z',
        ];

        return match ($runId) {
            'wrong-id' => new Run(...[...$base, 'id' => 'different-run']),
            'wrong-revision' => new Run(...[
                ...$base,
                'operationRevision' => 'sha256:' . str_repeat('0', 64),
            ]),
            'no-output' => new Run(...[
                ...$base,
                'state' => RunStatus::SUCCEEDED,
                'completedAt' => '2030-01-01T00:00:01Z',
                'updatedAt' => '2030-01-01T00:00:01Z',
            ]),
            'invalid-output' => new Run(...[
                ...$base,
                'state' => RunStatus::SUCCEEDED,
                'completedAt' => '2030-01-01T00:00:01Z',
                'updatedAt' => '2030-01-01T00:00:01Z',
                'output' => JsonOwnership::object(['private' => '731904']),
            ]),
            'invalid-action' => new Run(...[
                ...$base,
                'actions' => [FollowUpAction::invokeOperation(
                    'Unsafe target',
                    'fixture.missing-feature',
                    JsonOwnership::object(['applicationId' => '11111111-1111-4111-8111-111111111111']),
                )],
            ]),
            'invalid-progress' => new Run(...[
                ...$base,
                'progress' => self::forgedProgress(),
            ]),
            'fractional-progress' => new Run(...[
                ...$base,
                'progress' => new RunProgress(0.25, 1.5, 'Fractional', '2030-01-01T00:00:00Z'),
            ]),
            'scalar-output' => self::jsonValueRun($runId, JsonOwnership::value('done')),
            'list-output' => self::jsonValueRun($runId, JsonOwnership::value([1, 'two'])),
            'null-output' => self::jsonValueRun($runId, JsonOwnership::value(null)),
            'sensitive-problem' => new Run(...[
                ...$base,
                'state' => RunStatus::FAILED,
                'completedAt' => '2030-01-01T00:00:01Z',
                'updatedAt' => '2030-01-01T00:00:01Z',
                'problem' => new Problem(
                    'urn:gauntlet:problem:handler-failed',
                    'private title 731904',
                    500,
                    detail: 'private detail 731904',
                    instance: '/private/731904',
                ),
            ]),
            default => new Run(...$base),
        };
    }

    private static function jsonValueRun(
        string $runId,
        \EightLines\Gauntlet\Core\Json\JsonValue $output,
    ): Run {
        $definition = (new JsonValueOperation())->definition();

        return new Run(
            id: $runId,
            operationId: $definition->id,
            operationRevision: $definition->revision(),
            sequence: 2,
            state: RunStatus::SUCCEEDED,
            createdAt: '2030-01-01T00:00:00Z',
            updatedAt: '2030-01-01T00:00:01Z',
            startedAt: '2030-01-01T00:00:00Z',
            completedAt: '2030-01-01T00:00:01Z',
            output: $output,
        );
    }

    private static function forgedProgress(): RunProgress
    {
        $reflection = new \ReflectionClass(RunProgress::class);
        /** @var RunProgress $progress */
        $progress = $reflection->newInstanceWithoutConstructor();
        foreach ([
            'current' => 2,
            'total' => 1,
            'message' => 'Impossible',
            'updatedAt' => '2030-01-01T00:00:00Z',
            'phase' => null,
            'extensions' => null,
        ] as $property => $value) {
            $reflection->getProperty($property)->setValue($progress, $value);
        }

        return $progress;
    }
}
