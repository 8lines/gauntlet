<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Run;

use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Run\ConfirmationAcknowledgement;
use EightLines\Gauntlet\Core\Run\CreateRunRequest;
use EightLines\Gauntlet\Core\Run\FollowUpAction;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunEvent;
use EightLines\Gauntlet\Core\Run\RunProgress;
use EightLines\Gauntlet\Core\Run\RuntimeGuard;
use EightLines\Gauntlet\Core\Run\RunStatus;
use EightLines\Gauntlet\Core\Schema\ProtocolSemantics;
use PHPUnit\Framework\TestCase;

final class RunProtocolTest extends TestCase
{
    public function testConfirmationAcknowledgementSerializesOwnedValuesWithoutEchoingInvalidInput(): void
    {
        $revision = 'sha256:' . str_repeat('a', 64);
        $source = ['urn:gauntlet:test:metadata' => ['scope' => 'fixture']];
        $extensions = ProtocolExtensions::fromArray($source);
        $source['urn:gauntlet:test:metadata']['scope'] = 'changed-after-construction';
        $acknowledgement = new ConfirmationAcknowledgement(
            operationId: 'application-access-review',
            operationRevision: $revision,
            impact: OperationImpact::WRITE,
            extensions: $extensions,
        );

        $first = $acknowledgement->toProtocolArray();
        self::assertSame(
            ['operationId', 'operationRevision', 'impact', 'extensions'],
            array_keys($first),
        );
        self::assertSame('application-access-review', $first['operationId']);
        self::assertSame($revision, $first['operationRevision']);
        self::assertSame('write', $first['impact']);
        self::assertSame(
            'fixture',
            $first['extensions']->{'urn:gauntlet:test:metadata'}->scope,
        );

        $first['operationId'] = 'mutated-output';
        $first['extensions']->{'urn:gauntlet:test:metadata'}->scope = 'mutated-output';
        $second = $acknowledgement->toProtocolArray();
        self::assertSame('application-access-review', $second['operationId']);
        self::assertSame('fixture', $second['extensions']->{'urn:gauntlet:test:metadata'}->scope);

        foreach ([
            ['invalid operation id!', $revision],
            ['application-access-review', 'sha256:not-a-revision'],
        ] as [$operationId, $operationRevision]) {
            try {
                new ConfirmationAcknowledgement($operationId, $operationRevision, OperationImpact::WRITE);
                self::fail('Invalid acknowledgement identity must be rejected.');
            } catch (\InvalidArgumentException $exception) {
                self::assertStringNotContainsString($operationId, $exception->getMessage());
                self::assertStringNotContainsString($operationRevision, $exception->getMessage());
            }
        }
    }

    public function testCreateRunRequestKeepsExtensionsPositionButSerializesConfirmationFirst(): void
    {
        $revision = 'sha256:' . str_repeat('b', 64);
        $extensions = ProtocolExtensions::fromArray(['urn:gauntlet:test:request' => true]);
        $confirmation = new ConfirmationAcknowledgement('test.echo', $revision, OperationImpact::READ);
        $request = new CreateRunRequest(
            $revision,
            JsonOwnership::object([]),
            null,
            false,
            null,
            $extensions,
            $confirmation,
        );

        $wire = $request->toProtocolArray();
        self::assertSame(
            ['operationRevision', 'input', 'confirmation', 'extensions'],
            array_keys($wire),
        );
        self::assertSame(
            [
                'operationId' => 'test.echo',
                'operationRevision' => $revision,
                'impact' => 'read',
            ],
            $wire['confirmation'],
        );
        self::assertTrue($wire['extensions']->{'urn:gauntlet:test:request'});
    }

    public function testDestructiveExecutionPolicyRequiresConfirmationAndRequiredIdempotency(): void
    {
        foreach ([
            'missing confirmation' => [false, 'required'],
            'no idempotency' => [true, 'none'],
            'optional idempotency' => [true, 'optional'],
            'both missing' => [false, 'optional'],
        ] as $name => [$confirmationRequired, $idempotency]) {
            try {
                new ExecutionPolicy(
                    OperationImpact::DESTRUCTIVE,
                    $confirmationRequired,
                    false,
                    $idempotency,
                    false,
                );
                self::fail($name . ' must be rejected.');
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }

        $policy = new ExecutionPolicy(
            OperationImpact::DESTRUCTIVE,
            true,
            false,
            'required',
            false,
        );
        self::assertSame('destructive', $policy->toProtocolArray()['impact']);
    }

    public function testDestructiveOperationSemanticsUsesStrictRawConfirmationAndIdempotencyValues(): void
    {
        foreach ([false, 'true', 1, null] as $confirmationRequired) {
            $operation = self::operationFixture();
            $operation->execution->impact = 'destructive';
            $operation->execution->confirmationRequired = $confirmationRequired;
            $operation->execution->idempotency = 'required';
            self::refreshOperationRevision($operation);

            self::assertFalse(
                ProtocolSemantics::operationSemanticsAreValid($operation),
                'confirmation: ' . var_export($confirmationRequired, true),
            );
        }

        foreach (['optional', 'none', true, 1, null] as $idempotency) {
            $operation = self::operationFixture();
            $operation->execution->impact = 'destructive';
            $operation->execution->confirmationRequired = true;
            $operation->execution->idempotency = $idempotency;
            self::refreshOperationRevision($operation);

            self::assertFalse(
                ProtocolSemantics::operationSemanticsAreValid($operation),
                'idempotency: ' . var_export($idempotency, true),
            );
        }

        $operation = self::operationFixture();
        $operation->execution->impact = 'destructive';
        $operation->execution->confirmationRequired = true;
        $operation->execution->idempotency = 'required';
        self::refreshOperationRevision($operation);
        self::assertTrue(ProtocolSemantics::operationSemanticsAreValid($operation));
    }

    public function testOutputSupportsEveryJsonValueAndDistinguishesExplicitNullFromAbsence(): void
    {
        $base = [
            'id' => 'run-output',
            'operationId' => 'test.echo',
            'operationRevision' => 'sha256:' . str_repeat('a', 64),
            'sequence' => 2,
            'state' => RunStatus::SUCCEEDED,
            'createdAt' => '2026-08-30T10:00:00Z',
            'updatedAt' => '2026-08-30T10:00:01Z',
            'startedAt' => '2026-08-30T10:00:00Z',
            'completedAt' => '2026-08-30T10:00:01Z',
        ];
        foreach ([
            'object' => [(object) ['ok' => true], '{"ok":true}'],
            'list' => [[1, 'two'], '[1,"two"]'],
            'null' => [null, 'null'],
            'boolean' => [false, 'false'],
            'string' => ['done', '"done"'],
            'number' => [2.5, '2.5'],
        ] as $name => [$value, $expected]) {
            $run = new Run(...[...$base, 'output' => self::jsonValue($value)]);
            $wire = JsonOwnership::transport(JsonOwnership::object($run->toProtocolArray()));

            self::assertTrue(property_exists($wire, 'output'), $name);
            self::assertSame($expected, json_encode(
                $wire->output,
                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION,
            ), $name);
            self::assertTrue(RuntimeGuard::canonicalRunIsValid($run), $name);
        }

        $absent = new Run(...$base);
        $absentWire = JsonOwnership::transport(JsonOwnership::object($absent->toProtocolArray()));
        self::assertFalse(property_exists($absentWire, 'output'));
    }

    public function testProgressRejectsCurrentAboveTotal(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new RunProgress(2, 1, 'Impossible', '2026-08-30T10:00:00Z');
    }

    public function testProgressAcceptsFractionalNumbersAndRejectsUnsafeFloatingPointValues(): void
    {
        $progress = new RunProgress(0.25, 1.5, 'Fractional', '2026-08-30T10:00:00Z');
        self::assertSame(0.25, $progress->current);
        self::assertSame(1.5, $progress->total);

        foreach ([
            'current NaN' => [NAN, 1.0],
            'current infinity' => [INF, 1.0],
            'total negative infinity' => [0.0, -INF],
            'current negative zero' => [-0.0, 1.0],
            'total negative zero' => [0.0, -0.0],
        ] as $name => [$current, $total]) {
            try {
                new RunProgress($current, $total, 'Unsafe', '2026-08-30T10:00:00Z');
                self::fail($name . ' must be rejected.');
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function testItNormalizesArtifactsAndEmitsACompleteRunEvent(): void
    {
        $run = new Run(
            'run-1',
            'test.echo',
            'sha256:' . str_repeat('a', 64),
            2,
            RunStatus::SUCCEEDED,
            '2026-08-30T10:00:00Z',
            '2026-08-30T10:00:01Z',
            startedAt: '2026-08-30T10:00:00Z',
            completedAt: '2026-08-30T10:00:01Z',
            output: JsonOwnership::object(['ok' => true]),
            artifacts: [new Artifact('notice-1', 'notice', JsonOwnership::object(['level' => 'info', 'message' => 'Done']))],
            actions: [FollowUpAction::openLink('Docs', 'https://example.com')],
        );

        $wire = $run->toProtocolArray();
        self::assertSame('notice', $wire['artifacts'][0]['kind']);
        self::assertIsArray($wire['artifacts'][0]);

        $event = new RunEvent('event-1', 2, '2026-08-30T10:00:01Z', $run);
        self::assertSame(['id', 'sequence', 'occurredAt', 'type', 'run'], array_keys($event->toProtocolArray()));
        self::assertSame('run.updated', $event->toProtocolArray()['type']);
        self::assertTrue(RuntimeGuard::canonicalRunIsValid($run));
        self::assertTrue(RuntimeGuard::canonicalRunEventIsValid($event));
    }

    public function testStateDiscriminatedRunUnionIsEnforced(): void
    {
        $base = [
            'id' => 'run-1',
            'operationId' => 'test.echo',
            'operationRevision' => 'sha256:' . str_repeat('a', 64),
            'sequence' => 0,
            'createdAt' => '2026-08-30T10:00:00Z',
            'updatedAt' => '2026-08-30T10:00:00Z',
        ];

        foreach ([
            [...$base, 'state' => RunStatus::QUEUED, 'completedAt' => '2026-08-30T10:00:01Z'],
            [...$base, 'state' => RunStatus::SUCCEEDED],
            [...$base, 'state' => RunStatus::FAILED, 'completedAt' => '2026-08-30T10:00:01Z'],
            [...$base, 'state' => RunStatus::SUCCEEDED, 'completedAt' => '2026-08-30T10:00:01Z', 'problem' => new Problem('urn:gauntlet:problem:handler-failed', 'Failed', 500)],
        ] as $case) {
            try {
                new Run(...$case);
                self::fail('Expected invalid state union member to be rejected.');
            } catch (\InvalidArgumentException) {
            }
        }
        self::addToAssertionCount(4);
    }

    public function testExecutionTerminalStatesRejectEveryNonCanonicalProblemMember(): void
    {
        $base = [
            'id' => 'run-terminal',
            'operationId' => 'test.echo',
            'operationRevision' => 'sha256:' . str_repeat('a', 64),
            'sequence' => 2,
            'createdAt' => '2026-08-30T10:00:00Z',
            'updatedAt' => '2026-08-30T10:00:02Z',
            'completedAt' => '2026-08-30T10:00:02Z',
        ];
        $cases = [
            'cancelled type' => [
                RunStatus::CANCELLED,
                new Problem('urn:gauntlet:problem:handler-failed', 'Run cancelled', 409),
            ],
            'cancelled title' => [
                RunStatus::CANCELLED,
                new Problem('urn:gauntlet:problem:run-cancelled', 'Cancelled by adapter', 409),
            ],
            'cancelled status' => [
                RunStatus::CANCELLED,
                new Problem('urn:gauntlet:problem:run-cancelled', 'Run cancelled', 500),
            ],
            'timed out type' => [
                RunStatus::TIMED_OUT,
                new Problem('urn:gauntlet:problem:handler-failed', 'Run timed out', 504),
            ],
            'timed out title' => [
                RunStatus::TIMED_OUT,
                new Problem('urn:gauntlet:problem:run-timed-out', 'Adapter timeout', 504),
            ],
            'timed out status' => [
                RunStatus::TIMED_OUT,
                new Problem('urn:gauntlet:problem:run-timed-out', 'Run timed out', 500),
            ],
        ];

        foreach ($cases as $name => [$state, $problem]) {
            try {
                new Run(...[...$base, 'state' => $state, 'problem' => $problem]);
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
                continue;
            }
            self::fail($name . ' must be rejected.');
        }
    }

    public function testCalendarInvalidRunTimestampIsRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Run(
            'run-1',
            'test.echo',
            'sha256:' . str_repeat('a', 64),
            0,
            RunStatus::QUEUED,
            '2026-02-30T10:00:00Z',
            '2026-02-30T10:00:00Z',
        );
    }

    public function testRunTransitionsAreMonotonicAndPreserveImmutableState(): void
    {
        $queued = $this->activeRun();
        $running = $queued->with([
            'sequence' => 1,
            'state' => RunStatus::RUNNING,
            'updatedAt' => '2026-08-30T10:00:01Z',
            'startedAt' => '2026-08-30T10:00:01Z',
            'progress' => new RunProgress(1, 2, 'Started', '2026-08-30T10:00:01Z'),
        ]);
        $advanced = $running->with([
            'sequence' => 3,
            'updatedAt' => '2026-08-30T10:00:03Z',
            'progress' => new RunProgress(2, 2, 'Done', '2026-08-30T10:00:03Z'),
        ]);

        self::assertTrue(RuntimeGuard::runTransitionIsValid($queued, $running));
        self::assertTrue(RuntimeGuard::runTransitionIsValid($running, $advanced));
        self::assertTrue(RuntimeGuard::runTransitionIsValid($running, $running->with([])));

        foreach ([
            'same-sequence conflict' => $running->with(['updatedAt' => '2026-08-30T10:00:02Z']),
            'sequence regression' => $running->with(['sequence' => 0]),
            'state regression' => $running->with([
                'sequence' => 2,
                'state' => RunStatus::QUEUED,
                'updatedAt' => '2026-08-30T10:00:02Z',
                'startedAt' => null,
                'progress' => null,
            ]),
            'updated timestamp regression' => $running->with([
                'sequence' => 2,
                'updatedAt' => '2026-08-30T10:00:00Z',
                'startedAt' => '2026-08-30T10:00:00Z',
                'progress' => null,
            ]),
            'progress timestamp regression' => $running->with([
                'sequence' => 2,
                'updatedAt' => '2026-08-30T10:00:02Z',
                'progress' => new RunProgress(2, 2, 'Backwards', '2026-08-30T10:00:00Z'),
            ]),
            'changed id' => $running->with(['sequence' => 2, 'id' => 'run-2']),
            'changed operation' => $running->with(['sequence' => 2, 'operationId' => 'test.other']),
            'changed revision' => $running->with([
                'sequence' => 2,
                'operationRevision' => 'sha256:' . str_repeat('b', 64),
            ]),
            'changed creation time' => $running->with([
                'sequence' => 2,
                'createdAt' => '2026-08-30T09:59:59Z',
            ]),
            'changed start time' => $running->with([
                'sequence' => 2,
                'updatedAt' => '2026-08-30T10:00:02Z',
                'startedAt' => '2026-08-30T10:00:02Z',
                'progress' => null,
            ]),
        ] as $name => $next) {
            self::assertFalse(RuntimeGuard::runTransitionIsValid($running, $next), $name);
        }

        $succeeded = $running->with([
            'sequence' => 2,
            'state' => RunStatus::SUCCEEDED,
            'updatedAt' => '2026-08-30T10:00:02Z',
            'completedAt' => '2026-08-30T10:00:02Z',
            'progress' => new RunProgress(2, 2, 'Done', '2026-08-30T10:00:02Z'),
            'output' => JsonOwnership::object(['ok' => true]),
        ]);
        self::assertFalse(RuntimeGuard::runTransitionIsValid(
            $succeeded,
            $succeeded->with(['sequence' => 3, 'updatedAt' => '2026-08-30T10:00:03Z']),
        ));
        self::assertFalse(RuntimeGuard::runTransitionIsValid(
            $succeeded,
            $succeeded->with([
                'sequence' => 3,
                'updatedAt' => '2026-08-30T10:00:03Z',
                'completedAt' => '2026-08-30T10:00:03Z',
            ]),
        ));
    }

    private function activeRun(): Run
    {
        return new Run(
            'run-1',
            'test.echo',
            'sha256:' . str_repeat('a', 64),
            0,
            RunStatus::QUEUED,
            '2026-08-30T10:00:00Z',
            '2026-08-30T10:00:00Z',
        );
    }

    private static function jsonValue(mixed $value): JsonValue
    {
        return JsonOwnership::value($value);
    }

    private static function operationFixture(): \stdClass
    {
        $path = dirname(__DIR__, 6) . '/packages/protocol/fixtures/v1/operation.valid.json';
        $bytes = file_get_contents($path);
        self::assertIsString($bytes);

        return json_decode($bytes, false, 512, JSON_THROW_ON_ERROR);
    }

    private static function refreshOperationRevision(\stdClass $operation): void
    {
        $operation->revision = Rfc8785CanonicalJson::revision(
            JsonOwnership::object(get_object_vars($operation)),
            'revision',
        );
    }
}
