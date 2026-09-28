package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.model.FeatureDefinition;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.InvocationContext;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunState;
import dev.eightlines.gauntlet.core.registry.FeatureRegistry;
import dev.eightlines.gauntlet.core.registry.OperationRegistry;
import dev.eightlines.gauntlet.core.run.InMemoryRunStore;
import dev.eightlines.gauntlet.core.run.RunManager;
import dev.eightlines.gauntlet.core.schema.NetworkntSchemaValidator;
import dev.eightlines.gauntlet.core.spi.OperationHandler;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;
import org.junit.jupiter.api.Test;

class RunManagerTest {
  @Test
  void staleRevisionReturnsConflictWithoutPersistingARun() {
    var fixture = CoreTestFixtures.runManager(Idempotency.OPTIONAL);
    var stale = "sha256:" + "f".repeat(64);
    var context =
        new InvocationContext("request-1", null, null, null, null, JsonOwnership.object(Map.of()));
    var result =
        fixture
            .manager()
            .create(
                "applications.finalize",
                new CreateRunRequest(
                    stale,
                    JsonOwnership.object(Map.of()),
                    context,
                    false,
                    null,
                    JsonOwnership.object(Map.of())));
    assertEquals(409, result.problem().status());
    assertTrue(fixture.store().all().isEmpty());
  }

  @Test
  void idempotencyPoliciesAreEnforcedBeforePersistence() {
    var none = CoreTestFixtures.runManager(Idempotency.NONE);
    var forbidden = none.manager().create(none.definition().id(), request(none, "key"));
    assertEquals(422, forbidden.problem().status());
    assertTrue(none.store().all().isEmpty());

    var required = CoreTestFixtures.runManager(Idempotency.REQUIRED);
    var missing = required.manager().create(required.definition().id(), request(required, null));
    assertEquals(422, missing.problem().status());
    assertTrue(required.store().all().isEmpty());

    var optional = CoreTestFixtures.runManager(Idempotency.OPTIONAL);
    var first =
        optional.manager().create(optional.definition().id(), request(optional, "same-key"));
    var second =
        optional.manager().create(optional.definition().id(), request(optional, "same-key"));
    assertTrue(first.isSuccess());
    assertEquals(first.run().id(), second.run().id());
    awaitTerminal(optional.manager(), first.run().id());
    assertEquals(1, optional.executions().get());
    assertFalse(optional.store().containsText("same-key"));
  }

  @Test
  void successfulRunsArePersistedThroughExactSequences() {
    var fixture = CoreTestFixtures.runManager(Idempotency.OPTIONAL);
    var result = fixture.manager().create(fixture.definition().id(), request(fixture, null));
    assertTrue(result.isSuccess());
    Run terminal = awaitTerminal(fixture.manager(), result.run().id());
    assertEquals(RunState.SUCCEEDED, terminal.state());
    assertEquals(2L, terminal.sequence());
    assertNotNull(terminal.completedAt());
    assertEquals(terminal, fixture.manager().get(terminal.id()).orElseThrow());
  }

  @Test
  void invocationContextLeaseIsVisibleOnlyInsideHandlerOnSuccessAndFailure() {
    for (boolean fail : new boolean[] {false, true}) {
      var definition = CoreTestFixtures.fixtureDefinition("applications.lease");
      var retained =
          new java.util.concurrent.atomic.AtomicReference<
              dev.eightlines.gauntlet.core.spi.RunContext>();
      OperationHandler<dev.eightlines.gauntlet.core.json.JsonObject> handler =
          new OperationHandler<>() {
            @Override
            public dev.eightlines.gauntlet.core.model.OperationDefinition definition() {
              return definition;
            }

            @Override
            public OperationResult execute(
                dev.eightlines.gauntlet.core.json.JsonObject input,
                dev.eightlines.gauntlet.core.spi.RunContext context) {
              assertEquals(
                  "secret-context-sentinel",
                  ((dev.eightlines.gauntlet.core.json.JsonValue.Scalar)
                          context
                              .invocationContext()
                              .orElseThrow()
                              .extensions()
                              .get("urn:test:sentinel"))
                      .value());
              retained.set(context);
              if (fail) throw new IllegalStateException("must-not-leak");
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            }
          };
      var features = new FeatureRegistry();
      features.register(
          new FeatureDefinition("applications", "Applications", null, 0, CoreTestFixtures.EMPTY));
      var operations = new OperationRegistry(features);
      operations.register(handler);
      var store = new InMemoryRunStore();
      var manager =
          new RunManager(
              operations,
              store,
              new NetworkntSchemaValidator(),
              null,
              CoreTestFixtures.SECRET,
              Clock.fixed(Instant.parse("2026-08-29T12:00:00Z"), ZoneOffset.UTC),
              () -> fail ? "run-failure" : "run-success");
      var context =
          new InvocationContext(
              "request-lease",
              null,
              null,
              null,
              null,
              JsonOwnership.object(Map.of("urn:test:sentinel", "secret-context-sentinel")));
      var result =
          manager.create(
              definition.id(),
              new CreateRunRequest(
                  definition.revision(),
                  CoreTestFixtures.EMPTY,
                  context,
                  false,
                  null,
                  CoreTestFixtures.EMPTY));

      assertTrue(result.isSuccess());
      Run terminal = awaitTerminal(manager, result.run().id());
      assertTrue(retained.get().invocationContext().isEmpty());
      assertFalse(store.containsText("secret-context-sentinel"));
      if (fail) {
        assertEquals(RunState.FAILED, terminal.state());
        assertEquals("urn:gauntlet:problem:handler-failed", terminal.problem().type());
        assertFalse(terminal.problem().toProtocolMap().toString().contains("must-not-leak"));
      }
    }
  }

  private static CreateRunRequest request(CoreTestFixtures.RunManagerFixture fixture, String key) {
    return new CreateRunRequest(
        fixture.definition().revision(),
        CoreTestFixtures.EMPTY,
        null,
        false,
        key,
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
}
