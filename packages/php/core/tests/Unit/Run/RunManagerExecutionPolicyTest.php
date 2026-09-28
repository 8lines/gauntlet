<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Run;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\ExecutionCoordinator;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Contract\RunDispatcher;
use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use EightLines\Gauntlet\Core\Registry\OperationRegistry;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Run\ConfirmationAcknowledgement;
use EightLines\Gauntlet\Core\Run\CreateRunRequest;
use EightLines\Gauntlet\Core\Run\DefaultRunContext;
use EightLines\Gauntlet\Core\Run\ExecutionRegistration;
use EightLines\Gauntlet\Core\Run\ExecutionTask;
use EightLines\Gauntlet\Core\Run\ExecutionRegistrationStatus;
use EightLines\Gauntlet\Core\Run\InMemoryExecutionCoordinator;
use EightLines\Gauntlet\Core\Run\InMemoryRunStore;
use EightLines\Gauntlet\Core\Run\InvocationContextLease;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunManager;
use EightLines\Gauntlet\Core\Run\RunStoreCreateResult;
use EightLines\Gauntlet\Core\Schema\OpisSchemaValidator;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\TestCase;

final class RunManagerExecutionPolicyTest extends TestCase
{
    public function testConfirmationIsValidatedBeforeEveryAdmissionSideEffect(): void
    {
        $policy = self::policy(
            idempotency: 'required',
            impact: OperationImpact::WRITE,
            confirmationRequired: true,
            dryRunSupported: true,
        );

        foreach ([
            'missing' => [null, '/confirmation', '#/confirmation', 'required', 'confirmation acknowledgement is required'],
            'operation' => [
                static fn (PolicyHandler $handler): ConfirmationAcknowledgement => new ConfirmationAcknowledgement(
                    'test.other',
                    $handler->definition()->revision(),
                    OperationImpact::WRITE,
                ),
                '/confirmation/operationId',
                '#/confirmation/operationId',
                'const',
                'confirmation operation does not match',
            ],
            'revision' => [
                static fn (): ConfirmationAcknowledgement => new ConfirmationAcknowledgement(
                    'test.policy',
                    'sha256:' . str_repeat('0', 64),
                    OperationImpact::WRITE,
                ),
                '/confirmation/operationRevision',
                '#/confirmation/operationRevision',
                'const',
                'confirmation revision does not match',
            ],
            'impact' => [
                static fn (PolicyHandler $handler): ConfirmationAcknowledgement => new ConfirmationAcknowledgement(
                    'test.policy',
                    $handler->definition()->revision(),
                    OperationImpact::READ,
                ),
                '/confirmation/impact',
                '#/confirmation/impact',
                'const',
                'confirmation impact does not match',
            ],
        ] as $name => [$confirmation, $instancePath, $schemaPath, $keyword, $message]) {
            $handler = new PolicyHandler($policy);
            $schemaValidator = new CountingSchemaValidator();
            $coordinator = new CountingExecutionCoordinator();
            $store = new CountingRunStore();
            $dispatcher = new CapturingRunDispatcher();
            $manager = new RunManager(
                operations: new OperationRegistry([$handler]),
                store: $store,
                schemaValidator: $schemaValidator,
                fingerprintSecret: str_repeat('s', 32),
                executionCoordinator: $coordinator,
                dispatcher: $dispatcher,
            );
            $acknowledgement = $confirmation instanceof \Closure ? $confirmation($handler) : $confirmation;

            $result = $manager->create('test.policy', new CreateRunRequest(
                operationRevision: $handler->definition()->revision(),
                input: JsonOwnership::object(['message' => 'must-not-run']),
                dryRun: $name === 'missing',
                idempotencyKey: 'same-key',
                confirmation: $acknowledgement,
            ));

            self::assertFalse($result->isSuccess(), $name);
            self::assertSame(422, $result->problem?->status, $name);
            self::assertCount(1, $result->problem?->errors ?? [], $name);
            $error = $result->problem?->errors[0] ?? null;
            self::assertSame($instancePath, $error?->instancePath, $name);
            self::assertSame($schemaPath, $error?->schemaPath, $name);
            self::assertSame($keyword, $error?->keyword, $name);
            self::assertSame($message, $error?->message, $name);
            self::assertSame(0, $schemaValidator->calls, $name);
            self::assertSame(0, $coordinator->calls, $name);
            self::assertSame(0, $store->createCalls, $name);
            self::assertSame(0, $store->replayCalls, $name);
            self::assertSame(0, $store->getCalls, $name);
            self::assertSame(0, $store->updateCalls, $name);
            self::assertSame([], $dispatcher->tasks, $name);
            self::assertSame(0, $handler->executions, $name);
        }
    }

    public function testStaleRevisionPrecedesConfirmationValidation(): void
    {
        $handler = new PolicyHandler(self::policy(
            idempotency: 'required',
            impact: OperationImpact::WRITE,
            confirmationRequired: true,
        ));
        $schemaValidator = new CountingSchemaValidator();
        $coordinator = new CountingExecutionCoordinator();
        $store = new CountingRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = new RunManager(
            operations: new OperationRegistry([$handler]),
            store: $store,
            schemaValidator: $schemaValidator,
            fingerprintSecret: str_repeat('s', 32),
            executionCoordinator: $coordinator,
            dispatcher: $dispatcher,
        );

        $result = $manager->create('test.policy', new CreateRunRequest(
            operationRevision: 'sha256:' . str_repeat('0', 64),
            input: JsonOwnership::object(['message' => 'stale']),
            idempotencyKey: 'stale-key',
        ));

        self::assertFalse($result->isSuccess());
        self::assertSame(409, $result->problem?->status);
        self::assertSame('urn:gauntlet:problem:stale-operation-revision', $result->problem?->type);
        self::assertSame(0, $schemaValidator->calls);
        self::assertSame(0, $coordinator->calls);
        self::assertSame(0, $store->createCalls);
        self::assertSame(0, $store->replayCalls);
        self::assertSame(0, $handler->executions);
        self::assertSame([], $dispatcher->tasks);
    }

    public function testReplayWithoutRequiredConfirmationIsRejectedBeforeLookup(): void
    {
        $handler = new PolicyHandler(self::policy(
            idempotency: 'required',
            impact: OperationImpact::WRITE,
            confirmationRequired: true,
        ));
        $schemaValidator = new CountingSchemaValidator();
        $coordinator = new CountingExecutionCoordinator();
        $store = new CountingRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = new RunManager(
            operations: new OperationRegistry([$handler]),
            store: $store,
            schemaValidator: $schemaValidator,
            fingerprintSecret: str_repeat('s', 32),
            executionCoordinator: $coordinator,
            dispatcher: $dispatcher,
        );
        $revision = $handler->definition()->revision();
        $valid = new CreateRunRequest(
            operationRevision: $revision,
            input: JsonOwnership::object(['message' => 'accepted']),
            idempotencyKey: 'replay-key',
            confirmation: new ConfirmationAcknowledgement(
                'test.policy',
                $revision,
                OperationImpact::WRITE,
            ),
        );
        $created = $manager->create('test.policy', $valid);
        self::assertTrue($created->isSuccess());
        self::assertTrue($dispatcher->tasks[0]->run());
        $calls = [
            $schemaValidator->calls,
            $coordinator->calls,
            $store->createCalls,
            $store->replayCalls,
            $store->getCalls,
            $store->updateCalls,
            $handler->executions,
            count($dispatcher->tasks),
        ];

        $replay = $manager->create('test.policy', new CreateRunRequest(
            operationRevision: $revision,
            input: JsonOwnership::object(['message' => 'accepted']),
            idempotencyKey: 'replay-key',
        ));

        self::assertFalse($replay->isSuccess());
        self::assertSame(422, $replay->problem?->status);
        self::assertSame('/confirmation', $replay->problem?->errors[0]->instancePath);
        self::assertSame($calls, [
            $schemaValidator->calls,
            $coordinator->calls,
            $store->createCalls,
            $store->replayCalls,
            $store->getCalls,
            $store->updateCalls,
            $handler->executions,
            count($dispatcher->tasks),
        ]);
    }

    public function testDryRunStateReachesHandlerAndPreventsApplicationMutation(): void
    {
        $mutations = 0;
        $seen = [];
        $retained = null;
        $handler = new PolicyHandler(
            self::policy(
                idempotency: 'required',
                impact: OperationImpact::WRITE,
                dryRunSupported: true,
            ),
            onExecute: static function (object $input, RunContext $context) use (
                &$mutations,
                &$seen,
                &$retained,
            ): void {
                $retained = $context;
                $seen[] = $context->isDryRun();
                if (!$context->isDryRun()) {
                    ++$mutations;
                }
            },
        );
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);

        $dry = $manager->create('test.policy', new CreateRunRequest(
            operationRevision: $handler->definition()->revision(),
            input: JsonOwnership::object(['message' => 'dry']),
            dryRun: true,
            idempotencyKey: 'dry-run',
        ));
        self::assertTrue($dry->isSuccess());
        self::assertTrue($dispatcher->tasks[0]->run());
        self::assertSame([true], $seen);
        self::assertSame(0, $mutations);
        self::assertInstanceOf(RunContext::class, $retained);
        self::assertTrue($retained->isDryRun());

        $live = $manager->create('test.policy', new CreateRunRequest(
            operationRevision: $handler->definition()->revision(),
            input: JsonOwnership::object(['message' => 'live']),
            dryRun: false,
            idempotencyKey: 'live-run',
        ));
        self::assertTrue($live->isSuccess());
        self::assertTrue($dispatcher->tasks[1]->run());
        self::assertSame([true, false], $seen);
        self::assertSame(1, $mutations);
        self::assertFalse($retained->isDryRun());
        self::assertCount(2, $store->all());
    }

    public function testUnsupportedDryRunReturnsItsExactRequestPointerBeforeAdmission(): void
    {
        $handler = new PolicyHandler(self::policy(dryRunSupported: false));
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);

        $result = $manager->create('test.policy', new CreateRunRequest(
            operationRevision: $handler->definition()->revision(),
            input: JsonOwnership::object(['message' => 'must-not-run']),
            dryRun: true,
        ));

        self::assertFalse($result->isSuccess());
        self::assertSame(422, $result->problem?->status);
        $errors = $result->problem?->errors ?? [];
        self::assertCount(1, $errors);
        self::assertSame('/dryRun', $errors[0]->instancePath ?? null);
        self::assertSame([], $store->all());
        self::assertSame([], $dispatcher->tasks);
        self::assertSame(0, $handler->executions);
    }

    public function testDeferredDispatchReturnsQueuedAndSameKeyDoesNotDispatchTwice(): void
    {
        $handler = new PolicyHandler(self::policy());
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);
        $request = self::request($handler, 'one', 'same-key');

        $first = $manager->create('test.policy', $request);
        $duplicate = $manager->create('test.policy', $request);

        self::assertSame('queued', $first->run?->state->value);
        self::assertSame($first->run?->id, $duplicate->run?->id);
        self::assertSame(0, $handler->executions);
        self::assertCount(1, $dispatcher->tasks);

        $dispatcher->tasks[0]->run();
        $dispatcher->tasks[0]->run();

        self::assertSame(1, $handler->executions);
        self::assertSame('succeeded', $manager->get($first->run?->id ?? '')?->state->value);
    }

    public function testForbidRejectsAnotherAcceptedRunWithoutCreatingASecondRun(): void
    {
        $handler = new PolicyHandler(self::policy(concurrency: 'forbid'));
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);

        $first = $manager->create('test.policy', self::request($handler, 'first', 'first-key'));
        $duplicate = $manager->create('test.policy', self::request($handler, 'first', 'first-key'));
        $busy = $manager->create('test.policy', self::request($handler, 'second', 'second-key'));

        self::assertSame('queued', $first->run?->state->value);
        self::assertSame($first->run?->id, $duplicate->run?->id);
        self::assertFalse($busy->isSuccess());
        self::assertSame('urn:gauntlet:problem:operation-busy', $busy->problem?->type);
        self::assertSame(409, $busy->problem?->status);
        self::assertCount(1, $store->all());
        self::assertCount(1, $dispatcher->tasks);
    }

    public function testHistoricalIdempotencyReplayPrecedesAnotherActiveForbidRun(): void
    {
        $handler = new PolicyHandler(self::policy(concurrency: 'forbid', idempotency: 'required'));
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);
        $historicalRequest = self::request($handler, 'historical', 'historical-key');
        $historical = $manager->create('test.policy', $historicalRequest);
        $dispatcher->tasks[0]->run();
        self::assertSame('succeeded', $manager->get($historical->run?->id ?? '')?->state->value);
        $active = $manager->create(
            'test.policy',
            self::request($handler, 'active', 'active-key'),
        );
        self::assertSame('queued', $active->run?->state->value);

        $replay = $manager->create('test.policy', $historicalRequest);

        self::assertTrue($replay->isSuccess());
        self::assertSame($historical->run?->id, $replay->run?->id);
        self::assertSame('succeeded', $replay->run?->state->value);
        self::assertCount(2, $store->all());
        self::assertCount(2, $dispatcher->tasks);
    }

    public function testConcurrentRequiredSameKeyReplaysWinnerBeforeForbidCanRejectIt(): void
    {
        $handler = new PolicyHandler(self::policy(concurrency: 'forbid', idempotency: 'required'));
        $store = new SuspendingCreateRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::managerWithStore($handler, $store, $dispatcher);
        $request = self::request($handler, 'same', 'required-key');
        $firstResult = null;
        $secondResult = null;
        $first = new \Fiber(static function () use ($manager, $request, &$firstResult): void {
            $firstResult = $manager->create('test.policy', $request);
        });
        $second = new \Fiber(static function () use ($manager, $request, &$secondResult): void {
            $secondResult = $manager->create('test.policy', $request);
        });

        $first->start();
        self::assertTrue($first->isSuspended());
        $second->start();
        self::assertTrue($second->isSuspended());
        $first->resume();

        self::assertTrue($first->isTerminated());
        self::assertTrue($second->isTerminated());
        self::assertTrue($firstResult?->isSuccess() ?? false);
        self::assertTrue($secondResult?->isSuccess() ?? false);
        self::assertSame($firstResult?->run?->id, $secondResult?->run?->id);
        self::assertCount(1, $store->all());
        self::assertCount(1, $dispatcher->tasks);
    }

    public function testConcurrentRequiredDifferentKeyWaitsForPublicationBeforeBusyRejection(): void
    {
        $handler = new PolicyHandler(self::policy(concurrency: 'forbid', idempotency: 'required'));
        $store = new SuspendingCreateRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::managerWithStore($handler, $store, $dispatcher);
        $firstResult = null;
        $secondResult = null;
        $first = new \Fiber(static function () use ($manager, $handler, &$firstResult): void {
            $firstResult = $manager->create(
                'test.policy',
                self::request($handler, 'first', 'first-required-key'),
            );
        });
        $second = new \Fiber(static function () use ($manager, $handler, &$secondResult): void {
            $secondResult = $manager->create(
                'test.policy',
                self::request($handler, 'second', 'second-required-key'),
            );
        });

        $first->start();
        self::assertTrue($first->isSuspended());
        $second->start();
        self::assertTrue($second->isSuspended());
        self::assertCount(0, $store->all());
        $first->resume();

        self::assertTrue($firstResult?->isSuccess() ?? false);
        self::assertTrue($second->isTerminated());
        self::assertSame('urn:gauntlet:problem:operation-busy', $secondResult?->problem?->type);
        self::assertCount(1, $store->all());
        self::assertCount(1, $dispatcher->tasks);
    }

    public function testFailedUnpublishedForbidReservationWakesAndAdmitsTheNextRequest(): void
    {
        $handler = new PolicyHandler(self::policy(concurrency: 'forbid', idempotency: 'required'));
        $store = new SuspendingFailingCreateRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::managerWithStore($handler, $store, $dispatcher);
        $firstResult = null;
        $secondResult = null;
        $first = new \Fiber(static function () use ($manager, $handler, &$firstResult): void {
            $firstResult = $manager->create(
                'test.policy',
                self::request($handler, 'first', 'first-required-key'),
            );
        });
        $second = new \Fiber(static function () use ($manager, $handler, &$secondResult): void {
            $secondResult = $manager->create(
                'test.policy',
                self::request($handler, 'second', 'second-required-key'),
            );
        });

        $first->start();
        self::assertTrue($first->isSuspended());
        $second->start();
        self::assertTrue($second->isSuspended());
        $first->resume();

        self::assertTrue($first->isTerminated());
        self::assertFalse($firstResult?->isSuccess() ?? true);
        self::assertSame('urn:gauntlet:problem:adapter-internal-error', $firstResult?->problem?->type);
        self::assertTrue($second->isTerminated());
        self::assertTrue($secondResult?->isSuccess() ?? false);
        self::assertSame('queued', $secondResult?->run?->state->value);
        self::assertCount(1, $store->all());
        self::assertCount(1, $dispatcher->tasks);
    }

    public function testUnpublishedForbidConflictOutsideAFiberFailsClosedInsteadOfClaimingBusy(): void
    {
        $coordinator = new InMemoryExecutionCoordinator();
        $coordinator->register('test.policy', 'run-unpublished', 'forbid', null);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('publication');

        $coordinator->register('test.policy', 'run-contender', 'forbid', null);
    }

    public function testUnpublishedDuplicateOutsideAFiberFailsClosedInsteadOfClaimingReplay(): void
    {
        $coordinator = new InMemoryExecutionCoordinator();
        $coordinator->register('test.policy', 'run-unpublished', 'allow', 'same-fingerprint');

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('publication');

        $coordinator->register('test.policy', 'run-contender', 'allow', 'same-fingerprint');
    }

    public function testQueueExecutesDeferredTasksInRegistrationOrder(): void
    {
        $order = [];
        $handler = new PolicyHandler(self::policy(concurrency: 'queue'), onExecute: static function (
            object $input,
        ) use (&$order): void {
            $order[] = $input->message;
        });
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);

        foreach (['first', 'second', 'third'] as $value) {
            $created = $manager->create('test.policy', self::request($handler, $value, $value . '-key'));
            self::assertSame('queued', $created->run?->state->value);
        }

        $second = new \Fiber($dispatcher->tasks[1]->run(...));
        $third = new \Fiber($dispatcher->tasks[2]->run(...));
        $second->start();
        $third->start();
        self::assertTrue($second->isSuspended());
        self::assertTrue($third->isSuspended());

        $dispatcher->tasks[0]->run();

        self::assertSame(['first', 'second', 'third'], $order);
        self::assertTrue($second->isTerminated());
        self::assertTrue($third->isTerminated());
    }

    public function testQueueTaskInvokedOutOfOrderOutsideFiberStaysQueuedAndCanBeRetried(): void
    {
        $order = [];
        $handler = new PolicyHandler(
            self::policy(concurrency: 'queue'),
            onExecute: static function (object $input) use (&$order): void {
                $order[] = $input->message;
            },
        );
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);
        $first = $manager->create(
            'test.policy',
            self::request($handler, 'first', 'first-key'),
        )->run;
        $second = $manager->create(
            'test.policy',
            self::request($handler, 'second', 'second-key'),
        )->run;

        self::assertFalse($dispatcher->tasks[1]->run());
        self::assertSame('queued', $manager->get($second?->id ?? '')?->state->value);
        self::assertSame([], $order);

        self::assertTrue($dispatcher->tasks[0]->run());
        self::assertTrue($dispatcher->tasks[1]->run());

        self::assertSame(['first', 'second'], $order);
        self::assertSame('succeeded', $manager->get($first?->id ?? '')?->state->value);
        self::assertSame('succeeded', $manager->get($second?->id ?? '')?->state->value);
    }

    public function testDuplicateRunIdCannotReplaceAnExistingCoordinatorRegistration(): void
    {
        $coordinator = new InMemoryExecutionCoordinator();
        $first = $coordinator->register('test.policy', 'run-duplicate', 'forbid', 'fingerprint-a');
        self::assertSame(ExecutionRegistrationStatus::READY, $first->status);

        try {
            $coordinator->register('test.other', 'run-duplicate', 'allow', 'fingerprint-b');
            self::fail('Duplicate run ID registration must fail.');
        } catch (\LogicException $exception) {
            self::assertSame('Execution run ID is already registered.', $exception->getMessage());
        }

        $coordinator->publish('run-duplicate');
        self::assertTrue($coordinator->awaitTurn('test.policy', 'run-duplicate'));
        $coordinator->requestCancellation('run-duplicate');
        self::assertTrue($coordinator->isCancellationRequested('run-duplicate'));
    }

    public function testDiscardedExecutionTaskReleasesItsCapturedSecretWithoutExecuting(): void
    {
        $secret = new \stdClass();
        $weakSecret = \WeakReference::create($secret);
        $executions = 0;
        $task = new ExecutionTask(
            'run-discard',
            'test.policy',
            static function () use ($secret, &$executions): bool {
                ++$executions;

                return true;
            },
        );
        unset($secret);
        gc_collect_cycles();
        self::assertNotNull($weakSecret->get());

        self::assertTrue($task->discard());
        gc_collect_cycles();

        self::assertTrue($task->isDiscarded());
        self::assertNull($weakSecret->get());
        self::assertTrue($task->run());
        self::assertSame(0, $executions);
    }

    public function testConcurrentExecutionTaskInvocationNeverStartsTheCallbackTwice(): void
    {
        $executions = 0;
        $task = new ExecutionTask(
            'run-single-callback',
            'test.policy',
            static function () use (&$executions): bool {
                ++$executions;
                \Fiber::suspend();

                return true;
            },
        );
        $first = new \Fiber($task->run(...));

        $first->start();

        self::assertTrue($first->isSuspended());
        self::assertFalse($task->run());
        self::assertSame(1, $executions);
        $first->resume();
        self::assertTrue($first->isTerminated());
        self::assertTrue($task->run());
        self::assertSame(1, $executions);
    }

    public function testAllowTracksEveryActiveRunIndependentlyDuringCancelAndRelease(): void
    {
        $coordinator = new InMemoryExecutionCoordinator();
        foreach (['run-allow-a', 'run-allow-b'] as $runId) {
            self::assertSame(
                ExecutionRegistrationStatus::READY,
                $coordinator->register('test.policy', $runId, 'allow', null)->status,
            );
            $coordinator->publish($runId);
            self::assertTrue($coordinator->awaitTurn('test.policy', $runId));
        }

        $coordinator->requestCancellation('run-allow-a');
        $coordinator->release('test.policy', 'run-allow-a');
        $coordinator->requestCancellation('run-allow-b');

        self::assertSame(
            ExecutionRegistrationStatus::QUEUED,
            $coordinator->register('test.policy', 'run-queue-c', 'queue', null)->status,
        );
        self::assertTrue($coordinator->isCancellationRequested('run-allow-b'));
    }

    public function testAbortingTheQueueHeadWakesTheNextPublishedWaiter(): void
    {
        $coordinator = new InMemoryExecutionCoordinator();
        self::assertSame(
            ExecutionRegistrationStatus::READY,
            $coordinator->register('test.policy', 'run-head', 'queue', null)->status,
        );
        $coordinator->publish('run-head');
        self::assertSame(
            ExecutionRegistrationStatus::QUEUED,
            $coordinator->register('test.policy', 'run-next', 'queue', null)->status,
        );
        $coordinator->publish('run-next');
        $hasTurn = false;
        $next = new \Fiber(static function () use ($coordinator, &$hasTurn): void {
            $hasTurn = $coordinator->awaitTurn('test.policy', 'run-next');
        });
        $next->start();
        self::assertTrue($next->isSuspended());

        $coordinator->abort('run-head');

        self::assertTrue($next->isTerminated());
        self::assertTrue($hasTurn);
    }

    public function testLateReleaseOfACancelledQueuedRunCannotReleaseTheNewActiveRun(): void
    {
        $coordinator = new InMemoryExecutionCoordinator();
        foreach (['run-first', 'run-cancelled', 'run-third', 'run-fourth'] as $runId) {
            $coordinator->register('test.policy', $runId, 'queue', null);
            $coordinator->publish($runId);
        }
        self::assertTrue($coordinator->awaitTurn('test.policy', 'run-first'));
        $coordinator->requestCancellation('run-cancelled');
        $coordinator->release('test.policy', 'run-first');
        self::assertTrue($coordinator->awaitTurn('test.policy', 'run-third'));
        $fourthHasTurn = null;
        $fourth = new \Fiber(static function () use ($coordinator, &$fourthHasTurn): void {
            $fourthHasTurn = $coordinator->awaitTurn('test.policy', 'run-fourth');
        });
        $fourth->start();
        self::assertTrue($fourth->isSuspended());

        $coordinator->release('test.policy', 'run-cancelled');

        self::assertTrue($fourth->isSuspended());
        self::assertNull($fourthHasTurn);
        $coordinator->release('test.policy', 'run-third');
        self::assertTrue($fourth->isTerminated());
        self::assertTrue($fourthHasTurn);
    }

    public function testCancellationSignalsTheActiveContextAndWinsTheTerminalRace(): void
    {
        $observedCancellation = false;
        $cancelled = null;
        $manager = null;
        $handler = new PolicyHandler(
            self::policy(cancellationSupported: true),
            onExecute: static function (object $input, RunContext $context) use (
                &$manager,
                &$observedCancellation,
                &$cancelled,
            ): void {
                self::assertInstanceOf(RunManager::class, $manager);
                $cancelled = $manager->cancel($context->runId());
                $observedCancellation = $context->isCancelled();
                $context->progress(1, 1, 'must be ignored');
            },
        );
        $store = new InMemoryRunStore();
        $manager = self::manager($handler, $store);

        $created = $manager->create('test.policy', self::request($handler, 'cancel', 'cancel-key'));

        self::assertTrue($observedCancellation);
        self::assertNotInstanceOf(Problem::class, $cancelled);
        self::assertSame('cancelled', $created->run?->state->value);
        self::assertSame('urn:gauntlet:problem:run-cancelled', $created->run?->problem?->type);
        self::assertNull($created->run?->progress);
        self::assertSame(
            ['queued', 'running', 'cancelled'],
            array_map(static fn ($run): string => $run->state->value, $store->snapshots($created->run?->id ?? '')),
        );
    }

    public function testCancellingTheMiddleQueuedRunDoesNotBlockTheNextRun(): void
    {
        $order = [];
        $handler = new PolicyHandler(
            self::policy(cancellationSupported: true, concurrency: 'queue'),
            onExecute: static function (object $input) use (&$order): void {
                $order[] = $input->message;
                if ($input->message === 'first') {
                    \Fiber::suspend();
                }
            },
        );
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);
        $runs = [];
        foreach (['first', 'second', 'third'] as $value) {
            $runs[] = $manager->create(
                'test.policy',
                self::request($handler, $value, $value . '-key'),
            )->run;
        }

        $first = new \Fiber($dispatcher->tasks[0]->run(...));
        $first->start();
        self::assertTrue($first->isSuspended());
        $cancelled = $manager->cancel($runs[1]?->id ?? '');
        self::assertNotInstanceOf(Problem::class, $cancelled);
        self::assertSame('cancelled', $cancelled->state->value);

        $third = new \Fiber($dispatcher->tasks[2]->run(...));
        $third->start();
        self::assertTrue($third->isSuspended());
        $first->resume();

        self::assertTrue($first->isTerminated());
        self::assertTrue($third->isTerminated());
        self::assertSame(['first', 'third'], $order);
        self::assertSame(2, $handler->executions);
    }

    public function testCancelBeforeDeferredDispatchPreventsHandlerExecution(): void
    {
        $handler = new PolicyHandler(self::policy(cancellationSupported: true));
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'cancel', 'cancel-key'));

        $cancelled = $manager->cancel($created->run?->id ?? '');
        $dispatcher->tasks[0]->run();

        self::assertNotInstanceOf(Problem::class, $cancelled);
        self::assertSame('cancelled', $cancelled->state->value);
        self::assertSame(0, $handler->executions);
        self::assertTrue($dispatcher->tasks[0]->isDiscarded());
        self::assertSame('cancelled', $manager->get($created->run?->id ?? '')?->state->value);
    }

    public function testCancelRejectsARunWhoseOperationDoesNotSupportCancellation(): void
    {
        $handler = new PolicyHandler(self::policy(cancellationSupported: false));
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'stay', 'stay-key'));

        $problem = $manager->cancel($created->run?->id ?? '');

        self::assertInstanceOf(Problem::class, $problem);
        self::assertSame('urn:gauntlet:problem:run-not-cancellable', $problem->type);
        self::assertSame(409, $problem->status);
        self::assertSame('queued', $manager->get($created->run?->id ?? '')?->state->value);
    }

    public function testCancelRejectsATerminalRunWhoseOperationDoesNotSupportCancellation(): void
    {
        $handler = new PolicyHandler(self::policy(cancellationSupported: false));
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'done', 'done-key'));
        $dispatcher->tasks[0]->run();
        self::assertSame('succeeded', $manager->get($created->run?->id ?? '')?->state->value);

        $problem = $manager->cancel($created->run?->id ?? '');

        self::assertInstanceOf(Problem::class, $problem);
        self::assertSame('urn:gauntlet:problem:run-not-cancellable', $problem->type);
        self::assertSame(409, $problem->status);
    }

    public function testCancelOfATerminalCancellableRunReplaysTheSameRun(): void
    {
        $handler = new PolicyHandler(self::policy(cancellationSupported: true));
        $store = new InMemoryRunStore();
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::manager($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'done', 'done-key'));
        $dispatcher->tasks[0]->run();
        $terminal = $manager->get($created->run?->id ?? '');

        $replayed = $manager->cancel($created->run?->id ?? '');

        self::assertInstanceOf(Run::class, $replayed);
        self::assertSame($terminal, $replayed);
    }

    public function testLifecycleTimestampsDoNotRegressBehindAStoredFutureTimestamp(): void
    {
        $handler = new PolicyHandler(
            self::policy(),
            onExecute: static function (object $input, RunContext $context): void {
                $context->progress(1, 1, 'done');
            },
        );
        $store = new FutureQueuedTimestampRunStore('2099-01-01T00:00:00.000000Z');
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::managerWithStore($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'clock', 'clock-key'));

        self::assertTrue($dispatcher->tasks[0]->run());

        $terminal = $manager->get($created->run?->id ?? '');
        self::assertSame('succeeded', $terminal?->state->value);
        self::assertSame('2099-01-01T00:00:00.000000Z', $terminal?->startedAt);
        $previous = null;
        foreach ($store->snapshots() as $snapshot) {
            if ($previous !== null) {
                self::assertGreaterThanOrEqual(
                    new \DateTimeImmutable($previous),
                    new \DateTimeImmutable($snapshot->updatedAt),
                );
            }
            $previous = $snapshot->updatedAt;
        }
        self::assertSame($terminal?->updatedAt, $terminal?->completedAt);
        self::assertSame($terminal?->updatedAt, $terminal?->progress?->updatedAt);
    }

    public function testTimeoutIgnoresLateResultAndContextWrites(): void
    {
        $handler = new PolicyHandler(
            self::policy(timeoutSeconds: 1),
            onExecute: static function (object $input, RunContext $context): void {
                usleep(1_050_000);
                $context->progress(1, 1, 'late');
            },
        );
        $store = new InMemoryRunStore();
        $manager = self::manager($handler, $store);

        $created = $manager->create('test.policy', self::request($handler, 'timeout', 'timeout-key'));

        self::assertSame('timed_out', $created->run?->state->value);
        self::assertSame('urn:gauntlet:problem:run-timed-out', $created->run?->problem?->type);
        self::assertSame(504, $created->run?->problem?->status);
        self::assertNull($created->run?->progress);
        self::assertNull($created->run?->output);
    }

    public function testJournalStoreFailureCannotLeaveAnInlineRunRunningForever(): void
    {
        $handler = new PolicyHandler(self::policy());
        $store = new FailOnceOnSelectedUpdateRunStore(2);
        $manager = self::managerWithStore($handler, $store);

        $created = $manager->create('test.policy', self::request($handler, 'store', 'store-key'));

        self::assertSame('failed', $created->run?->state->value);
        self::assertSame('urn:gauntlet:problem:adapter-internal-error', $created->run?->problem?->type);
        self::assertSame(
            ['queued', 'running', 'failed'],
            array_map(static fn (Run $run): string => $run->state->value, $store->snapshots()),
        );
    }

    public function testDeferredTaskContainsRunningStoreFailureAndTerminalizesTheQueuedRun(): void
    {
        $handler = new PolicyHandler(self::policy());
        $store = new FailOnceOnSelectedUpdateRunStore(1);
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::managerWithStore($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'store', 'store-key'));

        $dispatcher->tasks[0]->run();

        self::assertSame('failed', $manager->get($created->run?->id ?? '')?->state->value);
        self::assertSame(
            ['queued', 'failed'],
            array_map(static fn (Run $run): string => $run->state->value, $store->snapshots()),
        );
    }

    public function testDeferredTaskContainsTransientStoreReadFailureAndTerminalizesTheQueuedRun(): void
    {
        $handler = new PolicyHandler(self::policy());
        $store = new FailOnceOnSelectedGetRunStore(2);
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::managerWithStore($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'store', 'store-key'));

        self::assertTrue($dispatcher->tasks[0]->run());

        self::assertSame('failed', $manager->get($created->run?->id ?? '')?->state->value);
        self::assertSame(
            ['queued', 'failed'],
            array_map(static fn (Run $run): string => $run->state->value, $store->snapshots()),
        );
    }

    public function testDeferredTaskRetriesFailedTerminalizationWithoutChangingItToCancellation(): void
    {
        $handler = new PolicyHandler(self::policy());
        $store = new FailOnceOnSelectedGetRunStore(2, 3);
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::managerWithStore($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'store', 'store-key'));

        self::assertFalse($dispatcher->tasks[0]->run());
        self::assertSame(['queued'], array_map(
            static fn (Run $run): string => $run->state->value,
            $store->snapshots(),
        ));

        self::assertTrue($dispatcher->tasks[0]->run());
        self::assertSame('failed', $manager->get($created->run?->id ?? '')?->state->value);
        self::assertSame(
            ['queued', 'failed'],
            array_map(static fn (Run $run): string => $run->state->value, $store->snapshots()),
        );
    }

    public function testDeferredTaskContainsJournalStoreFailureAndTerminalizesTheRunningRun(): void
    {
        $handler = new PolicyHandler(self::policy());
        $store = new FailOnceOnSelectedUpdateRunStore(2);
        $dispatcher = new CapturingRunDispatcher();
        $manager = self::managerWithStore($handler, $store, $dispatcher);
        $created = $manager->create('test.policy', self::request($handler, 'store', 'store-key'));

        $dispatcher->tasks[0]->run();

        self::assertSame('failed', $manager->get($created->run?->id ?? '')?->state->value);
        self::assertSame(
            ['queued', 'running', 'failed'],
            array_map(static fn (Run $run): string => $run->state->value, $store->snapshots()),
        );
    }

    public function testClosedSuccessfulContextDoesNotObserveFutureCancellationOrDeadline(): void
    {
        $cancelled = true;
        $context = new DefaultRunContext(
            'run-closed',
            'test.policy',
            false,
            new InvocationContextLease(null),
            static fn (): bool => $cancelled,
            hrtime(true) - 1,
        );

        $context->close();

        self::assertFalse($context->isCancelled());
    }

    private static function manager(
        PolicyHandler $handler,
        InMemoryRunStore $store,
        ?RunDispatcher $dispatcher = null,
    ): RunManager {
        return self::managerWithStore($handler, $store, $dispatcher);
    }

    private static function managerWithStore(
        PolicyHandler $handler,
        RunStore $store,
        ?RunDispatcher $dispatcher = null,
    ): RunManager {
        return new RunManager(
            operations: new OperationRegistry([$handler]),
            store: $store,
            schemaValidator: new OpisSchemaValidator(),
            fingerprintSecret: str_repeat('s', 32),
            executionCoordinator: new InMemoryExecutionCoordinator(),
            dispatcher: $dispatcher,
        );
    }

    private static function request(PolicyHandler $handler, string $message, string $key): CreateRunRequest
    {
        return new CreateRunRequest(
            operationRevision: $handler->definition()->revision(),
            input: JsonOwnership::object(['message' => $message]),
            idempotencyKey: $key,
        );
    }

    private static function policy(
        bool $cancellationSupported = false,
        ?int $timeoutSeconds = null,
        ?string $concurrency = null,
        string $idempotency = 'optional',
        OperationImpact $impact = OperationImpact::READ,
        bool $confirmationRequired = false,
        bool $dryRunSupported = false,
    ): ExecutionPolicy {
        return new ExecutionPolicy(
            impact: $impact,
            confirmationRequired: $confirmationRequired,
            dryRunSupported: $dryRunSupported,
            idempotency: $idempotency,
            cancellationSupported: $cancellationSupported,
            timeoutSeconds: $timeoutSeconds,
            concurrency: $concurrency,
        );
    }
}

final class CountingSchemaValidator implements SchemaValidator
{
    public int $calls = 0;

    private readonly OpisSchemaValidator $inner;

    public function __construct()
    {
        $this->inner = new OpisSchemaValidator();
    }

    /** @return list<ValidationError> */
    public function validate(JsonObject $schema, JsonValue $instance): array
    {
        ++$this->calls;

        return $this->inner->validate($schema, $instance);
    }
}

final class CountingExecutionCoordinator implements ExecutionCoordinator
{
    public int $calls = 0;

    private readonly InMemoryExecutionCoordinator $inner;

    public function __construct()
    {
        $this->inner = new InMemoryExecutionCoordinator();
    }

    public function register(
        string $operationId,
        string $runId,
        string $concurrency,
        ?string $idempotencyFingerprint,
    ): ExecutionRegistration {
        ++$this->calls;

        return $this->inner->register($operationId, $runId, $concurrency, $idempotencyFingerprint);
    }

    public function publish(string $runId): void
    {
        ++$this->calls;
        $this->inner->publish($runId);
    }

    public function abort(string $runId): void
    {
        ++$this->calls;
        $this->inner->abort($runId);
    }

    public function awaitTurn(string $operationId, string $runId): ?bool
    {
        ++$this->calls;

        return $this->inner->awaitTurn($operationId, $runId);
    }

    public function release(string $operationId, string $runId): void
    {
        ++$this->calls;
        $this->inner->release($operationId, $runId);
    }

    public function requestCancellation(string $runId): void
    {
        ++$this->calls;
        $this->inner->requestCancellation($runId);
    }

    public function isCancellationRequested(string $runId): bool
    {
        ++$this->calls;

        return $this->inner->isCancellationRequested($runId);
    }
}

final class CountingRunStore implements RunStore
{
    public int $createCalls = 0;

    public int $replayCalls = 0;

    public int $getCalls = 0;

    public int $updateCalls = 0;

    private readonly InMemoryRunStore $inner;

    public function __construct()
    {
        $this->inner = new InMemoryRunStore();
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        ++$this->createCalls;

        return $this->inner->createQueued($run, $idempotencyFingerprint);
    }

    public function get(string $runId): ?Run
    {
        ++$this->getCalls;

        return $this->inner->get($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        ++$this->replayCalls;

        return $this->inner->findByIdempotencyFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        ++$this->updateCalls;

        return $this->inner->updateExactSequence($run, $expectedPreviousSequence);
    }
}

final class SuspendingCreateRunStore implements RunStore
{
    private readonly InMemoryRunStore $inner;

    private bool $suspended = false;

    public function __construct()
    {
        $this->inner = new InMemoryRunStore();
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        if (!$this->suspended) {
            $this->suspended = true;
            \Fiber::suspend();
        }

        return $this->inner->createQueued($run, $idempotencyFingerprint);
    }

    public function get(string $runId): ?Run
    {
        return $this->inner->get($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->inner->findByIdempotencyFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        return $this->inner->updateExactSequence($run, $expectedPreviousSequence);
    }

    /** @return list<Run> */
    public function all(): array
    {
        return $this->inner->all();
    }
}

final class SuspendingFailingCreateRunStore implements RunStore
{
    private readonly InMemoryRunStore $inner;

    private int $creates = 0;

    public function __construct()
    {
        $this->inner = new InMemoryRunStore();
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        ++$this->creates;
        if ($this->creates === 1) {
            \Fiber::suspend();

            throw new \RuntimeException('first reservation failed');
        }

        return $this->inner->createQueued($run, $idempotencyFingerprint);
    }

    public function get(string $runId): ?Run
    {
        return $this->inner->get($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->inner->findByIdempotencyFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        return $this->inner->updateExactSequence($run, $expectedPreviousSequence);
    }

    /** @return list<Run> */
    public function all(): array
    {
        return $this->inner->all();
    }
}

final class FutureQueuedTimestampRunStore implements RunStore
{
    private readonly InMemoryRunStore $inner;

    private ?string $runId = null;

    public function __construct(private readonly string $futureTimestamp)
    {
        $this->inner = new InMemoryRunStore();
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        $future = $run->with(['updatedAt' => $this->futureTimestamp]);
        $this->runId = $future->id;

        return $this->inner->createQueued($future, $idempotencyFingerprint);
    }

    public function get(string $runId): ?Run
    {
        return $this->inner->get($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->inner->findByIdempotencyFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        return $this->inner->updateExactSequence($run, $expectedPreviousSequence);
    }

    /** @return list<Run> */
    public function snapshots(): array
    {
        return $this->inner->snapshots($this->runId ?? '');
    }
}

final class FailOnceOnSelectedUpdateRunStore implements RunStore
{
    private readonly InMemoryRunStore $inner;

    private int $updates = 0;

    private ?string $runId = null;

    public function __construct(private readonly int $failingUpdate)
    {
        $this->inner = new InMemoryRunStore();
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        $this->runId = $run->id;

        return $this->inner->createQueued($run, $idempotencyFingerprint);
    }

    public function get(string $runId): ?Run
    {
        return $this->inner->get($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->inner->findByIdempotencyFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        ++$this->updates;
        if ($this->updates === $this->failingUpdate) {
            throw new \RuntimeException('single store failure');
        }

        return $this->inner->updateExactSequence($run, $expectedPreviousSequence);
    }

    /** @return list<Run> */
    public function snapshots(): array
    {
        return $this->inner->snapshots($this->runId ?? '');
    }
}

final class FailOnceOnSelectedGetRunStore implements RunStore
{
    private readonly InMemoryRunStore $inner;

    private int $gets = 0;

    private ?string $runId = null;

    public function __construct(
        private readonly int $failingGet,
        private readonly ?int $lastFailingGet = null,
    ) {
        $this->inner = new InMemoryRunStore();
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        $this->runId = $run->id;

        return $this->inner->createQueued($run, $idempotencyFingerprint);
    }

    public function get(string $runId): ?Run
    {
        ++$this->gets;
        if ($this->gets >= $this->failingGet
            && $this->gets <= ($this->lastFailingGet ?? $this->failingGet)) {
            throw new \RuntimeException('single store read failure');
        }

        return $this->inner->get($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->inner->findByIdempotencyFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        return $this->inner->updateExactSequence($run, $expectedPreviousSequence);
    }

    /** @return list<Run> */
    public function snapshots(): array
    {
        return $this->inner->snapshots($this->runId ?? '');
    }
}

final class CapturingRunDispatcher implements RunDispatcher
{
    /** @var list<ExecutionTask> */
    public array $tasks = [];

    public function dispatch(ExecutionTask $task): void
    {
        $this->tasks[] = $task;
    }
}

final class PolicyHandler implements OperationHandler
{
    public int $executions = 0;

    /** @var (\Closure(object, RunContext): void)|null */
    private readonly ?\Closure $onExecute;

    /** @param (callable(object, RunContext): void)|null $onExecute */
    public function __construct(
        private readonly ExecutionPolicy $policy,
        ?callable $onExecute = null,
    ) {
        $this->onExecute = $onExecute === null ? null : \Closure::fromCallable($onExecute);
    }

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'test.policy',
            featureId: 'feature',
            label: 'Policy',
            description: null,
            inputSchema: JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['message'],
                'properties' => ['message' => ['type' => 'string']],
                'additionalProperties' => false,
            ]),
            inputHandling: null,
            contextSchema: null,
            uiSchema: null,
            dataSources: [],
            presets: [],
            execution: $this->policy,
            output: new OperationOutput(JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'additionalProperties' => false,
            ])),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;
        ($this->onExecute ?? static function (): void {})($input, $context);

        return new OperationResult(JsonOwnership::object([]), ['title' => 'OK', 'tone' => 'success']);
    }
}
