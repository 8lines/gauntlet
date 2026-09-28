package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.Artifact;
import dev.eightlines.gauntlet.core.model.ConfirmationAcknowledgement;
import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.FeatureDefinition;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.OperationOutput;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunCreationResult;
import dev.eightlines.gauntlet.core.model.RunProgress;
import dev.eightlines.gauntlet.core.model.RunState;
import dev.eightlines.gauntlet.core.model.ValidationError;
import dev.eightlines.gauntlet.core.registry.FeatureRegistry;
import dev.eightlines.gauntlet.core.registry.OperationRegistry;
import dev.eightlines.gauntlet.core.run.InMemoryExecutionCoordinator;
import dev.eightlines.gauntlet.core.run.InMemoryRunStore;
import dev.eightlines.gauntlet.core.run.RunManager;
import dev.eightlines.gauntlet.core.schema.NetworkntSchemaValidator;
import dev.eightlines.gauntlet.core.schema.SchemaValidator;
import dev.eightlines.gauntlet.core.spi.ExecutionCoordinator;
import dev.eightlines.gauntlet.core.spi.OperationHandler;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.core.spi.RunStoreCreateResult;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;

class RunManagerExecutionPolicyTest {
  private static final Clock CLOCK =
      Clock.fixed(Instant.parse("2026-08-30T12:00:00Z"), ZoneOffset.UTC);

  @Test
  void confirmationPrecedesValidationIdempotencyAndAdmissionSideEffects() {
    var policy =
        new ExecutionPolicy(
            OperationImpact.WRITE,
            true,
            false,
            Idempotency.REQUIRED,
            false,
            null,
            "allow",
            CoreTestFixtures.EMPTY);
    var definition = definition(policy);
    var schemaCalls = new AtomicInteger();
    var coordinatorCalls = new AtomicInteger();
    var storeCalls = new AtomicInteger();
    var scheduleCalls = new AtomicInteger();
    var handlerCalls = new AtomicInteger();
    var idCalls = new AtomicInteger();
    var delegateStore = new InMemoryRunStore();
    RunStore store =
        new RunStore() {
          @Override
          public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
            storeCalls.incrementAndGet();
            return delegateStore.createQueued(run, fingerprint);
          }

          @Override
          public Optional<Run> get(String runId) {
            storeCalls.incrementAndGet();
            return delegateStore.get(runId);
          }

          @Override
          public Optional<Run> findByIdempotencyFingerprint(
              String operationId, String fingerprint) {
            storeCalls.incrementAndGet();
            return delegateStore.findByIdempotencyFingerprint(operationId, fingerprint);
          }

          @Override
          public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
            storeCalls.incrementAndGet();
            return delegateStore.updateExactSequence(run, expectedPreviousSequence);
          }
        };
    SchemaValidator validator =
        (schema, instance) -> {
          schemaCalls.incrementAndGet();
          return List.of(
              new ValidationError(
                  "/requiredValue",
                  "#/required/requiredValue",
                  "required",
                  "required value is missing",
                  CoreTestFixtures.EMPTY));
        };
    var delegateCoordinator = new InMemoryExecutionCoordinator();
    ExecutionCoordinator coordinator =
        new ExecutionCoordinator() {
          @Override
          public Reservation reserve(String operationId, String runId, String concurrency) {
            coordinatorCalls.incrementAndGet();
            return delegateCoordinator.reserve(operationId, runId, concurrency);
          }

          @Override
          public boolean requestCancellation(String operationId, String runId) {
            coordinatorCalls.incrementAndGet();
            return delegateCoordinator.requestCancellation(operationId, runId);
          }
        };
    var features = new FeatureRegistry();
    features.register(
        new FeatureDefinition("applications", "Applications", null, 0, CoreTestFixtures.EMPTY));
    var operations = new OperationRegistry(features);
    operations.register(
        new OperationHandler<JsonObject>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public OperationResult execute(JsonObject input, RunContext context) {
            handlerCalls.incrementAndGet();
            return OperationResult.succeeded(CoreTestFixtures.EMPTY);
          }
        });
    var current =
        new ConfirmationAcknowledgement(
            definition.id(),
            definition.revision(),
            definition.execution().impact(),
            CoreTestFixtures.EMPTY);
    record InvalidConfirmation(
        String name,
        ConfirmationAcknowledgement acknowledgement,
        String pointer,
        String keyword,
        String message) {}
    var invalidConfirmations =
        List.of(
            new InvalidConfirmation(
                "missing",
                null,
                "/confirmation",
                "required",
                "confirmation acknowledgement is required"),
            new InvalidConfirmation(
                "operation",
                new ConfirmationAcknowledgement(
                    "applications.other",
                    current.operationRevision(),
                    current.impact(),
                    CoreTestFixtures.EMPTY),
                "/confirmation/operationId",
                "const",
                "confirmation operation does not match"),
            new InvalidConfirmation(
                "revision",
                new ConfirmationAcknowledgement(
                    current.operationId(),
                    "sha256:" + "f".repeat(64),
                    current.impact(),
                    CoreTestFixtures.EMPTY),
                "/confirmation/operationRevision",
                "const",
                "confirmation revision does not match"),
            new InvalidConfirmation(
                "impact",
                new ConfirmationAcknowledgement(
                    current.operationId(),
                    current.operationRevision(),
                    OperationImpact.READ,
                    CoreTestFixtures.EMPTY),
                "/confirmation/impact",
                "const",
                "confirmation impact does not match"));

    try (var workers =
            Executors.newThreadPerTaskExecutor(
                task -> {
                  scheduleCalls.incrementAndGet();
                  return Thread.ofVirtual().unstarted(task);
                });
        var timer = Executors.newSingleThreadScheduledExecutor();
        var manager =
            new RunManager(
                operations,
                store,
                validator,
                null,
                CoreTestFixtures.SECRET,
                CLOCK,
                () -> "run-" + idCalls.incrementAndGet(),
                coordinator,
                workers,
                timer)) {
      for (var invalid : invalidConfirmations) {
        var result =
            manager.create(
                definition.id(),
                new CreateRunRequest(
                    definition.revision(),
                    CoreTestFixtures.EMPTY,
                    null,
                    true,
                    null,
                    invalid.acknowledgement(),
                    CoreTestFixtures.EMPTY));

        assertFalse(result.isSuccess(), invalid.name());
        assertEquals(422, result.problem().status(), invalid.name());
        assertEquals(1, result.problem().errors().size(), invalid.name());
        var error = result.problem().errors().getFirst();
        assertEquals(invalid.pointer(), error.instancePath(), invalid.name());
        assertEquals(invalid.keyword(), error.keyword(), invalid.name());
        assertEquals(invalid.message(), error.message(), invalid.name());
        assertEquals(0, schemaCalls.get(), invalid.name());
        assertEquals(0, coordinatorCalls.get(), invalid.name());
        assertEquals(0, storeCalls.get(), invalid.name());
        assertEquals(0, scheduleCalls.get(), invalid.name());
        assertEquals(0, handlerCalls.get(), invalid.name());
        assertEquals(0, idCalls.get(), invalid.name());
      }

      var stale =
          manager.create(
              definition.id(),
              new CreateRunRequest(
                  "sha256:" + "e".repeat(64),
                  CoreTestFixtures.EMPTY,
                  null,
                  true,
                  null,
                  null,
                  CoreTestFixtures.EMPTY));

      assertFalse(stale.isSuccess());
      assertEquals(409, stale.problem().status());
      assertEquals("urn:gauntlet:problem:stale-operation-revision", stale.problem().type());
      assertEquals(0, schemaCalls.get());
      assertEquals(0, coordinatorCalls.get());
      assertEquals(0, storeCalls.get());
      assertEquals(0, scheduleCalls.get());
      assertEquals(0, handlerCalls.get());
      assertEquals(0, idCalls.get());
    }
  }

  @Test
  void missingConfirmationCannotReplayAnAcceptedIdempotentRun() {
    var policy =
        new ExecutionPolicy(
            OperationImpact.WRITE,
            true,
            false,
            Idempotency.REQUIRED,
            false,
            null,
            "allow",
            CoreTestFixtures.EMPTY);
    var definition = definition(policy);
    var features = new FeatureRegistry();
    features.register(
        new FeatureDefinition("applications", "Applications", null, 0, CoreTestFixtures.EMPTY));
    var operations = new OperationRegistry(features);
    var handlerCalls = new AtomicInteger();
    operations.register(
        new OperationHandler<JsonObject>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public OperationResult execute(JsonObject input, RunContext context) {
            handlerCalls.incrementAndGet();
            return OperationResult.succeeded(CoreTestFixtures.EMPTY);
          }
        });
    var delegate = new InMemoryRunStore();
    var replayCalls = new AtomicInteger();
    RunStore store =
        new RunStore() {
          @Override
          public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
            return delegate.createQueued(run, fingerprint);
          }

          @Override
          public Optional<Run> get(String runId) {
            return delegate.get(runId);
          }

          @Override
          public Optional<Run> findByIdempotencyFingerprint(
              String operationId, String fingerprint) {
            replayCalls.incrementAndGet();
            return delegate.findByIdempotencyFingerprint(operationId, fingerprint);
          }

          @Override
          public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
            return delegate.updateExactSequence(run, expectedPreviousSequence);
          }
        };
    var ids = new AtomicInteger();
    try (var manager =
        new RunManager(
            operations,
            store,
            new NetworkntSchemaValidator(),
            null,
            CoreTestFixtures.SECRET,
            CLOCK,
            () -> "run-replay-" + ids.incrementAndGet())) {
      var confirmation =
          new ConfirmationAcknowledgement(
              definition.id(),
              definition.revision(),
              definition.execution().impact(),
              CoreTestFixtures.EMPTY);
      var accepted =
          manager.create(
              definition.id(),
              new CreateRunRequest(
                  definition.revision(),
                  CoreTestFixtures.EMPTY,
                  null,
                  false,
                  "replay-key",
                  confirmation,
                  CoreTestFixtures.EMPTY));
      assertTrue(accepted.isSuccess());
      assertEquals(RunState.SUCCEEDED, awaitTerminal(manager, accepted.run().id()).state());
      int lookupsAfterAcceptance = replayCalls.get();
      int callsAfterAcceptance = handlerCalls.get();

      var replayWithoutConfirmation =
          manager.create(
              definition.id(),
              new CreateRunRequest(
                  definition.revision(),
                  CoreTestFixtures.EMPTY,
                  null,
                  false,
                  "replay-key",
                  CoreTestFixtures.EMPTY));

      assertFalse(replayWithoutConfirmation.isSuccess());
      assertEquals(422, replayWithoutConfirmation.problem().status());
      assertEquals(
          "/confirmation", replayWithoutConfirmation.problem().errors().getFirst().instancePath());
      assertEquals(lookupsAfterAcceptance, replayCalls.get());
      assertEquals(callsAfterAcceptance, handlerCalls.get());
      assertEquals(1, delegate.all().size());
    }
  }

  @Test
  void createReturnsQueuedBeforeTheHandlerCompletes() throws Exception {
    var started = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    try (var fixture =
        fixture(
            policy(false, null, "allow", Idempotency.OPTIONAL),
            (input, context) -> {
              started.countDown();
              release.await();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            })) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));

      assertTrue(created.isSuccess());
      assertEquals(RunState.QUEUED, created.run().state());
      assertTrue(started.await(1, TimeUnit.SECONDS));

      release.countDown();
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, created.run().id()).state());
    }
  }

  @Test
  void forbidReturnsOperationBusyWithoutPersistingOrDispatchingASecondRun() throws Exception {
    var started = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    var executions = new AtomicInteger();
    try (var fixture =
        fixture(
            policy(false, null, "forbid", Idempotency.OPTIONAL),
            (input, context) -> {
              executions.incrementAndGet();
              started.countDown();
              release.await();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            })) {
      var first = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));
      assertTrue(first.isSuccess());
      assertTrue(started.await(1, TimeUnit.SECONDS));

      var second = fixture.manager.create(fixture.definition.id(), request(fixture, null, 2));

      assertFalse(second.isSuccess());
      assertEquals(409, second.problem().status());
      assertEquals("urn:gauntlet:problem:operation-busy", second.problem().type());
      assertEquals("Operation busy", second.problem().title());
      assertEquals(1, fixture.store.all().size());
      assertEquals(1, executions.get());

      release.countDown();
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, first.run().id()).state());
    }
  }

  @Test
  void concurrentForbidRequestsWithTheSameIdempotencyKeyReplayTheWinner() throws Exception {
    var handlerStarted = new CountDownLatch(1);
    var releaseHandler = new CountDownLatch(1);
    var executions = new AtomicInteger();
    try (var fixture =
            fixture(
                policy(false, null, "forbid", Idempotency.REQUIRED),
                (input, context) -> {
                  executions.incrementAndGet();
                  handlerStarted.countDown();
                  releaseHandler.await();
                  return OperationResult.succeeded(CoreTestFixtures.EMPTY);
                });
        var callers = Executors.newFixedThreadPool(2)) {
      var start = new CountDownLatch(1);
      var request = request(fixture, "same-key", 1);
      var first =
          callers.submit(
              () -> {
                start.await();
                return fixture.manager.create(fixture.definition.id(), request);
              });
      var second =
          callers.submit(
              () -> {
                start.await();
                return fixture.manager.create(fixture.definition.id(), request);
              });

      start.countDown();
      var firstResult = first.get(1, TimeUnit.SECONDS);
      var secondResult = second.get(1, TimeUnit.SECONDS);

      assertTrue(firstResult.isSuccess());
      assertTrue(secondResult.isSuccess());
      assertEquals(firstResult.run().id(), secondResult.run().id());
      assertEquals(1, fixture.store.all().size());
      assertTrue(handlerStarted.await(1, TimeUnit.SECONDS));
      assertEquals(1, executions.get());

      releaseHandler.countDown();
      assertEquals(
          RunState.SUCCEEDED, awaitTerminal(fixture.manager, firstResult.run().id()).state());
    }
  }

  @Test
  void forbidWithADifferentIdempotencyKeyReturnsBusyAfterTheWinnerIsPublished() throws Exception {
    var started = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    try (var fixture =
        fixture(
            policy(false, null, "forbid", Idempotency.REQUIRED),
            (input, context) -> {
              started.countDown();
              release.await();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            })) {
      var first = fixture.manager.create(fixture.definition.id(), request(fixture, "key-1", 1));
      assertTrue(first.isSuccess());
      assertTrue(started.await(1, TimeUnit.SECONDS));

      RunCreationResult second;
      try {
        second =
            assertTimeoutPreemptively(
                Duration.ofSeconds(1),
                () ->
                    fixture.manager.create(fixture.definition.id(), request(fixture, "key-2", 2)));
      } finally {
        release.countDown();
      }

      assertFalse(second.isSuccess());
      assertEquals("urn:gauntlet:problem:operation-busy", second.problem().type());
      assertEquals(409, second.problem().status());

      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, first.run().id()).state());
    }
  }

  @Test
  void queueRunsOneHandlerAtATimeInCreationOrder() throws Exception {
    var turns = List.of(new CountDownLatch(1), new CountDownLatch(1), new CountDownLatch(1));
    var releases = List.of(new CountDownLatch(1), new CountDownLatch(1), new CountDownLatch(1));
    var order = new ArrayList<Integer>();
    var active = new AtomicInteger();
    var maximumActive = new AtomicInteger();
    try (var fixture =
        fixture(
            policy(false, null, "queue", Idempotency.OPTIONAL),
            (input, context) -> {
              int index = ((Number) ((JsonValue.Scalar) input.get("index")).value()).intValue();
              int nowActive = active.incrementAndGet();
              maximumActive.accumulateAndGet(nowActive, Math::max);
              synchronized (order) {
                order.add(index);
              }
              turns.get(index - 1).countDown();
              releases.get(index - 1).await();
              active.decrementAndGet();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            })) {
      var first = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));
      var second = fixture.manager.create(fixture.definition.id(), request(fixture, null, 2));
      var third = fixture.manager.create(fixture.definition.id(), request(fixture, null, 3));

      assertTrue(turns.get(0).await(1, TimeUnit.SECONDS));
      assertFalse(turns.get(1).await(100, TimeUnit.MILLISECONDS));
      releases.get(0).countDown();
      assertTrue(turns.get(1).await(1, TimeUnit.SECONDS));
      assertFalse(turns.get(2).await(100, TimeUnit.MILLISECONDS));
      releases.get(1).countDown();
      assertTrue(turns.get(2).await(1, TimeUnit.SECONDS));
      releases.get(2).countDown();

      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, first.run().id()).state());
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, second.run().id()).state());
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, third.run().id()).state());
      assertEquals(List.of(1, 2, 3), order);
      assertEquals(1, maximumActive.get());
    }
  }

  @Test
  void cancellationClosesTheContextAndWinsOverLateWritesAndResults() throws Exception {
    var started = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    var finished = new CountDownLatch(1);
    var retained = new AtomicReference<RunContext>();
    try (var fixture =
        fixture(
            policy(true, null, "allow", Idempotency.OPTIONAL),
            (input, context) -> {
              retained.set(context);
              started.countDown();
              awaitIgnoringInterrupts(release);
              context.report(
                  new RunProgress(
                      1d,
                      1d,
                      "late",
                      "late progress",
                      "2026-08-30T12:00:00Z",
                      CoreTestFixtures.EMPTY));
              context.addArtifact(notice("late-artifact", "late artifact"));
              finished.countDown();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            })) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));
      assertTrue(started.await(1, TimeUnit.SECONDS));

      var cancellation = fixture.manager.cancel(created.run().id());

      assertTrue(cancellation.isSuccess());
      assertEquals(RunState.CANCELLED, cancellation.run().state());
      assertEquals("urn:gauntlet:problem:run-cancelled", cancellation.run().problem().type());
      assertEquals("Run cancelled", cancellation.run().problem().title());
      assertEquals(409, cancellation.run().problem().status());
      assertTrue(retained.get().isCancellationRequested());
      assertTrue(retained.get().invocationContext().isEmpty());

      release.countDown();
      assertTrue(finished.await(1, TimeUnit.SECONDS));
      Run stored = fixture.manager.get(created.run().id()).orElseThrow();
      assertEquals(cancellation.run(), stored);
      assertTrue(stored.artifacts().isEmpty());
      assertEquals(null, stored.progress());
    }
  }

  @Test
  void cancellationUnsupportedReturnsAConflictWithoutChangingTheRun() throws Exception {
    var started = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    try (var fixture =
        fixture(
            policy(false, null, "allow", Idempotency.OPTIONAL),
            (input, context) -> {
              started.countDown();
              release.await();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            })) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));
      assertTrue(started.await(1, TimeUnit.SECONDS));

      var cancellation = fixture.manager.cancel(created.run().id());

      assertFalse(cancellation.isSuccess());
      assertEquals(409, cancellation.problem().status());
      assertEquals("urn:gauntlet:problem:run-not-cancellable", cancellation.problem().type());
      assertEquals("Run is not cancellable", cancellation.problem().title());
      assertEquals(RunState.RUNNING, fixture.manager.get(created.run().id()).orElseThrow().state());

      release.countDown();
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, created.run().id()).state());
    }
  }

  @Test
  void cancellationUnsupportedAlsoReturnsAConflictForATerminalRun() {
    try (var fixture =
        fixture(
            policy(false, null, "allow", Idempotency.OPTIONAL),
            (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY))) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));
      Run succeeded = awaitTerminal(fixture.manager, created.run().id());

      var cancellation = fixture.manager.cancel(succeeded.id());

      assertFalse(cancellation.isSuccess());
      assertEquals(409, cancellation.problem().status());
      assertEquals("urn:gauntlet:problem:run-not-cancellable", cancellation.problem().type());
      assertEquals(succeeded, fixture.manager.get(succeeded.id()).orElseThrow());
    }
  }

  @Test
  void timeoutClosesTheContextAndIgnoresAHandlerThatReturnsLate() throws Exception {
    var started = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    var finished = new CountDownLatch(1);
    var retained = new AtomicReference<RunContext>();
    try (var fixture =
        fixture(
            policy(true, 1, "allow", Idempotency.OPTIONAL),
            (input, context) -> {
              retained.set(context);
              started.countDown();
              awaitIgnoringInterrupts(release);
              context.addArtifact(notice("late-timeout-artifact", "late timeout artifact"));
              finished.countDown();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            })) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));
      assertTrue(started.await(1, TimeUnit.SECONDS));

      Run timedOut = awaitTerminal(fixture.manager, created.run().id());

      assertEquals(RunState.TIMED_OUT, timedOut.state());
      assertEquals("urn:gauntlet:problem:run-timed-out", timedOut.problem().type());
      assertEquals("Run timed out", timedOut.problem().title());
      assertEquals(504, timedOut.problem().status());
      assertTrue(retained.get().isCancellationRequested());
      assertTrue(retained.get().invocationContext().isEmpty());

      release.countDown();
      assertTrue(finished.await(1, TimeUnit.SECONDS));
      Run stored = fixture.manager.get(created.run().id()).orElseThrow();
      assertEquals(timedOut, stored);
      assertTrue(stored.artifacts().isEmpty());
    }
  }

  @Test
  void queuedRunsDoNotOccupyAConstrainedWorkerPoolBeforeTheirTurn() throws Exception {
    var releases = List.of(new CountDownLatch(1), new CountDownLatch(1), new CountDownLatch(1));
    var started = List.of(new CountDownLatch(1), new CountDownLatch(1), new CountDownLatch(1));
    var workers = (ThreadPoolExecutor) Executors.newFixedThreadPool(1);
    var timer = Executors.newSingleThreadScheduledExecutor();
    try (var fixture =
        fixture(
            policy(false, null, "queue", Idempotency.OPTIONAL),
            (input, context) -> {
              int index = ((Number) ((JsonValue.Scalar) input.get("index")).value()).intValue();
              started.get(index - 1).countDown();
              releases.get(index - 1).await();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            },
            workers,
            timer)) {
      var first = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));
      var second = fixture.manager.create(fixture.definition.id(), request(fixture, null, 2));
      var third = fixture.manager.create(fixture.definition.id(), request(fixture, null, 3));

      assertTrue(started.get(0).await(1, TimeUnit.SECONDS));
      assertEquals(0, workers.getQueue().size());

      releases.get(0).countDown();
      assertTrue(started.get(1).await(1, TimeUnit.SECONDS));
      releases.get(1).countDown();
      assertTrue(started.get(2).await(1, TimeUnit.SECONDS));
      releases.get(2).countDown();
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, first.run().id()).state());
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, second.run().id()).state());
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, third.run().id()).state());
    }
  }

  @Test
  void workerRejectionTerminalizesTheRunAndReleasesItsReservation() {
    var workers = (ThreadPoolExecutor) Executors.newFixedThreadPool(1);
    workers.shutdownNow();
    var timer = Executors.newSingleThreadScheduledExecutor();
    var executions = new AtomicInteger();
    try (var fixture =
        fixture(
            policy(false, null, "forbid", Idempotency.OPTIONAL),
            (input, context) -> {
              executions.incrementAndGet();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            },
            workers,
            timer)) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));

      assertTrue(created.isSuccess());
      Run terminal = awaitTerminal(fixture.manager, created.run().id());
      assertEquals(RunState.FAILED, terminal.state());
      assertEquals("urn:gauntlet:problem:handler-failed", terminal.problem().type());
      assertEquals(0, executions.get());
      try (var probe =
          fixture.coordinator.reserve(fixture.definition.id(), "run-probe", "forbid")) {
        assertTrue(probe.admitted());
      }
    }
  }

  @Test
  void handlerErrorTerminalizesTheRunAndReleasesItsReservation() {
    try (var fixture =
        fixture(
            policy(false, null, "forbid", Idempotency.OPTIONAL),
            (input, context) -> {
              throw new AssertionError("must-not-leak");
            })) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));

      assertTrue(created.isSuccess());
      Run terminal = awaitTerminal(fixture.manager, created.run().id());
      assertEquals(RunState.FAILED, terminal.state());
      assertEquals("urn:gauntlet:problem:handler-failed", terminal.problem().type());
      try (var probe =
          fixture.coordinator.reserve(fixture.definition.id(), "run-probe", "forbid")) {
        assertTrue(probe.admitted());
      }
    }
  }

  @Test
  void cancellationProbeFailureWhileQueuedTerminalizesAndCleansTheRun() {
    var coordinator = new HostileCancellationCoordinator(0);
    var executions = new AtomicInteger();
    try (var fixture =
        fixture(
            policy(false, null, "allow", Idempotency.OPTIONAL),
            (input, context) -> {
              executions.incrementAndGet();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            },
            Executors.newVirtualThreadPerTaskExecutor(),
            Executors.newSingleThreadScheduledExecutor(),
            coordinator)) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));

      assertTrue(created.isSuccess());
      Run terminal = awaitTerminal(fixture.manager, created.run().id());
      assertEquals(RunState.FAILED, terminal.state());
      assertEquals("urn:gauntlet:problem:adapter-internal-error", terminal.problem().type());
      assertEquals(0, executions.get());
      assertTrue(coordinator.reservationClosed.get());
      assertNoActiveControls(fixture.manager);
    }
  }

  @Test
  void cancellationProbeFailureWhileRunningDoesNotProbeAgainInTheCatchPath() {
    var coordinator = new HostileCancellationCoordinator(2);
    var retained = new AtomicReference<RunContext>();
    var executions = new AtomicInteger();
    try (var fixture =
        fixture(
            policy(false, null, "allow", Idempotency.OPTIONAL),
            (input, context) -> {
              executions.incrementAndGet();
              retained.set(context);
              context.isCancellationRequested();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            },
            Executors.newVirtualThreadPerTaskExecutor(),
            Executors.newSingleThreadScheduledExecutor(),
            coordinator)) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));

      assertTrue(created.isSuccess());
      Run terminal = awaitTerminal(fixture.manager, created.run().id());
      assertEquals(RunState.FAILED, terminal.state());
      assertEquals("urn:gauntlet:problem:adapter-internal-error", terminal.problem().type());
      assertEquals(1, executions.get());
      assertEquals(3, coordinator.cancellationReads.get());
      assertTrue(retained.get().invocationContext().isEmpty());
      assertTrue(coordinator.reservationClosed.get());
      assertNoActiveControls(fixture.manager);
    }
  }

  @Test
  void createThatPassesTheInitialClosedCheckCannotInstallAfterCloseMissesIt() throws Exception {
    var coordinator = new BlockingReserveCoordinator();
    var executions = new AtomicInteger();
    try (var fixture =
            fixture(
                policy(false, null, "allow", Idempotency.OPTIONAL),
                (input, context) -> {
                  executions.incrementAndGet();
                  return OperationResult.succeeded(CoreTestFixtures.EMPTY);
                },
                Executors.newVirtualThreadPerTaskExecutor(),
                Executors.newSingleThreadScheduledExecutor(),
                coordinator);
        var caller = Executors.newSingleThreadExecutor()) {
      var creation =
          caller.submit(
              () -> fixture.manager.create(fixture.definition.id(), request(fixture, null, 1)));
      assertTrue(coordinator.reserveEntered.await(1, TimeUnit.SECONDS));

      fixture.manager.close();
      coordinator.releaseReserve.countDown();
      RunCreationResult result = creation.get(1, TimeUnit.SECONDS);

      assertFalse(result.isSuccess());
      assertEquals(1, fixture.store.all().size());
      Run stored = fixture.store.all().getFirst();
      assertEquals(RunState.FAILED, stored.state());
      assertEquals(0, executions.get());
      assertTrue(coordinator.reservationClosed.get());
      assertNoActiveControls(fixture.manager);
    } finally {
      coordinator.releaseReserve.countDown();
    }
  }

  @Test
  void reservationCloseFailureAfterStoreFailureReturnsSafeFailureAndTerminalizesCandidate() {
    var definition = definition(policy(false, null, "allow", Idempotency.OPTIONAL));
    var delegate = new InMemoryRunStore();
    RunStore persistThenThrow =
        new RunStore() {
          @Override
          public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
            delegate.createQueued(run, fingerprint);
            throw new IllegalStateException("store failed after persistence");
          }

          @Override
          public Optional<Run> get(String runId) {
            return delegate.get(runId);
          }

          @Override
          public Optional<Run> findByIdempotencyFingerprint(
              String operationId, String fingerprint) {
            return delegate.findByIdempotencyFingerprint(operationId, fingerprint);
          }

          @Override
          public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
            return delegate.updateExactSequence(run, expectedPreviousSequence);
          }
        };
    var coordinator = new HostileCloseCoordinator();
    try (var manager = manager(definition, persistThenThrow, coordinator)) {
      RunCreationResult result =
          assertDoesNotThrow(
              () -> manager.create(definition.id(), request(definition, "persist-key")));

      assertFalse(result.isSuccess());
      assertEquals(500, result.problem().status());
      assertEquals(1, delegate.all().size());
      assertEquals(RunState.FAILED, delegate.all().getFirst().state());
      assertEquals(1, coordinator.closeCalls.get());
    }
  }

  @Test
  void reservationCloseFailureDoesNotMaskAnAuthoritativeDuplicate() {
    var definition = definition(policy(false, null, "allow", Idempotency.OPTIONAL));
    Run authoritative = Run.queued("existing-run", definition, CLOCK.instant());
    RunStore duplicateStore =
        new RunStore() {
          @Override
          public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
            return RunStoreCreateResult.duplicate(authoritative);
          }

          @Override
          public Optional<Run> get(String runId) {
            return Optional.of(authoritative);
          }

          @Override
          public Optional<Run> findByIdempotencyFingerprint(
              String operationId, String fingerprint) {
            return Optional.empty();
          }

          @Override
          public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
            return false;
          }
        };
    var coordinator = new HostileCloseCoordinator();
    try (var manager = manager(definition, duplicateStore, coordinator)) {
      RunCreationResult result =
          assertDoesNotThrow(
              () -> manager.create(definition.id(), request(definition, "duplicate-key")));

      assertTrue(result.isSuccess());
      assertEquals(authoritative, result.run());
      assertEquals(1, coordinator.closeCalls.get());
    }
  }

  @Test
  void timeoutSchedulerRejectionFailsWithoutInvokingTheHandler() {
    var workers = Executors.newVirtualThreadPerTaskExecutor();
    ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    timer.shutdownNow();
    var executions = new AtomicInteger();
    try (var fixture =
        fixture(
            policy(false, 1, "allow", Idempotency.OPTIONAL),
            (input, context) -> {
              executions.incrementAndGet();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            },
            workers,
            timer)) {
      var created = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));

      assertTrue(created.isSuccess());
      Run terminal = awaitTerminal(fixture.manager, created.run().id());
      assertEquals(RunState.FAILED, terminal.state());
      assertEquals("urn:gauntlet:problem:handler-failed", terminal.problem().type());
      assertEquals(0, executions.get());
    }
  }

  @Test
  void closingAManagerDoesNotCloseApplicationOwnedExecutors() {
    var workers = Executors.newVirtualThreadPerTaskExecutor();
    var timer = Executors.newSingleThreadScheduledExecutor();
    try (var fixture =
        fixture(
            policy(false, null, "allow", Idempotency.OPTIONAL),
            (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY),
            workers,
            timer)) {
      fixture.manager.close();

      assertFalse(workers.isShutdown());
      assertFalse(timer.isShutdown());
      var rejected = fixture.manager.create(fixture.definition.id(), request(fixture, null, 1));
      assertFalse(rejected.isSuccess());
      assertEquals(500, rejected.problem().status());
    }
  }

  @Test
  void closingAManagerStopsItsOwnedDefaultTimeoutScheduler() throws Exception {
    var definition = definition(policy(false, 60, "allow", Idempotency.OPTIONAL));
    var features = new FeatureRegistry();
    features.register(
        new FeatureDefinition("applications", "Applications", null, 0, CoreTestFixtures.EMPTY));
    var operations = new OperationRegistry(features);
    var started = new CountDownLatch(1);
    var neverReleased = new CountDownLatch(1);
    operations.register(
        new OperationHandler<JsonObject>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public OperationResult execute(JsonObject input, RunContext context) throws Exception {
            started.countDown();
            neverReleased.await();
            return OperationResult.succeeded(CoreTestFixtures.EMPTY);
          }
        });
    long baseline = timeoutThreadCount();
    var manager =
        new RunManager(
            operations,
            new InMemoryRunStore(),
            new NetworkntSchemaValidator(),
            null,
            CoreTestFixtures.SECRET,
            CLOCK,
            () -> "run-owned-executors",
            new InMemoryExecutionCoordinator());
    try {
      var created =
          manager.create(
              definition.id(),
              new CreateRunRequest(
                  definition.revision(),
                  JsonOwnership.object(Map.of("index", 1)),
                  null,
                  false,
                  null,
                  CoreTestFixtures.EMPTY));
      assertTrue(created.isSuccess());
      assertTrue(started.await(1, TimeUnit.SECONDS));
      assertEventually(() -> timeoutThreadCount() > baseline);
    } finally {
      manager.close();
    }

    assertEventually(() -> timeoutThreadCount() <= baseline);
  }

  @Test
  void closingOneManagerKeepsTheSharedForbidSlotUntilItsHandlerSettles() throws Exception {
    var definition = definition(policy(false, null, "forbid", Idempotency.OPTIONAL));
    var features = new FeatureRegistry();
    features.register(
        new FeatureDefinition("applications", "Applications", null, 0, CoreTestFixtures.EMPTY));
    var operations = new OperationRegistry(features);
    var started = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    var finished = new CountDownLatch(1);
    operations.register(
        new OperationHandler<JsonObject>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public OperationResult execute(JsonObject input, RunContext context) {
            int index = ((Number) ((JsonValue.Scalar) input.get("index")).value()).intValue();
            if (index == 1) {
              started.countDown();
              awaitIgnoringInterrupts(release);
              finished.countDown();
            }
            return OperationResult.succeeded(CoreTestFixtures.EMPTY);
          }
        });
    var coordinator = new InMemoryExecutionCoordinator();
    var firstWorkers = Executors.newVirtualThreadPerTaskExecutor();
    var secondWorkers = Executors.newVirtualThreadPerTaskExecutor();
    var firstTimer = Executors.newSingleThreadScheduledExecutor();
    var secondTimer = Executors.newSingleThreadScheduledExecutor();
    var firstStore = new InMemoryRunStore();
    var secondStore = new InMemoryRunStore();
    var first =
        new RunManager(
            operations,
            firstStore,
            new NetworkntSchemaValidator(),
            null,
            CoreTestFixtures.SECRET,
            CLOCK,
            () -> "run-first",
            coordinator,
            firstWorkers,
            firstTimer);
    var second =
        new RunManager(
            operations,
            secondStore,
            new NetworkntSchemaValidator(),
            null,
            CoreTestFixtures.SECRET,
            CLOCK,
            () -> "run-second",
            coordinator,
            secondWorkers,
            secondTimer);
    try {
      var created =
          first.create(
              definition.id(),
              new CreateRunRequest(
                  definition.revision(),
                  JsonOwnership.object(Map.of("index", 1)),
                  null,
                  false,
                  null,
                  CoreTestFixtures.EMPTY));
      assertTrue(created.isSuccess());
      assertTrue(started.await(1, TimeUnit.SECONDS));

      first.close();
      var whileClosingHandlerStillRuns =
          second.create(
              definition.id(),
              new CreateRunRequest(
                  definition.revision(),
                  JsonOwnership.object(Map.of("index", 2)),
                  null,
                  false,
                  null,
                  CoreTestFixtures.EMPTY));

      assertFalse(whileClosingHandlerStillRuns.isSuccess());
      assertEquals(
          "urn:gauntlet:problem:operation-busy", whileClosingHandlerStillRuns.problem().type());

      release.countDown();
      assertTrue(finished.await(1, TimeUnit.SECONDS));
      RunCreationResult afterSettlement =
          assertEventuallyCreates(second, definition, JsonOwnership.object(Map.of("index", 2)));
      assertTrue(afterSettlement.isSuccess());
    } finally {
      release.countDown();
      first.close();
      second.close();
      firstWorkers.close();
      secondWorkers.close();
      firstTimer.close();
      secondTimer.close();
    }
  }

  private static ExecutionPolicy policy(
      boolean cancellationSupported,
      Integer timeoutSeconds,
      String concurrency,
      Idempotency idempotency) {
    return new ExecutionPolicy(
        OperationImpact.WRITE,
        false,
        false,
        idempotency,
        cancellationSupported,
        timeoutSeconds,
        concurrency,
        CoreTestFixtures.EMPTY);
  }

  private static Fixture fixture(ExecutionPolicy policy, Handler handler) {
    return fixture(
        policy,
        handler,
        Executors.newVirtualThreadPerTaskExecutor(),
        Executors.newSingleThreadScheduledExecutor());
  }

  private static Fixture fixture(
      ExecutionPolicy policy,
      Handler handler,
      java.util.concurrent.ExecutorService workers,
      ScheduledExecutorService timer) {
    return fixture(policy, handler, workers, timer, new InMemoryExecutionCoordinator());
  }

  private static Fixture fixture(
      ExecutionPolicy policy,
      Handler handler,
      java.util.concurrent.ExecutorService workers,
      ScheduledExecutorService timer,
      ExecutionCoordinator coordinator) {
    var definition = definition(policy);
    var features = new FeatureRegistry();
    features.register(
        new FeatureDefinition("applications", "Applications", null, 0, CoreTestFixtures.EMPTY));
    var operations = new OperationRegistry(features);
    operations.register(
        new OperationHandler<JsonObject>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public OperationResult execute(JsonObject input, RunContext context) throws Exception {
            return handler.execute(input, context);
          }
        });
    var store = new InMemoryRunStore();
    var ids = new AtomicInteger();
    var manager =
        new RunManager(
            operations,
            store,
            new NetworkntSchemaValidator(),
            null,
            CoreTestFixtures.SECRET,
            CLOCK,
            () -> "run-" + ids.incrementAndGet(),
            coordinator,
            workers,
            timer);
    return new Fixture(manager, store, definition, coordinator, workers, timer);
  }

  private static OperationDefinition definition(ExecutionPolicy policy) {
    return new OperationDefinition(
        "applications.execute",
        "applications",
        "Execute",
        null,
        CoreTestFixtures.OBJECT_SCHEMA,
        null,
        null,
        null,
        List.of(),
        List.of(),
        policy,
        new OperationOutput(CoreTestFixtures.OBJECT_SCHEMA, null, CoreTestFixtures.EMPTY),
        null,
        0,
        List.of(),
        null,
        CoreTestFixtures.EMPTY);
  }

  private static RunManager manager(
      OperationDefinition definition, RunStore store, ExecutionCoordinator coordinator) {
    var features = new FeatureRegistry();
    features.register(
        new FeatureDefinition("applications", "Applications", null, 0, CoreTestFixtures.EMPTY));
    var operations = new OperationRegistry(features);
    operations.register(
        new OperationHandler<JsonObject>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public OperationResult execute(JsonObject input, RunContext context) {
            return OperationResult.succeeded(CoreTestFixtures.EMPTY);
          }
        });
    return new RunManager(
        operations,
        store,
        new NetworkntSchemaValidator(),
        null,
        CoreTestFixtures.SECRET,
        CLOCK,
        () -> "run-hostile-close",
        coordinator);
  }

  private static CreateRunRequest request(OperationDefinition definition, String idempotencyKey) {
    return new CreateRunRequest(
        definition.revision(),
        CoreTestFixtures.EMPTY,
        null,
        false,
        idempotencyKey,
        CoreTestFixtures.EMPTY);
  }

  private static CreateRunRequest request(Fixture fixture, String idempotencyKey, int index) {
    return new CreateRunRequest(
        fixture.definition.revision(),
        JsonOwnership.object(Map.of("index", index)),
        null,
        false,
        idempotencyKey,
        CoreTestFixtures.EMPTY);
  }

  private static Run awaitTerminal(RunManager manager, String runId) {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
    while (System.nanoTime() < deadline) {
      Run run = manager.get(runId).orElseThrow();
      if (run.state().terminal()) return run;
      LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
    }
    throw new AssertionError("run did not become terminal");
  }

  private static RunCreationResult assertEventuallyCreates(
      RunManager manager, OperationDefinition definition, JsonObject input) {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
    while (System.nanoTime() < deadline) {
      RunCreationResult result =
          manager.create(
              definition.id(),
              new CreateRunRequest(
                  definition.revision(), input, null, false, null, CoreTestFixtures.EMPTY));
      if (result.isSuccess()) return result;
      LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
    }
    throw new AssertionError("operation remained busy after the prior handler settled");
  }

  private static void assertEventually(BooleanSupplier condition) {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
    while (System.nanoTime() < deadline) {
      if (condition.getAsBoolean()) return;
      LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
    }
    assertTrue(condition.getAsBoolean());
  }

  private static void assertNoActiveControls(RunManager manager) {
    try {
      var field = RunManager.class.getDeclaredField("active");
      field.setAccessible(true);
      assertTrue(((Map<?, ?>) field.get(manager)).isEmpty());
    } catch (ReflectiveOperationException exception) {
      throw new AssertionError(exception);
    }
  }

  private static long timeoutThreadCount() {
    return Thread.getAllStackTraces().keySet().stream()
        .filter(Thread::isAlive)
        .filter(thread -> thread.getName().equals("gauntlet-timeout"))
        .count();
  }

  private static void awaitIgnoringInterrupts(CountDownLatch latch) {
    boolean interrupted = false;
    while (true) {
      try {
        latch.await();
        break;
      } catch (InterruptedException exception) {
        interrupted = true;
      }
    }
    if (interrupted) Thread.currentThread().interrupt();
  }

  private static Artifact notice(String id, String message) {
    return new Artifact(
        id,
        "notice",
        null,
        JsonOwnership.object(Map.of("level", "info", "message", message)),
        CoreTestFixtures.EMPTY);
  }

  @FunctionalInterface
  private interface Handler {
    OperationResult execute(JsonObject input, RunContext context) throws Exception;
  }

  private record Fixture(
      RunManager manager,
      InMemoryRunStore store,
      OperationDefinition definition,
      ExecutionCoordinator coordinator,
      java.util.concurrent.ExecutorService workers,
      java.util.concurrent.ScheduledExecutorService timer)
      implements AutoCloseable {
    @Override
    public void close() {
      manager.close();
      workers.close();
      timer.close();
    }
  }

  private static final class HostileCancellationCoordinator implements ExecutionCoordinator {
    private final int successfulReads;
    private final AtomicInteger cancellationReads = new AtomicInteger();
    private final AtomicBoolean reservationClosed = new AtomicBoolean();

    private HostileCancellationCoordinator(int successfulReads) {
      this.successfulReads = successfulReads;
    }

    @Override
    public Reservation reserve(String operationId, String runId, String concurrency) {
      return new Reservation() {
        @Override
        public boolean admitted() {
          return true;
        }

        @Override
        public CompletionStage<Void> turn() {
          return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Boolean> conflictResolution() {
          return CompletableFuture.completedFuture(false);
        }

        @Override
        public void markPersisted() {}

        @Override
        public boolean cancellationRequested() {
          if (cancellationReads.incrementAndGet() > successfulReads) {
            throw new IllegalStateException("hostile cancellation probe");
          }
          return false;
        }

        @Override
        public void close() {
          reservationClosed.set(true);
        }
      };
    }

    @Override
    public boolean requestCancellation(String operationId, String runId) {
      return false;
    }
  }

  private static final class BlockingReserveCoordinator implements ExecutionCoordinator {
    private final CountDownLatch reserveEntered = new CountDownLatch(1);
    private final CountDownLatch releaseReserve = new CountDownLatch(1);
    private final AtomicBoolean reservationClosed = new AtomicBoolean();

    @Override
    public Reservation reserve(String operationId, String runId, String concurrency) {
      reserveEntered.countDown();
      try {
        releaseReserve.await();
      } catch (InterruptedException exception) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("reserve interrupted", exception);
      }
      return new Reservation() {
        @Override
        public boolean admitted() {
          return true;
        }

        @Override
        public CompletionStage<Void> turn() {
          return new CompletableFuture<>();
        }

        @Override
        public CompletionStage<Boolean> conflictResolution() {
          return CompletableFuture.completedFuture(false);
        }

        @Override
        public void markPersisted() {}

        @Override
        public boolean cancellationRequested() {
          return false;
        }

        @Override
        public void close() {
          reservationClosed.set(true);
        }
      };
    }

    @Override
    public boolean requestCancellation(String operationId, String runId) {
      return false;
    }
  }

  private static final class HostileCloseCoordinator implements ExecutionCoordinator {
    private final AtomicInteger closeCalls = new AtomicInteger();

    @Override
    public Reservation reserve(String operationId, String runId, String concurrency) {
      return new Reservation() {
        @Override
        public boolean admitted() {
          return true;
        }

        @Override
        public CompletionStage<Void> turn() {
          return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Boolean> conflictResolution() {
          return CompletableFuture.completedFuture(false);
        }

        @Override
        public void markPersisted() {}

        @Override
        public boolean cancellationRequested() {
          return false;
        }

        @Override
        public void close() {
          closeCalls.incrementAndGet();
          throw new IllegalStateException("hostile reservation close");
        }
      };
    }

    @Override
    public boolean requestCancellation(String operationId, String runId) {
      return false;
    }
  }
}
