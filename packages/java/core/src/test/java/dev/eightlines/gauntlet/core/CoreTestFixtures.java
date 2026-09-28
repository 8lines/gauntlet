package dev.eightlines.gauntlet.core;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.EnvironmentDescriptor;
import dev.eightlines.gauntlet.core.model.EnvironmentKind;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.FeatureDefinition;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.OperationOutput;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.registry.FeatureRegistry;
import dev.eightlines.gauntlet.core.registry.OperationRegistry;
import dev.eightlines.gauntlet.core.run.InMemoryRunStore;
import dev.eightlines.gauntlet.core.run.RunManager;
import dev.eightlines.gauntlet.core.schema.NetworkntSchemaValidator;
import dev.eightlines.gauntlet.core.spi.OperationHandler;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

final class CoreTestFixtures {
  static final JsonObject EMPTY = JsonOwnership.object(Map.of());
  static final EnvironmentDescriptor ENVIRONMENT =
      new EnvironmentDescriptor("fixture-test", EnvironmentKind.TEST);
  static final JsonObject OBJECT_SCHEMA =
      JsonOwnership.object(
          Map.of(
              "$schema", "https://json-schema.org/draft/2020-12/schema",
              "type", "object"));
  static final byte[] SECRET =
      "0123456789abcdef0123456789abcdef".getBytes(java.nio.charset.StandardCharsets.UTF_8);

  private CoreTestFixtures() {}

  static OperationDefinition fixtureDefinition(String id) {
    return fixtureDefinition(id, Idempotency.OPTIONAL);
  }

  static OperationDefinition fixtureDefinition(String id, Idempotency idempotency) {
    String featureId = id.substring(0, id.indexOf('.'));
    return new OperationDefinition(
        id,
        featureId,
        "Fixture operation",
        null,
        OBJECT_SCHEMA,
        null,
        null,
        null,
        List.of(),
        List.of(),
        new ExecutionPolicy(
            OperationImpact.WRITE, false, false, idempotency, false, null, "allow", EMPTY),
        new OperationOutput(OBJECT_SCHEMA, null, EMPTY),
        null,
        0,
        List.of(),
        null,
        EMPTY);
  }

  static RunManagerFixture runManager(Idempotency idempotency) {
    var definition = fixtureDefinition("applications.finalize", idempotency);
    var executions = new AtomicInteger();
    OperationHandler<JsonObject> handler =
        new OperationHandler<>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public OperationResult execute(
              JsonObject input, dev.eightlines.gauntlet.core.spi.RunContext context) {
            executions.incrementAndGet();
            return OperationResult.succeeded(EMPTY);
          }
        };
    var features = new FeatureRegistry();
    features.register(new FeatureDefinition("applications", "Applications", null, 0, EMPTY));
    var operations = new OperationRegistry(features);
    operations.register(handler);
    var store = new InMemoryRunStore();
    var clock = Clock.fixed(Instant.parse("2026-08-29T12:00:00Z"), ZoneOffset.UTC);
    var ids = new AtomicInteger();
    var manager =
        new RunManager(
            operations,
            store,
            new NetworkntSchemaValidator(),
            null,
            SECRET,
            clock,
            () -> "run-" + ids.incrementAndGet());
    return new RunManagerFixture(manager, store, definition, executions);
  }

  record RunManagerFixture(
      RunManager manager,
      InMemoryRunStore store,
      OperationDefinition definition,
      AtomicInteger executions) {}
}
