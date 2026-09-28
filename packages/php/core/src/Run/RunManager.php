<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Contract\ExecutionCoordinator;
use EightLines\Gauntlet\Core\Contract\FileReferenceValidator;
use EightLines\Gauntlet\Core\Contract\InputMapper;
use EightLines\Gauntlet\Core\Contract\InputMappingException;
use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunDispatcher;
use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Registry\OperationRegistry;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;

/** Framework-neutral lifecycle with durable snapshots and pluggable dispatch. */
final class RunManager
{
    private readonly ExecutionCoordinator $executionCoordinator;

    private readonly RunDispatcher $dispatcher;

    /** @var array<string, ExecutionTask> */
    private array $pendingTasks = [];

    public function __construct(
        private readonly OperationRegistry $operations,
        private readonly RunStore $store,
        private readonly SchemaValidator $schemaValidator,
        private readonly string $fingerprintSecret,
        private readonly ?InputMapper $inputMapper = null,
        private readonly ?FileReferenceValidator $fileReferenceValidator = null,
        ?ExecutionCoordinator $executionCoordinator = null,
        ?RunDispatcher $dispatcher = null,
    ) {
        if (strlen($fingerprintSecret) < 32) {
            throw new \InvalidArgumentException('Idempotency fingerprint secret must contain at least 32 bytes.');
        }
        $this->executionCoordinator = $executionCoordinator ?? new InMemoryExecutionCoordinator();
        $this->dispatcher = $dispatcher ?? new InlineRunDispatcher();
    }

    public function get(string $id): ?Run
    {
        try {
            ProtocolId::assert($id);
        } catch (\InvalidArgumentException) {
            return null;
        }

        try {
            $run = $this->store->get($id);
        } catch (\Throwable) {
            return null;
        }
        if ($run === null) {
            return null;
        }
        $definition = $this->operations->definition($run->operationId);

        return $definition !== null && $this->storedRunIsValid($run, $id, $definition) ? $run : null;
    }

    public function create(string $operationId, CreateRunRequest $request): RunCreationResult
    {
        try {
            ProtocolId::assert($operationId);
        } catch (\InvalidArgumentException) {
            return RunCreationResult::failure(self::problem(
                'invalid-operation-id',
                'Invalid operation ID',
                422,
                $request,
            ));
        }

        $handler = $this->operations->find($operationId);
        if ($handler === null) {
            return RunCreationResult::failure(self::problem(
                'operation-not-found',
                'Operation not found',
                404,
                $request,
            ));
        }
        $definition = $this->operations->definition($operationId);
        if ($definition === null) {
            return RunCreationResult::failure(self::internalProblem($request));
        }
        if (!hash_equals($definition->revision(), $request->operationRevision)) {
            return RunCreationResult::failure(self::problem(
                'stale-operation-revision',
                'Stale operation revision',
                409,
                $request,
            ));
        }
        $confirmationError = $this->confirmationError($operationId, $definition, $request);
        if ($confirmationError !== null) {
            return RunCreationResult::failure(self::validationProblem($request, [$confirmationError]));
        }

        try {
            $sourceSecrets = InputHandlingGuard::secretValues($definition, $request->input);
        } catch (\Throwable) {
            return RunCreationResult::failure(self::internalProblem($request));
        }
        if ($sourceSecrets === null) {
            return RunCreationResult::failure(self::internalProblem($request));
        }

        try {
            $preflight = $this->preflight($definition, $request);
        } catch (\Throwable) {
            return RunCreationResult::failure(self::safeProblem(
                self::internalProblem($request),
                $sourceSecrets,
            ));
        }
        if ($preflight instanceof Problem) {
            return RunCreationResult::failure(self::safeProblem($preflight, $sourceSecrets));
        }

        $fingerprint = $request->idempotencyKey === null
            ? null
            : IdempotencyFingerprint::from($operationId, $request->idempotencyKey, $this->fingerprintSecret);
        if ($fingerprint !== null) {
            try {
                $historical = $this->store->findByIdempotencyFingerprint($operationId, $fingerprint);
            } catch (\Throwable) {
                return RunCreationResult::failure(self::safeProblem(
                    self::internalProblem($request),
                    $sourceSecrets,
                ));
            }
            if ($historical !== null) {
                if (!$this->storedRunIsValid($historical, $historical->id, $definition)) {
                    return RunCreationResult::failure(self::safeProblem(
                        self::internalProblem($request),
                        $sourceSecrets,
                    ));
                }

                return RunCreationResult::success($historical);
            }
        }
        try {
            $now = self::now();
            $queued = new Run(
                id: 'run-' . bin2hex(random_bytes(12)),
                operationId: $operationId,
                operationRevision: $definition->revision(),
                sequence: 0,
                state: RunStatus::QUEUED,
                createdAt: $now,
                updatedAt: $now,
            );
            $registration = $this->executionCoordinator->register(
                $operationId,
                $queued->id,
                $definition->execution->concurrency ?? 'allow',
                $fingerprint,
            );
        } catch (\Throwable) {
            return RunCreationResult::failure(self::safeProblem(
                self::internalProblem($request),
                $sourceSecrets,
            ));
        }
        if ($registration->status === ExecutionRegistrationStatus::REJECTED) {
            return RunCreationResult::failure(self::safeProblem(
                self::problem('operation-busy', 'Operation busy', 409, $request),
                $sourceSecrets,
            ));
        }
        if ($registration->status === ExecutionRegistrationStatus::DUPLICATE) {
            $winning = $this->validatedStoreRead(
                $registration->duplicateRunId ?? '',
                $definition,
            );
            if ($winning === null) {
                return RunCreationResult::failure(self::safeProblem(
                    self::internalProblem($request),
                    $sourceSecrets,
                ));
            }

            return RunCreationResult::success($winning);
        }

        try {
            $reservation = $this->store->createQueued($queued, $fingerprint);
        } catch (\Throwable) {
            $this->abortRegistration($queued->id);

            return RunCreationResult::failure(self::safeProblem(
                self::internalProblem($request),
                $sourceSecrets,
            ));
        }
        if (!$reservation->created) {
            $this->abortRegistration($queued->id);
            // The atomic store result is authoritative; reread to avoid a
            // stale duplicate snapshot from a distributed implementation.
            $winning = $this->validatedStoreRead($reservation->run->id, $definition);
            if ($winning === null) {
                return RunCreationResult::failure(self::safeProblem(
                    self::internalProblem($request, $queued->id),
                    $sourceSecrets,
                ));
            }

            return RunCreationResult::success($winning);
        }

        try {
            $this->executionCoordinator->publish($queued->id);
        } catch (\Throwable) {
            $this->abortRegistration($queued->id);
            $failed = $this->persistTerminal(
                $queued->id,
                $definition,
                RunStatus::FAILED,
                self::safeProblem(self::internalProblem($request, $queued->id), $sourceSecrets),
                $sourceSecrets,
            );

            return $failed === null
                ? RunCreationResult::failure(self::safeProblem(
                    self::internalProblem($request, $queued->id),
                    $sourceSecrets,
                ))
                : RunCreationResult::success($failed);
        }

        $invocationContext = $request->context;
        $dryRun = $request->dryRun;
        $executionCorrelationId = self::correlationId($request, $queued->id);
        $taskBoundaryFailed = false;
        $task = new ExecutionTask(
            $queued->id,
            $operationId,
            function () use (
                $handler,
                $definition,
                $queued,
                $preflight,
                $invocationContext,
                $dryRun,
                $executionCorrelationId,
                $sourceSecrets,
                &$taskBoundaryFailed,
            ): bool {
                if ($taskBoundaryFailed) {
                    return $this->terminalizeTaskBoundaryFailure(
                        $queued,
                        $definition,
                        $executionCorrelationId,
                        $sourceSecrets,
                    );
                }
                try {
                    $completed = $this->executeReserved(
                        $handler,
                        $definition,
                        $queued,
                        $preflight,
                        $invocationContext,
                        $dryRun,
                        $executionCorrelationId,
                        $sourceSecrets,
                    );
                    if ($completed) {
                        unset($this->pendingTasks[$queued->id]);
                    }

                    return $completed;
                } catch (\Throwable) {
                    $taskBoundaryFailed = true;
                    // Deferred dispatch runs after create() has returned, so
                    // this task boundary must contain execution/store failures
                    // and resolve the still-active Run through the same CAS
                    // terminal transition used by inline dispatch.
                    return $this->terminalizeTaskBoundaryFailure(
                        $queued,
                        $definition,
                        $executionCorrelationId,
                        $sourceSecrets,
                    );
                }
            },
        );
        $this->pendingTasks[$queued->id] = $task;
        try {
            $this->dispatcher->dispatch($task);
        } catch (\Throwable) {
            $task->discard();
            unset($this->pendingTasks[$queued->id]);
            $this->abortRegistration($queued->id);
            $failed = $this->persistTerminal(
                $queued->id,
                $definition,
                RunStatus::FAILED,
                self::safeProblem(self::internalProblem($request, $queued->id), $sourceSecrets),
                $sourceSecrets,
            );

            return $failed === null
                ? RunCreationResult::failure(self::safeProblem(
                    self::internalProblem($request, $queued->id),
                    $sourceSecrets,
                ))
                : RunCreationResult::success($failed);
        }

        $current = $this->validatedStoreRead($queued->id, $definition);

        return $current === null || ($taskBoundaryFailed && !$current->state->terminal())
            ? RunCreationResult::failure(self::safeProblem(
                self::internalProblem($request, $queued->id),
                $sourceSecrets,
            ))
            : RunCreationResult::success($current);
    }

    public function cancel(string $runId): Run|Problem
    {
        try {
            ProtocolId::assert($runId);
        } catch (\InvalidArgumentException) {
            return self::simpleProblem('run-not-found', 'Run not found', 404);
        }

        $run = $this->get($runId);
        if ($run === null) {
            return self::simpleProblem('run-not-found', 'Run not found', 404);
        }
        $definition = $this->operations->definition($run->operationId);
        if ($definition === null) {
            return self::simpleProblem('adapter-internal-error', 'Adapter internal error', 500);
        }
        if (!$definition->execution->cancellationSupported) {
            return self::simpleProblem(
                'run-not-cancellable',
                'Run is not cancellable',
                409,
            );
        }
        if ($run->state->terminal()) {
            return $run;
        }

        try {
            $this->executionCoordinator->requestCancellation($runId);
        } catch (\Throwable) {
            return self::simpleProblem('adapter-internal-error', 'Adapter internal error', 500);
        }

        $terminal = $this->persistTerminal(
            $runId,
            $definition,
            RunStatus::CANCELLED,
            self::simpleProblem('run-cancelled', 'Run cancelled', 409),
            [],
        );
        if ($terminal !== null) {
            $task = $this->pendingTasks[$runId] ?? null;
            if ($task?->discard() ?? false) {
                unset($this->pendingTasks[$runId]);
            }
        }

        return $terminal ?? self::simpleProblem('adapter-internal-error', 'Adapter internal error', 500);
    }

    /** @param array<string, true> $sourceSecrets */
    private function terminalizeTaskBoundaryFailure(
        Run $queued,
        OperationDefinition $definition,
        ?string $correlationId,
        array $sourceSecrets,
    ): bool {
        $failed = $this->persistTerminal(
            $queued->id,
            $definition,
            RunStatus::FAILED,
            self::safeProblem(self::executionProblem(
                'adapter-internal-error',
                'Adapter internal error',
                500,
                $correlationId,
            ), $sourceSecrets),
            $sourceSecrets,
        );
        if ($failed !== null) {
            unset($this->pendingTasks[$queued->id]);
        }

        return $failed !== null;
    }

    /** @param array<string, true> $sourceSecrets */
    private function executeReserved(
        OperationHandler $handler,
        OperationDefinition $definition,
        Run $queued,
        object $input,
        ?InvocationContext $invocationContext,
        bool $dryRun,
        ?string $correlationId,
        array $sourceSecrets,
    ): bool {
        $release = true;
        try {
            try {
                $hasTurn = $this->executionCoordinator->awaitTurn($queued->operationId, $queued->id);
            } catch (\Throwable) {
                $this->persistTerminal(
                    $queued->id,
                    $definition,
                    RunStatus::FAILED,
                    self::safeProblem(self::executionProblem(
                        'adapter-internal-error',
                        'Adapter internal error',
                        500,
                        $correlationId,
                    ), $sourceSecrets),
                    $sourceSecrets,
                );

                return true;
            }
            if ($hasTurn === null) {
                $release = false;

                return false;
            }
            if (!$hasTurn || $this->cancellationRequested($queued->id)) {
                $this->persistTerminal(
                    $queued->id,
                    $definition,
                    RunStatus::CANCELLED,
                    self::simpleProblem('run-cancelled', 'Run cancelled', 409),
                    $sourceSecrets,
                );

                return true;
            }

            $current = $this->validatedStoreRead($queued->id, $definition);
            if ($current === null) {
                throw new \RuntimeException('Failed to read the reserved Run before execution.');
            }
            if ($current->state->terminal()) {
                return true;
            }
            if ($current->state !== RunStatus::QUEUED) {
                $this->persistTerminal(
                    $queued->id,
                    $definition,
                    RunStatus::FAILED,
                    self::safeProblem(self::executionProblem(
                        'adapter-internal-error',
                        'Adapter internal error',
                        500,
                        $correlationId,
                    ), $sourceSecrets),
                    $sourceSecrets,
                );

                return true;
            }

            $runningAt = self::notBefore(self::now(), $current->updatedAt);
            $running = $current->with([
                'sequence' => $current->sequence + 1,
                'state' => RunStatus::RUNNING,
                'startedAt' => $runningAt,
                'updatedAt' => $runningAt,
            ]);
            try {
                $runningStored = $this->store->updateExactSequence($running, $current->sequence);
            } catch (\Throwable $exception) {
                throw new \RuntimeException('Failed to persist running Run snapshot.', 0, $exception);
            }
            if (!$runningStored) {
                $raced = $this->validatedStoreRead($queued->id, $definition);
                if ($raced?->state->terminal()) {
                    return true;
                }

                throw new \RuntimeException('Failed to persist running Run snapshot.');
            }

            $deadline = self::deadline($definition->execution->timeoutSeconds);
            $lease = new InvocationContextLease($invocationContext);
            $context = new DefaultRunContext(
                $queued->id,
                $queued->operationId,
                $dryRun,
                $lease,
                fn (): bool => $this->executionCoordinator->isCancellationRequested($queued->id),
                $deadline,
            );
            $result = null;
            $failure = null;
            $termination = null;
            try {
                $result = $handler->execute($input, $context);
            } catch (\Throwable) {
                $failure = self::executionProblem(
                    'handler-failed',
                    'Operation failed',
                    500,
                    $correlationId,
                );
            } finally {
                $termination = $context->terminationStatus();
                // A retained handler context loses access before terminal state
                // construction on every outcome.
                $context->close();
                $lease->close();
            }

            if ($termination === RunStatus::TIMED_OUT) {
                $this->persistTerminal(
                    $queued->id,
                    $definition,
                    RunStatus::TIMED_OUT,
                    self::simpleProblem('run-timed-out', 'Run timed out', 504),
                    $sourceSecrets,
                );

                return true;
            }
            if ($termination === RunStatus::CANCELLED || $this->cancellationRequested($queued->id)) {
                $this->persistTerminal(
                    $queued->id,
                    $definition,
                    RunStatus::CANCELLED,
                    self::simpleProblem('run-cancelled', 'Run cancelled', 409),
                    $sourceSecrets,
                );

                return true;
            }
            if ($failure !== null || $result === null) {
                $this->persistTerminal(
                    $queued->id,
                    $definition,
                    RunStatus::FAILED,
                    self::safeProblem(
                        $failure ?? self::executionProblem(
                            'handler-failed',
                            'Operation failed',
                            500,
                            $correlationId,
                        ),
                        $sourceSecrets,
                    ),
                    $sourceSecrets,
                );

                return true;
            }

            try {
                $snapshots = $this->buildJournalSnapshots(
                    $running,
                    $context->events(),
                    $result,
                    $definition,
                    $sourceSecrets,
                );
            } catch (\Throwable) {
                $this->persistTerminal(
                    $queued->id,
                    $definition,
                    RunStatus::FAILED,
                    self::safeProblem(self::executionProblem(
                        'adapter-internal-error',
                        'Adapter internal error',
                        500,
                        $correlationId,
                    ), $sourceSecrets),
                    $sourceSecrets,
                );

                return true;
            }

            $previousSequence = $running->sequence;
            foreach ($snapshots as $snapshot) {
                $lateTermination = $this->lateTermination($queued->id, $deadline);
                if ($lateTermination !== null) {
                    $this->persistTerminal(
                        $queued->id,
                        $definition,
                        $lateTermination,
                        $lateTermination === RunStatus::TIMED_OUT
                            ? self::simpleProblem('run-timed-out', 'Run timed out', 504)
                            : self::simpleProblem('run-cancelled', 'Run cancelled', 409),
                        $sourceSecrets,
                    );

                    return true;
                }
                try {
                    $stored = $this->store->updateExactSequence($snapshot, $previousSequence);
                } catch (\Throwable $exception) {
                    throw new \RuntimeException('Failed to persist Run journal snapshot.', 0, $exception);
                }
                if (!$stored) {
                    $raced = $this->validatedStoreRead($queued->id, $definition);
                    if ($raced?->state->terminal()) {
                        return true;
                    }

                    throw new \RuntimeException('Failed to persist Run journal snapshot.');
                }
                $previousSequence = $snapshot->sequence;
            }

            return true;
        } finally {
            if ($release) {
                try {
                    $this->executionCoordinator->release($queued->operationId, $queued->id);
                } catch (\Throwable) {
                    // Terminal persistence is authoritative; coordinator cleanup
                    // failures are handled by a deployment's lease/recovery policy.
                }
            }
        }
    }

    /**
     * @param list<array{
     *     kind: 'progress'|'artifact'|'action',
     *     timestamp: string,
     *     value: RunProgress|Artifact|FollowUpAction
     * }> $events
     * @param array<string, true> $sourceSecrets
     * @return list<Run>
     */
    private function buildJournalSnapshots(
        Run $running,
        array $events,
        OperationResult $result,
        OperationDefinition $definition,
        array $sourceSecrets,
    ): array {
        foreach ($result->artifacts as $artifact) {
            $events[] = ['kind' => 'artifact', 'timestamp' => self::now(), 'value' => $artifact];
        }
        foreach ($result->actions as $action) {
            $events[] = ['kind' => 'action', 'timestamp' => self::now(), 'value' => $action];
        }

        $snapshots = [];
        $current = $running;
        foreach ($events as $event) {
            $timestamp = self::notBefore($event['timestamp'], $current->updatedAt);
            $value = $event['value'];
            if ($value instanceof RunProgress && $value->updatedAt !== $timestamp) {
                $value = new RunProgress(
                    $value->current,
                    $value->total,
                    $value->message,
                    $timestamp,
                    $value->phase,
                    $value->extensions,
                );
            }
            $changes = match ($event['kind']) {
                'progress' => ['progress' => $value],
                'artifact' => ['artifacts' => [...$current->artifacts, $value]],
                'action' => ['actions' => [...$current->actions, $value]],
            };
            $current = $current->with([
                'sequence' => $current->sequence + 1,
                'state' => RunStatus::RUNNING,
                'updatedAt' => $timestamp,
                ...$changes,
            ]);
            $this->assertSafeSnapshot($current, $definition, $sourceSecrets);
            $snapshots[] = $current;
        }

        $timestamp = self::notBefore(self::now(), $current->updatedAt);
        $terminal = $current->with([
            'sequence' => $current->sequence + 1,
            'state' => RunStatus::SUCCEEDED,
            'updatedAt' => $timestamp,
            'completedAt' => $timestamp,
            'summary' => $result->summary,
            'output' => $result->output,
        ]);
        $this->assertSafeSnapshot($terminal, $definition, $sourceSecrets);
        $snapshots[] = $terminal;

        return $snapshots;
    }

    /** @param array<string, true> $sourceSecrets */
    private function assertSafeSnapshot(
        Run $run,
        OperationDefinition $definition,
        array $sourceSecrets,
    ): void {
        if (
            !RuntimeGuard::canonicalRunIsValid($run)
            || RuntimeGuard::validateProjection(
                $run->output,
                $run->progress,
                $run->summary,
                $run->problem,
                $run->artifacts,
                $run->actions,
                $definition,
                $this->operations,
                $this->schemaValidator,
                $sourceSecrets,
                $this->fileReferenceValidator,
            ) !== null
        ) {
            throw new \UnexpectedValueException('Unsafe Run snapshot.');
        }
    }

    private function preflight(OperationDefinition $definition, CreateRunRequest $request): object
    {
        if ($request->dryRun && !$definition->execution->dryRunSupported) {
            return self::validationProblem($request, [new ValidationError(
                '/dryRun',
                '#/dryRun',
                'dryRun',
                'operation does not support dry-run execution',
                JsonOwnership::object([]),
            )]);
        }

        $key = $request->idempotencyKey;
        if ($definition->execution->idempotency === 'none' && $key !== null) {
            return self::validationProblem($request, []);
        }
        if ($definition->execution->idempotency === 'required' && ($key === null || trim($key) === '')) {
            return self::validationProblem($request, []);
        }
        if ($key !== null && trim($key) === '') {
            return self::validationProblem($request, []);
        }

        $errors = $this->schemaValidator->validate($definition->inputSchema, $request->input);
        if ($errors !== []) {
            return self::validationProblem($request, $errors);
        }
        if ($definition->contextSchema !== null) {
            $context = $request->context?->toJsonObject() ?? JsonOwnership::object([]);
            $errors = $this->schemaValidator->validate($definition->contextSchema, $context);
            if ($errors !== []) {
                return self::validationProblem($request, $errors);
            }
        }

        $handlingProblem = InputHandlingGuard::validate(
            $definition,
            $request->input,
            $this->fileReferenceValidator,
            self::correlationId($request),
        );
        if ($handlingProblem !== null) {
            return $handlingProblem;
        }

        if ($definition->inputClass === null) {
            return $request->input->jsonSerialize();
        }
        if ($this->inputMapper === null) {
            return self::internalProblem($request);
        }
        try {
            $mapped = $this->inputMapper->map($request->input, $definition->inputClass);
            if (!$mapped instanceof $definition->inputClass) {
                return self::validationProblem($request, []);
            }

            return $mapped;
        } catch (InputMappingException $exception) {
            return self::validationProblem($request, $exception->errors);
        } catch (\Throwable) {
            return self::validationProblem($request, [new ValidationError(
                '',
                '#/type',
                'mapping',
                'Invalid value.',
                JsonOwnership::object([]),
            )]);
        }
    }

    private function confirmationError(
        string $operationId,
        OperationDefinition $definition,
        CreateRunRequest $request,
    ): ?ValidationError {
        if (!$definition->execution->confirmationRequired) {
            return null;
        }
        if ($request->confirmation === null) {
            return self::confirmationValidationError(
                '/confirmation',
                'required',
                'confirmation acknowledgement is required',
            );
        }
        if ($request->confirmation->operationId !== $operationId) {
            return self::confirmationValidationError(
                '/confirmation/operationId',
                'const',
                'confirmation operation does not match',
            );
        }
        if ($request->confirmation->operationRevision !== $definition->revision()) {
            return self::confirmationValidationError(
                '/confirmation/operationRevision',
                'const',
                'confirmation revision does not match',
            );
        }
        if ($request->confirmation->impact !== $definition->execution->impact) {
            return self::confirmationValidationError(
                '/confirmation/impact',
                'const',
                'confirmation impact does not match',
            );
        }

        return null;
    }

    private static function confirmationValidationError(
        string $path,
        string $keyword,
        string $message,
    ): ValidationError {
        return new ValidationError(
            $path,
            '#' . $path,
            $keyword,
            $message,
            JsonOwnership::object([]),
        );
    }

    /** @param list<ValidationError> $errors */
    private static function validationProblem(CreateRunRequest $request, array $errors): Problem
    {
        return Problem::validation($errors, self::correlationId($request));
    }

    private static function problem(
        string $code,
        string $title,
        int $status,
        CreateRunRequest $request,
        ?string $fallbackCorrelationId = null,
    ): Problem {
        return new Problem(
            'urn:gauntlet:problem:' . $code,
            $title,
            $status,
            correlationId: self::correlationId($request, $fallbackCorrelationId),
        );
    }

    private static function internalProblem(
        CreateRunRequest $request,
        ?string $fallbackCorrelationId = null,
    ): Problem {
        return self::problem(
            'adapter-internal-error',
            'Adapter internal error',
            500,
            $request,
            $fallbackCorrelationId,
        );
    }

    /** @param array<string, true> $sourceSecrets */
    private static function safeProblem(Problem $problem, array $sourceSecrets): Problem
    {
        if (!InputHandlingGuard::containsAny($problem->toProtocolArray(), $sourceSecrets)) {
            return $problem;
        }

        return new Problem(
            'urn:gauntlet:problem:adapter-internal-error',
            'Adapter internal error',
            500,
        );
    }

    private function validatedStoreRead(string $id, OperationDefinition $definition): ?Run
    {
        try {
            $run = $this->store->get($id);
        } catch (\Throwable) {
            return null;
        }

        return $run !== null && $this->storedRunIsValid($run, $id, $definition) ? $run : null;
    }

    private function storedRunIsValid(Run $run, string $id, OperationDefinition $definition): bool
    {
        return RuntimeGuard::storedRunIsValid(
            $run,
            $id,
            $definition,
            $this->operations,
            $this->schemaValidator,
            $this->fileReferenceValidator,
        );
    }

    /** @param array<string, true> $sourceSecrets */
    private function persistTerminal(
        string $runId,
        OperationDefinition $definition,
        RunStatus $status,
        Problem $problem,
        array $sourceSecrets,
    ): ?Run {
        if (!$status->terminal() || $status === RunStatus::SUCCEEDED) {
            throw new \InvalidArgumentException('Expected an unsuccessful terminal Run status.');
        }
        for ($attempt = 0; $attempt < 32; ++$attempt) {
            $current = $this->validatedStoreRead($runId, $definition);
            if ($current === null) {
                return null;
            }
            if ($current->state->terminal()) {
                return $current;
            }
            $timestamp = self::notBefore(self::now(), $current->updatedAt);
            try {
                $terminal = $current->with([
                    'sequence' => $current->sequence + 1,
                    'state' => $status,
                    'updatedAt' => $timestamp,
                    'completedAt' => $timestamp,
                    'problem' => $problem,
                ]);
                $this->assertSafeSnapshot($terminal, $definition, $sourceSecrets);
                if ($this->store->updateExactSequence($terminal, $current->sequence)) {
                    return $terminal;
                }
            } catch (\Throwable) {
                // A compare-and-swap race is resolved by the next validated
                // read; a hostile store will exhaust the bounded retry loop.
            }
        }

        $current = $this->validatedStoreRead($runId, $definition);

        return $current?->state->terminal() ? $current : null;
    }

    private function cancellationRequested(string $runId): bool
    {
        try {
            return $this->executionCoordinator->isCancellationRequested($runId);
        } catch (\Throwable) {
            return true;
        }
    }

    private function lateTermination(string $runId, ?int $deadline): ?RunStatus
    {
        if ($deadline !== null && hrtime(true) >= $deadline) {
            return RunStatus::TIMED_OUT;
        }

        return $this->cancellationRequested($runId) ? RunStatus::CANCELLED : null;
    }

    private function abortRegistration(string $runId): void
    {
        try {
            $this->executionCoordinator->abort($runId);
        } catch (\Throwable) {
            // The RunStore remains authoritative for idempotency. Distributed
            // coordinators must recover abandoned reservations through leases.
        }
    }

    private static function deadline(?int $timeoutSeconds): ?int
    {
        if ($timeoutSeconds === null) {
            return null;
        }
        $now = hrtime(true);
        $maximumSeconds = intdiv(PHP_INT_MAX - $now, 1_000_000_000);
        if ($timeoutSeconds > $maximumSeconds) {
            return PHP_INT_MAX;
        }

        return $now + ($timeoutSeconds * 1_000_000_000);
    }

    private static function simpleProblem(string $code, string $title, int $status): Problem
    {
        return new Problem('urn:gauntlet:problem:' . $code, $title, $status);
    }

    private static function executionProblem(
        string $code,
        string $title,
        int $status,
        ?string $correlationId,
    ): Problem {
        return new Problem(
            'urn:gauntlet:problem:' . $code,
            $title,
            $status,
            correlationId: $correlationId,
        );
    }

    private static function correlationId(CreateRunRequest $request, ?string $fallback = null): ?string
    {
        return $request->context?->requestId ?? $fallback;
    }

    private static function now(): string
    {
        return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.u\Z');
    }

    private static function notBefore(string $candidate, string $lowerBound): string
    {
        return new \DateTimeImmutable($candidate) < new \DateTimeImmutable($lowerBound)
            ? $lowerBound
            : $candidate;
    }
}
