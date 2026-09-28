package dev.eightlines.gauntlet.core.run;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.Artifact;
import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.model.FollowUpAction;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.ProtocolId;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunCancellationResult;
import dev.eightlines.gauntlet.core.model.RunCreationResult;
import dev.eightlines.gauntlet.core.model.RunProgress;
import dev.eightlines.gauntlet.core.model.RunState;
import dev.eightlines.gauntlet.core.model.RunSummary;
import dev.eightlines.gauntlet.core.model.ValidationError;
import dev.eightlines.gauntlet.core.registry.OperationRegistry;
import dev.eightlines.gauntlet.core.schema.SchemaValidator;
import dev.eightlines.gauntlet.core.spi.ExecutionCoordinator;
import dev.eightlines.gauntlet.core.spi.FileReferenceValidator;
import dev.eightlines.gauntlet.core.spi.OperationHandler;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.core.spi.RunStoreCreateResult;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Atomic asynchronous run lifecycle independent of any HTTP or framework layer. */
public final class RunManager implements AutoCloseable {
  private static final Set<String> CORE_PROBLEM_TYPES =
      Set.of(
          "urn:gauntlet:problem:adapter-disabled",
          "urn:gauntlet:problem:unsupported-capability",
          "urn:gauntlet:problem:operation-not-found",
          "urn:gauntlet:problem:run-not-found",
          "urn:gauntlet:problem:data-source-not-found",
          "urn:gauntlet:problem:route-not-found",
          "urn:gauntlet:problem:method-not-allowed",
          "urn:gauntlet:problem:invalid-json",
          "urn:gauntlet:problem:invalid-path",
          "urn:gauntlet:problem:validation-failed",
          "urn:gauntlet:problem:stale-operation-revision",
          "urn:gauntlet:problem:operation-busy",
          "urn:gauntlet:problem:run-not-cancellable",
          "urn:gauntlet:problem:run-cancelled",
          "urn:gauntlet:problem:run-timed-out",
          "urn:gauntlet:problem:handler-failed",
          "urn:gauntlet:problem:adapter-invalid-response",
          "urn:gauntlet:problem:adapter-unavailable",
          "urn:gauntlet:problem:adapter-internal-error");
  private static final Set<String> CORE_ARTIFACT_KINDS =
      Set.of(
          "notice",
          "metrics",
          "key-value",
          "table",
          "json",
          "markdown",
          "diff",
          "timeline",
          "log",
          "download",
          "link",
          "browser-launch");

  private final OperationRegistry operations;
  private final RunStore store;
  private final SchemaValidator schemaValidator;
  private final FileReferenceValidator fileReferenceValidator;
  private final byte[] fingerprintSecret;
  private final Clock clock;
  private final Supplier<String> ids;
  private final ExecutionCoordinator coordinator;
  private final ExecutorService workers;
  private final ScheduledExecutorService timer;
  private final boolean ownsExecutors;
  private final ConcurrentHashMap<String, ExecutionControl> active = new ConcurrentHashMap<>();
  private final AtomicBoolean closed = new AtomicBoolean();

  public RunManager(
      OperationRegistry operations,
      RunStore store,
      SchemaValidator schemaValidator,
      FileReferenceValidator fileReferenceValidator,
      byte[] fingerprintSecret,
      Clock clock,
      Supplier<String> ids) {
    this(
        operations,
        store,
        schemaValidator,
        fileReferenceValidator,
        fingerprintSecret,
        clock,
        ids,
        new InMemoryExecutionCoordinator(),
        defaultWorkers(),
        defaultTimer(),
        true);
  }

  public RunManager(
      OperationRegistry operations,
      RunStore store,
      SchemaValidator schemaValidator,
      FileReferenceValidator fileReferenceValidator,
      byte[] fingerprintSecret,
      Clock clock,
      Supplier<String> ids,
      ExecutionCoordinator coordinator) {
    this(
        operations,
        store,
        schemaValidator,
        fileReferenceValidator,
        fingerprintSecret,
        clock,
        ids,
        coordinator,
        defaultWorkers(),
        defaultTimer(),
        true);
  }

  public RunManager(
      OperationRegistry operations,
      RunStore store,
      SchemaValidator schemaValidator,
      FileReferenceValidator fileReferenceValidator,
      byte[] fingerprintSecret,
      Clock clock,
      Supplier<String> ids,
      ExecutionCoordinator coordinator,
      ExecutorService workers,
      ScheduledExecutorService timer) {
    this(
        operations,
        store,
        schemaValidator,
        fileReferenceValidator,
        fingerprintSecret,
        clock,
        ids,
        coordinator,
        workers,
        timer,
        false);
  }

  private RunManager(
      OperationRegistry operations,
      RunStore store,
      SchemaValidator schemaValidator,
      FileReferenceValidator fileReferenceValidator,
      byte[] fingerprintSecret,
      Clock clock,
      Supplier<String> ids,
      ExecutionCoordinator coordinator,
      ExecutorService workers,
      ScheduledExecutorService timer,
      boolean ownsExecutors) {
    this.operations = Objects.requireNonNull(operations, "operations");
    this.store = Objects.requireNonNull(store, "store");
    this.schemaValidator = Objects.requireNonNull(schemaValidator, "schemaValidator");
    this.fileReferenceValidator = fileReferenceValidator;
    if (fingerprintSecret == null || fingerprintSecret.length < 32) {
      throw new IllegalArgumentException("idempotency secret must contain at least 32 bytes");
    }
    this.fingerprintSecret = fingerprintSecret.clone();
    this.clock = Objects.requireNonNull(clock, "clock");
    this.ids = Objects.requireNonNull(ids, "ids");
    this.coordinator = Objects.requireNonNull(coordinator, "coordinator");
    this.workers = Objects.requireNonNull(workers, "workers");
    this.timer = Objects.requireNonNull(timer, "timer");
    this.ownsExecutors = ownsExecutors;
  }

  public RunManager(
      OperationRegistry operations,
      RunStore store,
      SchemaValidator schemaValidator,
      FileReferenceValidator fileReferenceValidator,
      byte[] fingerprintSecret) {
    this(
        operations,
        store,
        schemaValidator,
        fileReferenceValidator,
        fingerprintSecret,
        Clock.systemUTC(),
        () -> "run-" + UUID.randomUUID());
  }

  public Optional<Run> get(String id) {
    try {
      ProtocolId.require(id);
    } catch (RuntimeException exception) {
      return Optional.empty();
    }
    StoreRead read;
    try {
      read = readStoreValue(store.get(id), id, null, null);
    } catch (RuntimeException exception) {
      throw new IllegalStateException("run store read failed");
    }
    if (read.kind == StoreReadKind.INVALID) {
      throw new IllegalStateException("run store returned an invalid run");
    }
    return read.kind == StoreReadKind.VALID ? Optional.of(read.run) : Optional.empty();
  }

  /** Validates an externally supplied snapshot with the same rules as a durable-store read. */
  public boolean runProjectionIsValid(Run run, String expectedId, String expectedOperationId) {
    try {
      if (run == null
          || expectedOperationId != null && !expectedOperationId.equals(run.operationId())) {
        return false;
      }
      var handler = operations.find(run.operationId()).orElse(null);
      return handler != null
          && RuntimeGuard.storedRunIsValid(
              run,
              expectedId,
              handler.definition(),
              operations,
              schemaValidator,
              fileReferenceValidator,
              clock.instant());
    } catch (RuntimeException exception) {
      return false;
    }
  }

  public RunCreationResult create(String operationId, CreateRunRequest request) {
    OperationHandler<JsonObject> handler = operations.find(operationId).orElse(null);
    if (handler == null) {
      return RunCreationResult.failure(
          problem("urn:gauntlet:problem:operation-not-found", "Operation not found", 404, null));
    }
    OperationDefinition definition = handler.definition();
    if (request == null) {
      return RunCreationResult.failure(validationProblem(List.of()));
    }
    if (!definition.revision().equals(request.operationRevision())) {
      return RunCreationResult.failure(
          problem(
              "urn:gauntlet:problem:stale-operation-revision",
              "Stale operation revision",
              409,
              null));
    }
    ValidationError acknowledgementError = confirmationError(operationId, definition, request);
    if (acknowledgementError != null) {
      return RunCreationResult.failure(validationProblem(List.of(acknowledgementError)));
    }

    InputHandlingGuard.SecretGuard secretGuard;
    try {
      secretGuard = InputHandlingGuard.secretGuard(definition, request.input());
    } catch (RuntimeException exception) {
      return RunCreationResult.failure(internalProblem(null));
    }

    List<ValidationError> requestErrors;
    try {
      requestErrors =
          secretGuard.sanitizeValidationErrors(validateRequest(handler, definition, request));
    } catch (RuntimeException exception) {
      return RunCreationResult.failure(
          internalProblem(safeCorrelationId(request, null, secretGuard)));
    }
    if (!requestErrors.isEmpty()) {
      return RunCreationResult.failure(validationProblem(requestErrors));
    }

    String rawKey = request.idempotencyKey();
    Idempotency policy = definition.execution().idempotency();
    if (policy == Idempotency.NONE && rawKey != null) {
      return RunCreationResult.failure(
          validationProblem(
              List.of(error("/idempotencyKey", "forbidden", "idempotency key is not allowed"))));
    }
    if (policy == Idempotency.REQUIRED && (rawKey == null || rawKey.isBlank())) {
      return RunCreationResult.failure(
          validationProblem(
              List.of(error("/idempotencyKey", "required", "idempotency key is required"))));
    }
    if (policy != Idempotency.NONE && rawKey != null && rawKey.isBlank()) {
      return RunCreationResult.failure(
          validationProblem(
              List.of(
                  error("/idempotencyKey", "idempotency", "idempotency key must not be blank"))));
    }
    String fingerprint =
        rawKey == null
            ? null
            : IdempotencyFingerprint.create(operationId, rawKey, fingerprintSecret);
    rawKey = null;

    if (closed.get()) {
      return RunCreationResult.failure(
          internalProblem(safeCorrelationId(request, null, secretGuard)));
    }
    return reserveAndSchedule(handler, definition, request, secretGuard, fingerprint);
  }

  private RunCreationResult reserveAndSchedule(
      OperationHandler<JsonObject> handler,
      OperationDefinition definition,
      CreateRunRequest request,
      InputHandlingGuard.SecretGuard secretGuard,
      String fingerprint) {
    while (!closed.get()) {
      StoreRead existing = findIdempotentRun(definition, fingerprint);
      if (existing.kind == StoreReadKind.INVALID) {
        return RunCreationResult.failure(
            internalProblem(safeCorrelationId(request, null, secretGuard)));
      }
      if (existing.kind == StoreReadKind.VALID) {
        return RunCreationResult.success(existing.run);
      }

      Run queued;
      ExecutionCoordinator.Reservation execution;
      try {
        queued = Run.queued(ids.get(), definition, clock.instant());
        execution =
            coordinator.reserve(definition.id(), queued.id(), definition.execution().concurrency());
      } catch (RuntimeException exception) {
        return RunCreationResult.failure(
            internalProblem(safeCorrelationId(request, null, secretGuard)));
      }

      if (!execution.admitted()) {
        try (execution) {
          if (fingerprint == null) {
            return RunCreationResult.failure(
                problem(
                    "urn:gauntlet:problem:operation-busy",
                    "Operation busy",
                    409,
                    safeCorrelationId(request, null, secretGuard)));
          }
          boolean conflictingRunWasPublished =
              execution.conflictResolution().toCompletableFuture().join();
          if (!conflictingRunWasPublished) continue;
          StoreRead winner = findIdempotentRun(definition, fingerprint);
          if (winner.kind == StoreReadKind.INVALID) {
            return RunCreationResult.failure(
                internalProblem(safeCorrelationId(request, null, secretGuard)));
          }
          if (winner.kind == StoreReadKind.VALID) {
            return RunCreationResult.success(winner.run);
          }
          return RunCreationResult.failure(
              problem(
                  "urn:gauntlet:problem:operation-busy",
                  "Operation busy",
                  409,
                  safeCorrelationId(request, null, secretGuard)));
        } catch (RuntimeException exception) {
          return RunCreationResult.failure(
              internalProblem(safeCorrelationId(request, null, secretGuard)));
        }
      }

      RunStoreCreateResult storeReservation;
      try {
        storeReservation = store.createQueued(queued, Optional.ofNullable(fingerprint));
      } catch (RuntimeException exception) {
        transitionTerminal(
            queued.id(),
            RunState.FAILED,
            internalProblem(safeCorrelationId(request, queued.id(), secretGuard)));
        closeReservationBestEffort(execution);
        return RunCreationResult.failure(
            internalProblem(safeCorrelationId(request, queued.id(), secretGuard)));
      }
      ReservationValidation validated =
          validateReservation(storeReservation, queued, fingerprint != null, definition);
      if (!validated.valid) {
        closeReservationBestEffort(execution);
        return RunCreationResult.failure(
            internalProblem(safeCorrelationId(request, queued.id(), secretGuard)));
      }
      if (validated.duplicate != null) {
        closeReservationBestEffort(execution);
        return RunCreationResult.success(validated.duplicate);
      }

      var control =
          new ExecutionControl(
              queued,
              handler,
              request.input(),
              request.dryRun(),
              secretGuard,
              safeCorrelationId(request, queued.id(), secretGuard),
              new InvocationContextLease(request.context()),
              execution);
      if (active.putIfAbsent(queued.id(), control) != null) {
        control.lease.close();
        transitionFailure(control, internalProblem(control.correlationId));
        closeReservationBestEffort(execution);
        return RunCreationResult.failure(internalProblem(control.correlationId));
      }
      if (closed.get()) {
        control.request(TerminalReason.SHUTDOWN);
        transitionFailure(control, internalProblem(control.correlationId));
        control.lifecycle.compareAndSet(ExecutionLifecycle.WAITING, ExecutionLifecycle.SETTLED);
        cleanup(control);
        return RunCreationResult.failure(internalProblem(control.correlationId));
      }
      try {
        execution.markPersisted();
        execution
            .turn()
            .whenComplete(
                (ignored, failure) -> {
                  if (failure == null) {
                    dispatch(control);
                  } else {
                    transitionFailure(control, internalProblem(control.correlationId));
                    cleanup(control);
                  }
                });
      } catch (Throwable failure) {
        transitionFailure(control, internalProblem(control.correlationId));
        cleanup(control);
        rethrowFatal(failure);
        return RunCreationResult.failure(internalProblem(control.correlationId));
      }
      return RunCreationResult.success(queued);
    }
    return RunCreationResult.failure(internalProblem(null));
  }

  private StoreRead findIdempotentRun(OperationDefinition definition, String fingerprint) {
    if (fingerprint == null) return StoreRead.missing();
    try {
      return readStoreValue(
          store.findByIdempotencyFingerprint(definition.id(), fingerprint),
          null,
          definition.id(),
          definition.revision());
    } catch (RuntimeException exception) {
      return StoreRead.invalid();
    }
  }

  public RunCancellationResult cancel(String runId) {
    try {
      ProtocolId.require(runId);
    } catch (RuntimeException exception) {
      return RunCancellationResult.failure(runNotFound());
    }

    StoreRead stored;
    try {
      stored = readStoreValue(store.get(runId), runId, null, null);
    } catch (RuntimeException exception) {
      return RunCancellationResult.failure(internalProblem(runId));
    }
    if (stored.kind == StoreReadKind.MISSING) {
      return RunCancellationResult.failure(runNotFound());
    }
    if (stored.kind == StoreReadKind.INVALID) {
      return RunCancellationResult.failure(internalProblem(runId));
    }
    OperationHandler<JsonObject> handler = operations.find(stored.run.operationId()).orElse(null);
    if (handler == null) {
      return RunCancellationResult.failure(internalProblem(runId));
    }
    if (!handler.definition().execution().cancellationSupported()) {
      return RunCancellationResult.failure(
          problem(
              "urn:gauntlet:problem:run-not-cancellable", "Run is not cancellable", 409, runId));
    }
    if (stored.run.state().terminal()) {
      return RunCancellationResult.success(stored.run);
    }

    try {
      coordinator.requestCancellation(stored.run.operationId(), runId);
    } catch (RuntimeException exception) {
      return RunCancellationResult.failure(internalProblem(runId));
    }
    ExecutionControl control = active.get(runId);
    if (control != null) control.request(TerminalReason.CANCELLED);
    Run terminal =
        transitionTerminal(
            runId,
            RunState.CANCELLED,
            problem("urn:gauntlet:problem:run-cancelled", "Run cancelled", 409, runId));
    return terminal == null
        ? RunCancellationResult.failure(internalProblem(runId))
        : RunCancellationResult.success(terminal);
  }

  private void dispatch(ExecutionControl control) {
    boolean cancellationRequested;
    try {
      cancellationRequested = control.cancellationRequested();
    } catch (Throwable failure) {
      control.lifecycle.compareAndSet(ExecutionLifecycle.WAITING, ExecutionLifecycle.SETTLED);
      transitionFailure(control, internalProblem(control.correlationId));
      cleanup(control);
      rethrowFatal(failure);
      return;
    }
    if (cancellationRequested) {
      transitionCancelled(control);
      cleanup(control);
      return;
    }
    if (closed.get()) {
      transitionFailure(control, internalProblem(control.correlationId));
      cleanup(control);
      return;
    }
    if (!control.lifecycle.compareAndSet(
        ExecutionLifecycle.WAITING, ExecutionLifecycle.DISPATCHED)) {
      return;
    }
    try {
      Future<?> future = workers.submit(() -> execute(control));
      control.installFuture(future);
    } catch (RejectedExecutionException exception) {
      control.lifecycle.set(ExecutionLifecycle.SETTLED);
      transitionFailure(control, handlerFailed(control.correlationId));
      cleanup(control);
    }
  }

  private void execute(ExecutionControl control) {
    if (!control.lifecycle.compareAndSet(
        ExecutionLifecycle.DISPATCHED, ExecutionLifecycle.RUNNING)) {
      cleanup(control);
      return;
    }
    ScheduledFuture<?> timeout = null;
    DefaultRunContext context = null;
    try {
      Run running = transitionRunning(control);
      if (running == null) return;
      context =
          new DefaultRunContext(
              running.id(),
              running.operationId(),
              control.dryRun,
              control.lease,
              control::cancellationRequested);
      control.context.set(context);
      if (control.cancellationRequested()) {
        transitionRequestedTerminal(control);
        return;
      }

      Integer timeoutSeconds = control.handler.definition().execution().timeoutSeconds();
      if (timeoutSeconds != null) {
        timeout =
            timer.schedule(
                () -> {
                  control.request(TerminalReason.TIMED_OUT);
                  transitionTimedOut(control);
                },
                timeoutSeconds,
                TimeUnit.SECONDS);
        control.timeout.set(timeout);
      }

      OperationResult produced;
      try {
        produced =
            Objects.requireNonNull(
                control.handler.execute(control.input, context), "operation result");
      } finally {
        if (timeout != null) timeout.cancel(false);
        context.close();
        control.lease.close();
      }
      if (control.cancellationProbeFailed()) {
        transitionFailure(control, internalProblem(control.correlationId));
        return;
      }
      if (control.cancellationRequested()) {
        transitionRequestedTerminal(control);
        return;
      }

      produced = mergeContext(produced, context);
      RunProgress finalProgress = context.progressAt(clock.instant().toString());
      assertProduced(control.handler.definition(), produced, control.secretGuard, finalProgress);
      transitionSucceeded(control, produced, finalProgress);
    } catch (Throwable failure) {
      if (control.cancellationProbeFailed()) {
        transitionFailure(control, internalProblem(control.correlationId));
      } else if (control.cancellationKnown()) {
        transitionRequestedTerminal(control);
      } else {
        transitionFailure(control, handlerFailed(control.correlationId));
      }
      rethrowFatal(failure);
    } finally {
      if (timeout != null) timeout.cancel(false);
      if (context != null) context.close();
      control.lease.close();
      control.lifecycle.set(ExecutionLifecycle.SETTLED);
      cleanup(control);
    }
  }

  private Run transitionRunning(ExecutionControl control) {
    try {
      StoreRead current =
          readStoreValue(
              store.get(control.queued.id()),
              control.queued.id(),
              control.queued.operationId(),
              control.queued.operationRevision());
      if (current.kind != StoreReadKind.VALID || current.run.state() != RunState.QUEUED) {
        return null;
      }
      Run running = current.run.running(clock.instant());
      if (store.updateExactSequence(running, current.run.sequence())) return running;
      transitionFailure(control, internalProblem(control.correlationId));
      return null;
    } catch (RuntimeException exception) {
      transitionFailure(control, internalProblem(control.correlationId));
      return null;
    }
  }

  private void transitionSucceeded(
      ExecutionControl control, OperationResult result, RunProgress finalProgress) {
    try {
      StoreRead current =
          readStoreValue(
              store.get(control.queued.id()),
              control.queued.id(),
              control.queued.operationId(),
              control.queued.operationRevision());
      if (current.kind != StoreReadKind.VALID || current.run.state() != RunState.RUNNING) return;
      Run terminal = current.run.terminal(result, finalProgress, clock.instant());
      if (!store.updateExactSequence(terminal, current.run.sequence())) {
        transitionFailure(control, internalProblem(control.correlationId));
      }
    } catch (RuntimeException exception) {
      transitionFailure(control, internalProblem(control.correlationId));
    }
  }

  private Run transitionFailure(ExecutionControl control, Problem failure) {
    return transitionTerminal(control.queued.id(), RunState.FAILED, failure);
  }

  private Run transitionCancelled(ExecutionControl control) {
    return transitionTerminal(
        control.queued.id(),
        RunState.CANCELLED,
        problem("urn:gauntlet:problem:run-cancelled", "Run cancelled", 409, control.correlationId));
  }

  private Run transitionTimedOut(ExecutionControl control) {
    return transitionTerminal(
        control.queued.id(),
        RunState.TIMED_OUT,
        problem("urn:gauntlet:problem:run-timed-out", "Run timed out", 504, control.correlationId));
  }

  private void transitionRequestedTerminal(ExecutionControl control) {
    if (control.reason.get() == TerminalReason.TIMED_OUT) {
      transitionTimedOut(control);
    } else if (control.reason.get() == TerminalReason.SHUTDOWN) {
      transitionFailure(control, internalProblem(control.correlationId));
    } else {
      transitionCancelled(control);
    }
  }

  private Run transitionTerminal(String runId, RunState state, Problem failure) {
    for (int attempt = 0; attempt < 16; attempt++) {
      StoreRead current;
      try {
        current = readStoreValue(store.get(runId), runId, null, null);
      } catch (RuntimeException exception) {
        return null;
      }
      if (current.kind != StoreReadKind.VALID) return null;
      if (current.run.state().terminal()) return current.run;
      Run terminal;
      try {
        terminal = current.run.terminated(state, failure, monotonicNow(current.run));
        if (store.updateExactSequence(terminal, current.run.sequence())) return terminal;
      } catch (RuntimeException exception) {
        return null;
      }
    }
    try {
      StoreRead current = readStoreValue(store.get(runId), runId, null, null);
      return current.kind == StoreReadKind.VALID && current.run.state().terminal()
          ? current.run
          : null;
    } catch (RuntimeException exception) {
      return null;
    }
  }

  private Instant monotonicNow(Run current) {
    Instant candidate = clock.instant();
    Instant floor = OffsetDateTime.parse(current.updatedAt()).toInstant();
    return candidate.isBefore(floor) ? floor : candidate;
  }

  private static void closeReservationBestEffort(ExecutionCoordinator.Reservation reservation) {
    try {
      reservation.close();
    } catch (Throwable ignored) {
      // A coordinator cleanup failure must not replace the authoritative create outcome.
    }
  }

  private void cleanup(ExecutionControl control) {
    if (!control.cleaned.compareAndSet(false, true)) return;
    ScheduledFuture<?> timeout = control.timeout.getAndSet(null);
    if (timeout != null) timeout.cancel(false);
    DefaultRunContext context = control.context.get();
    if (context != null) context.close();
    control.lease.close();
    try {
      control.execution.close();
    } catch (Throwable failure) {
      transitionFailure(control, internalProblem(control.correlationId));
      rethrowFatal(failure);
    } finally {
      active.remove(control.queued.id(), control);
    }
  }

  @Override
  public void close() {
    if (!closed.compareAndSet(false, true)) return;
    for (ExecutionControl control : List.copyOf(active.values())) {
      control.request(TerminalReason.SHUTDOWN);
      transitionFailure(control, internalProblem(control.correlationId));
      if (control.lifecycle.compareAndSet(ExecutionLifecycle.WAITING, ExecutionLifecycle.SETTLED)
          || control.lifecycle.compareAndSet(
              ExecutionLifecycle.DISPATCHED, ExecutionLifecycle.SETTLED)) {
        cleanup(control);
      }
    }
    if (ownsExecutors) {
      timer.shutdownNow();
      workers.shutdownNow();
    }
  }

  private static ExecutorService defaultWorkers() {
    return Executors.newThreadPerTaskExecutor(
        Thread.ofVirtual().name("gauntlet-run-", 0).factory());
  }

  private static ScheduledExecutorService defaultTimer() {
    return Executors.newSingleThreadScheduledExecutor(
        task -> Thread.ofPlatform().daemon(true).name("gauntlet-timeout").unstarted(task));
  }

  @SuppressWarnings("removal")
  private static void rethrowFatal(Throwable failure) {
    if (failure instanceof VirtualMachineError fatal) throw fatal;
    if (failure instanceof ThreadDeath fatal) throw fatal;
  }

  private ReservationValidation validateReservation(
      RunStoreCreateResult reservation,
      Run queued,
      boolean hasFingerprint,
      OperationDefinition definition) {
    if (reservation == null || reservation.run() == null) {
      return ReservationValidation.invalid();
    }
    StoreRead snapshot =
        readStoreValue(
            Optional.of(reservation.run()),
            reservation.created() ? queued.id() : null,
            definition.id(),
            definition.revision());
    if (snapshot.kind != StoreReadKind.VALID) {
      return ReservationValidation.invalid();
    }
    if (reservation.created()) {
      return snapshot.run.equals(queued)
          ? ReservationValidation.created()
          : ReservationValidation.invalid();
    }
    if (!hasFingerprint) {
      return ReservationValidation.invalid();
    }
    try {
      StoreRead authoritative =
          readStoreValue(
              store.get(snapshot.run.id()),
              snapshot.run.id(),
              definition.id(),
              definition.revision());
      return authoritative.kind == StoreReadKind.VALID
          ? ReservationValidation.duplicate(authoritative.run)
          : ReservationValidation.invalid();
    } catch (RuntimeException exception) {
      return ReservationValidation.invalid();
    }
  }

  private List<ValidationError> validateRequest(
      OperationHandler<JsonObject> handler,
      OperationDefinition definition,
      CreateRunRequest request) {
    var errors = new ArrayList<ValidationError>();
    if (request.dryRun() && !definition.execution().dryRunSupported()) {
      errors.add(error("/dryRun", "unsupported", "dry run is not supported"));
    }
    errors.addAll(
        Objects.requireNonNull(
            schemaValidator.validate(definition.inputSchema(), request.input()),
            "input validation errors"));
    if (definition.contextSchema() != null) {
      JsonObject context =
          request.context() == null
              ? JsonOwnership.object(Map.of())
              : request.context().toProtocolMap();
      errors.addAll(
          Objects.requireNonNull(
              schemaValidator.validate(definition.contextSchema(), context),
              "context validation errors"));
    }
    errors.addAll(
        InputHandlingGuard.validateFiles(
            definition, request.input(), fileReferenceValidator, clock.instant()));
    if (errors.isEmpty()) {
      errors.addAll(
          Objects.requireNonNull(handler.validateInput(request.input()), "input binding errors"));
    }
    return List.copyOf(errors);
  }

  private static ValidationError confirmationError(
      String operationId, OperationDefinition definition, CreateRunRequest request) {
    if (!definition.execution().confirmationRequired()) return null;
    if (request.confirmation() == null) {
      return error("/confirmation", "required", "confirmation acknowledgement is required");
    }
    if (!operationId.equals(request.confirmation().operationId())) {
      return error("/confirmation/operationId", "const", "confirmation operation does not match");
    }
    if (!definition.revision().equals(request.confirmation().operationRevision())) {
      return error(
          "/confirmation/operationRevision", "const", "confirmation revision does not match");
    }
    if (definition.execution().impact() != request.confirmation().impact()) {
      return error("/confirmation/impact", "const", "confirmation impact does not match");
    }
    return null;
  }

  private void assertProduced(
      OperationDefinition definition,
      OperationResult result,
      InputHandlingGuard.SecretGuard guard,
      RunProgress progress) {
    if (result.output() != null) {
      CanonicalJson.encode(result.output());
      List<ValidationError> outputErrors =
          Objects.requireNonNull(
              schemaValidator.validate(definition.output().schema(), result.output()),
              "output validation errors");
      if (!outputErrors.isEmpty()) {
        throw new IllegalArgumentException("operation output violates its schema");
      }
      assertSafe(result.output(), guard, "operation output contains a protected input");
    }
    if (progress != null) {
      assertSafe(progress.toProtocolMap(), guard, "run progress contains a protected input");
    }
    if (result.summary() != null) {
      assertSafeSummary(result.summary(), guard);
    }
    if (result.problem() != null) {
      assertSafeProblem(result.problem(), guard);
    }
    assertSafe(result.extensions(), guard, "result extensions contain a protected input");

    var artifactsById = new HashMap<String, Artifact>();
    for (Artifact artifact : result.artifacts()) {
      CanonicalJson.encode(artifact.toProtocolMap());
      if (artifactsById.putIfAbsent(artifact.id(), artifact) != null) {
        throw new IllegalArgumentException("duplicate artifact ID");
      }
      assertSafeArtifact(artifact, guard);
    }
    for (FollowUpAction action : result.actions()) {
      CanonicalJson.encode(action.toProtocolMap());
      assertSafeAction(action, guard);
      if ("browser-launch".equals(action.kind())) {
        Artifact target = artifactsById.get(action.artifactId());
        if (target == null || !"browser-launch".equals(target.kind())) {
          throw new IllegalArgumentException(
              "browser action must reference a browser-launch artifact from the run");
        }
      }
      if ("invoke-operation".equals(action.kind())) {
        var target =
            operations
                .find(action.operationId())
                .orElseThrow(() -> new IllegalArgumentException("follow-up operation is unknown"));
        JsonObject actionInput =
            action.input() == null ? JsonOwnership.object(Map.of()) : action.input();
        List<ValidationError> targetErrors =
            Objects.requireNonNull(
                schemaValidator.validate(target.definition().inputSchema(), actionInput),
                "target validation errors");
        if (!targetErrors.isEmpty()) {
          throw new IllegalArgumentException(
              "follow-up input violates the target operation schema");
        }
        if (!InputHandlingGuard.secretGuard(target.definition(), actionInput).isEmpty()) {
          throw new IllegalArgumentException("follow-up input contains target-operation secrets");
        }
        if (!InputHandlingGuard.validateFiles(
                target.definition(), actionInput, fileReferenceValidator, clock.instant())
            .isEmpty()) {
          throw new IllegalArgumentException("follow-up input contains invalid file references");
        }
      }
    }
  }

  private static void assertSafeSummary(RunSummary summary, InputHandlingGuard.SecretGuard guard) {
    JsonObject value = summary.toProtocolMap();
    assertSafe(value.get("title"), guard, "summary contains a protected input");
    assertSafe(value.get("message"), guard, "summary contains a protected input");
    assertSafe(value.get("extensions"), guard, "summary contains a protected input");
  }

  private static void assertSafeProblem(Problem problem, InputHandlingGuard.SecretGuard guard) {
    JsonObject value = problem.toProtocolMap();
    if (!CORE_PROBLEM_TYPES.contains(problem.type()) && guard.containsString(problem.type())) {
      throw new IllegalArgumentException("problem type contains a protected input");
    }
    for (Map.Entry<String, JsonValue> entry : value.values().entrySet()) {
      if ("status".equals(entry.getKey()) || "type".equals(entry.getKey())) {
        continue;
      }
      assertSafe(entry.getValue(), guard, "problem contains a protected input");
    }
  }

  private static void assertSafeArtifact(Artifact artifact, InputHandlingGuard.SecretGuard guard) {
    if (!CORE_ARTIFACT_KINDS.contains(artifact.kind()) && guard.containsString(artifact.kind())) {
      throw new IllegalArgumentException("artifact kind contains a protected input");
    }
    if (guard.containsString(artifact.id()) || guard.containsString(artifact.title())) {
      throw new IllegalArgumentException("artifact envelope contains a protected input");
    }
    for (Map.Entry<String, JsonValue> entry : artifact.payload().values().entrySet()) {
      if (("notice".equals(artifact.kind()) && "level".equals(entry.getKey()))
          || ("diff".equals(artifact.kind()) && "format".equals(entry.getKey()))) {
        continue;
      }
      if ("log".equals(artifact.kind()) && "entries".equals(entry.getKey())) {
        assertSafeLogEntries(entry.getValue(), guard);
      } else {
        assertSafe(entry.getValue(), guard, "artifact contains a protected input");
      }
    }
    assertSafe(artifact.extensions(), guard, "artifact extensions contain a protected input");
  }

  private static void assertSafeLogEntries(JsonValue value, InputHandlingGuard.SecretGuard guard) {
    if (!(value instanceof JsonList entries)) {
      throw new IllegalArgumentException("log entries must be an array");
    }
    for (JsonValue entryValue : entries.values()) {
      if (!(entryValue instanceof JsonObject entry)) {
        throw new IllegalArgumentException("log entry must be an object");
      }
      for (Map.Entry<String, JsonValue> field : entry.values().entrySet()) {
        if (!"level".equals(field.getKey())) {
          assertSafe(field.getValue(), guard, "log entry contains a protected input");
        }
      }
    }
  }

  private static void assertSafeAction(
      FollowUpAction action, InputHandlingGuard.SecretGuard guard) {
    for (Map.Entry<String, JsonValue> entry : action.toProtocolMap().values().entrySet()) {
      if (!"kind".equals(entry.getKey())) {
        assertSafe(entry.getValue(), guard, "follow-up action contains a protected input");
      }
    }
  }

  private static void assertSafe(
      JsonValue value, InputHandlingGuard.SecretGuard guard, String message) {
    if (guard.contains(value)) {
      throw new IllegalArgumentException(message);
    }
  }

  private static OperationResult mergeContext(OperationResult result, DefaultRunContext context) {
    var artifacts = new ArrayList<>(context.artifactsSnapshot());
    artifacts.addAll(result.artifacts());
    var actions = new ArrayList<>(context.actionsSnapshot());
    actions.addAll(result.actions());
    return result.outcome() == RunState.PARTIAL
        ? OperationResult.partial(
            result.summary(), result.output(), artifacts, actions, result.problem())
        : OperationResult.succeeded(result.summary(), result.output(), artifacts, actions);
  }

  private StoreRead readStoreValue(
      Optional<Run> stored,
      String expectedId,
      String expectedOperationId,
      String expectedRevision) {
    if (stored == null) {
      return StoreRead.invalid();
    }
    if (stored.isEmpty()) {
      return StoreRead.missing();
    }
    Run run = stored.orElseThrow();
    if (expectedRevision != null && !expectedRevision.equals(run.operationRevision())
        || !runProjectionIsValid(run, expectedId, expectedOperationId)) {
      return StoreRead.invalid();
    }
    return StoreRead.valid(run);
  }

  private static String correlationId(CreateRunRequest request, String fallback) {
    return request.context() == null ? fallback : request.context().requestId();
  }

  private static String safeCorrelationId(
      CreateRunRequest request, String fallback, InputHandlingGuard.SecretGuard guard) {
    String candidate = correlationId(request, fallback);
    return guard.containsString(candidate) ? fallback : candidate;
  }

  private static Problem validationProblem(List<ValidationError> errors) {
    return new Problem(
        "urn:gauntlet:problem:validation-failed",
        "Validation failed",
        422,
        null,
        null,
        null,
        errors,
        null,
        JsonOwnership.object(Map.of()));
  }

  private static Problem internalProblem(String correlationId) {
    return problem(
        "urn:gauntlet:problem:adapter-internal-error",
        "Adapter internal error",
        500,
        correlationId);
  }

  private static Problem handlerFailed(String correlationId) {
    return problem("urn:gauntlet:problem:handler-failed", "Operation failed", 500, correlationId);
  }

  private static Problem runNotFound() {
    return problem("urn:gauntlet:problem:run-not-found", "Run not found", 404, null);
  }

  private static Problem problem(String type, String title, int status, String correlationId) {
    return new Problem(
        type,
        title,
        status,
        null,
        null,
        correlationId,
        List.of(),
        null,
        JsonOwnership.object(Map.of()));
  }

  private static ValidationError error(String path, String keyword, String message) {
    return new ValidationError(path, "#", keyword, message, JsonOwnership.object(Map.of()));
  }

  private enum TerminalReason {
    NONE,
    CANCELLED,
    TIMED_OUT,
    SHUTDOWN
  }

  private enum ExecutionLifecycle {
    WAITING,
    DISPATCHED,
    RUNNING,
    SETTLED
  }

  private static final class ExecutionControl {
    private final Run queued;
    private final OperationHandler<JsonObject> handler;
    private final JsonObject input;
    private final boolean dryRun;
    private final InputHandlingGuard.SecretGuard secretGuard;
    private final String correlationId;
    private final InvocationContextLease lease;
    private final ExecutionCoordinator.Reservation execution;
    private final AtomicReference<TerminalReason> reason =
        new AtomicReference<>(TerminalReason.NONE);
    private final AtomicReference<ExecutionLifecycle> lifecycle =
        new AtomicReference<>(ExecutionLifecycle.WAITING);
    private final AtomicReference<Future<?>> future = new AtomicReference<>();
    private final AtomicReference<ScheduledFuture<?>> timeout = new AtomicReference<>();
    private final AtomicReference<DefaultRunContext> context = new AtomicReference<>();
    private final AtomicReference<Throwable> cancellationProbeFailure = new AtomicReference<>();
    private final AtomicBoolean cancellationObserved = new AtomicBoolean();
    private final AtomicBoolean cleaned = new AtomicBoolean();

    private ExecutionControl(
        Run queued,
        OperationHandler<JsonObject> handler,
        JsonObject input,
        boolean dryRun,
        InputHandlingGuard.SecretGuard secretGuard,
        String correlationId,
        InvocationContextLease lease,
        ExecutionCoordinator.Reservation execution) {
      this.queued = queued;
      this.handler = handler;
      this.input = input;
      this.dryRun = dryRun;
      this.secretGuard = secretGuard;
      this.correlationId = correlationId;
      this.lease = lease;
      this.execution = execution;
    }

    private boolean cancellationRequested() {
      if (reason.get() != TerminalReason.NONE) return true;
      try {
        boolean requested = execution.cancellationRequested();
        if (requested) cancellationObserved.set(true);
        return requested;
      } catch (Throwable failure) {
        cancellationProbeFailure.compareAndSet(null, failure);
        if (failure instanceof RuntimeException runtime) throw runtime;
        if (failure instanceof Error error) throw error;
        throw new IllegalStateException("execution coordinator failed", failure);
      }
    }

    private boolean cancellationKnown() {
      return reason.get() != TerminalReason.NONE || cancellationObserved.get();
    }

    private boolean cancellationProbeFailed() {
      return cancellationProbeFailure.get() != null;
    }

    private void request(TerminalReason requested) {
      if (!reason.compareAndSet(TerminalReason.NONE, requested)) return;
      DefaultRunContext currentContext = context.get();
      if (currentContext != null) currentContext.close();
      lease.close();
      Future<?> currentFuture = future.get();
      if (currentFuture != null) currentFuture.cancel(true);
    }

    private void installFuture(Future<?> submitted) {
      if (!future.compareAndSet(null, submitted)) {
        submitted.cancel(true);
        throw new IllegalStateException("execution future already installed");
      }
      if (reason.get() != TerminalReason.NONE) submitted.cancel(true);
    }
  }

  private enum StoreReadKind {
    MISSING,
    INVALID,
    VALID
  }

  private record StoreRead(StoreReadKind kind, Run run) {
    private static StoreRead missing() {
      return new StoreRead(StoreReadKind.MISSING, null);
    }

    private static StoreRead invalid() {
      return new StoreRead(StoreReadKind.INVALID, null);
    }

    private static StoreRead valid(Run run) {
      return new StoreRead(StoreReadKind.VALID, run);
    }
  }

  private record ReservationValidation(boolean valid, Run duplicate) {
    private static ReservationValidation invalid() {
      return new ReservationValidation(false, null);
    }

    private static ReservationValidation created() {
      return new ReservationValidation(true, null);
    }

    private static ReservationValidation duplicate(Run run) {
      return new ReservationValidation(true, run);
    }
  }

  private static final class DefaultRunContext implements RunContext {
    private final String runId;
    private final String operationId;
    private final boolean dryRun;
    private final InvocationContextLease lease;
    private final BooleanSupplier cancellationRequested;
    private final List<Artifact> artifacts = new ArrayList<>();
    private final List<FollowUpAction> actions = new ArrayList<>();
    private RunProgress progress;
    private boolean open = true;

    private DefaultRunContext(
        String runId,
        String operationId,
        boolean dryRun,
        InvocationContextLease lease,
        BooleanSupplier cancellationRequested) {
      this.runId = runId;
      this.operationId = operationId;
      this.dryRun = dryRun;
      this.lease = lease;
      this.cancellationRequested = cancellationRequested;
    }

    @Override
    public String runId() {
      return runId;
    }

    @Override
    public String operationId() {
      return operationId;
    }

    @Override
    public boolean isDryRun() {
      return dryRun;
    }

    @Override
    public Optional<dev.eightlines.gauntlet.core.model.InvocationContext> invocationContext() {
      return lease.get();
    }

    @Override
    public synchronized void report(RunProgress progress) {
      if (!open) {
        return;
      }
      this.progress = Objects.requireNonNull(progress, "progress");
    }

    private synchronized RunProgress progressAt(String timestamp) {
      if (progress == null) {
        return null;
      }
      return new RunProgress(
          progress.current(),
          progress.total(),
          progress.phase(),
          progress.message(),
          timestamp,
          progress.extensions());
    }

    @Override
    public synchronized void addArtifact(Artifact artifact) {
      if (!open) {
        return;
      }
      artifacts.add(Objects.requireNonNull(artifact, "artifact"));
    }

    @Override
    public synchronized void addAction(FollowUpAction action) {
      if (!open) {
        return;
      }
      actions.add(Objects.requireNonNull(action, "action"));
    }

    @Override
    public synchronized void log(String level, String message, JsonObject fields) {
      if (!open) {
        return;
      }
      if (!Set.of("debug", "info", "warning", "error").contains(level)) {
        throw new IllegalArgumentException("unsupported log level");
      }
      var data =
          JsonOwnership.object(
              Map.of(
                  "level",
                  level,
                  "message",
                  Objects.requireNonNull(message, "message"),
                  "fields",
                  fields == null ? JsonOwnership.object(Map.of()) : fields));
      artifacts.add(
          new Artifact(
              "log-" + (artifacts.size() + 1),
              "urn:gauntlet:artifact:structured-log",
              null,
              JsonOwnership.object(Map.of("data", data)),
              JsonOwnership.object(Map.of())));
    }

    @Override
    public synchronized void warn(String message) {
      if (!open) {
        return;
      }
      artifacts.add(
          new Artifact(
              "notice-" + (artifacts.size() + 1),
              "notice",
              null,
              JsonOwnership.object(
                  Map.of(
                      "level", "warning", "message", Objects.requireNonNull(message, "message"))),
              JsonOwnership.object(Map.of())));
    }

    @Override
    public boolean isCancellationRequested() {
      return cancellationRequested.getAsBoolean();
    }

    @Override
    public void throwIfCancelled() {
      if (isCancellationRequested()) {
        throw new CancellationException("run cancelled");
      }
    }

    private synchronized List<Artifact> artifactsSnapshot() {
      return List.copyOf(artifacts);
    }

    private synchronized List<FollowUpAction> actionsSnapshot() {
      return List.copyOf(actions);
    }

    private synchronized void close() {
      open = false;
    }
  }
}
