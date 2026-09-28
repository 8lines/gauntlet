package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.Artifact;
import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.FeatureDefinition;
import dev.eightlines.gauntlet.core.model.FileReference;
import dev.eightlines.gauntlet.core.model.FollowUpAction;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.InputHandling;
import dev.eightlines.gauntlet.core.model.InvocationContext;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.OperationOutput;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunProgress;
import dev.eightlines.gauntlet.core.model.RunState;
import dev.eightlines.gauntlet.core.model.RunSummary;
import dev.eightlines.gauntlet.core.model.ValidationError;
import dev.eightlines.gauntlet.core.registry.FeatureRegistry;
import dev.eightlines.gauntlet.core.registry.OperationRegistry;
import dev.eightlines.gauntlet.core.run.InMemoryRunStore;
import dev.eightlines.gauntlet.core.run.RunManager;
import dev.eightlines.gauntlet.core.schema.NetworkntSchemaValidator;
import dev.eightlines.gauntlet.core.schema.SchemaValidator;
import dev.eightlines.gauntlet.core.spi.FileReferenceValidator;
import dev.eightlines.gauntlet.core.spi.OperationHandler;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.core.spi.RunStoreCreateResult;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import org.junit.jupiter.api.Test;

class RunManagerSafetyTest {
  private static final Clock CLOCK =
      Clock.fixed(Instant.parse("2026-08-29T12:00:00Z"), ZoneOffset.UTC);

  @Test
  void dryRunStateReachesTheHandlerAndPreventsApplicationMutation() {
    var mutations = new AtomicInteger();
    var seen = new java.util.ArrayList<Boolean>();
    var dryRunPolicy =
        new ExecutionPolicy(
            OperationImpact.WRITE,
            false,
            true,
            Idempotency.OPTIONAL,
            false,
            null,
            "allow",
            CoreTestFixtures.EMPTY);
    var definition =
        new OperationDefinition(
            "applications.dry-run",
            "applications",
            "Dry-run fixture",
            null,
            CoreTestFixtures.OBJECT_SCHEMA,
            null,
            null,
            null,
            List.of(),
            List.of(),
            dryRunPolicy,
            new OperationOutput(CoreTestFixtures.OBJECT_SCHEMA, null, CoreTestFixtures.EMPTY),
            null,
            0,
            List.of(),
            null,
            CoreTestFixtures.EMPTY);
    var fixture =
        fixture(
            definition,
            (input, context) -> {
              seen.add(context.isDryRun());
              if (!context.isDryRun()) mutations.incrementAndGet();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            },
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());
    try {
      var dry =
          fixture.manager.create(
              fixture.definition.id(),
              new CreateRunRequest(
                  fixture.definition.revision(),
                  CoreTestFixtures.EMPTY,
                  null,
                  true,
                  "dry-run",
                  null,
                  CoreTestFixtures.EMPTY));
      assertTrue(dry.isSuccess());
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, dry.run().id()).state());
      assertEquals(List.of(true), seen);
      assertEquals(0, mutations.get());

      var live =
          fixture.manager.create(
              fixture.definition.id(),
              new CreateRunRequest(
                  fixture.definition.revision(),
                  CoreTestFixtures.EMPTY,
                  null,
                  false,
                  "live-run",
                  null,
                  CoreTestFixtures.EMPTY));
      assertTrue(live.isSuccess());
      assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, live.run().id()).state());
      assertEquals(List.of(true, false), seen);
      assertEquals(1, mutations.get());
    } finally {
      fixture.manager.close();
    }
  }

  @Test
  void terminalRunRetainsContextProgressAndOrdersContextValuesBeforeResultValues() {
    var contextArtifact = notice("context-artifact", "from context");
    var resultArtifact = notice("result-artifact", "from result");
    var contextAction = FollowUpAction.openLink("context action", "https://example.test/context");
    var resultAction = FollowUpAction.openLink("result action", "https://example.test/result");
    var progress =
        new RunProgress(
            1.0, 2.0, "working", "halfway", "2026-08-29T12:00:00Z", CoreTestFixtures.EMPTY);
    var summary = new RunSummary("Finished", "All done", "success", CoreTestFixtures.EMPTY);
    var fixture =
        fixture(
            definition("applications.rich", CoreTestFixtures.OBJECT_SCHEMA, null),
            (input, context) -> {
              context.report(progress);
              context.addArtifact(contextArtifact);
              context.addAction(contextAction);
              return OperationResult.succeeded(
                  summary, CoreTestFixtures.EMPTY, List.of(resultArtifact), List.of(resultAction));
            },
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());

    var result =
        fixture.manager.create(
            fixture.definition.id(), request(fixture.definition, CoreTestFixtures.EMPTY, null));

    assertTrue(result.isSuccess());
    Run terminal = awaitTerminal(fixture.manager, result.run().id());
    assertEquals(RunState.SUCCEEDED, terminal.state());
    assertEquals(progress, terminal.progress());
    assertEquals(
        List.of("context-artifact", "result-artifact"),
        terminal.artifacts().stream().map(Artifact::id).toList());
    assertEquals(
        List.of(contextAction.toProtocolMap(), resultAction.toProtocolMap()),
        terminal.actions().stream().map(FollowUpAction::toProtocolMap).toList());
  }

  @Test
  void duplicateArtifactIdsAcrossContextAndResultFailClosed() {
    var fixture =
        fixture(
            definition("applications.duplicate-artifact", CoreTestFixtures.OBJECT_SCHEMA, null),
            (input, context) -> {
              context.addArtifact(notice("duplicate", "context"));
              return OperationResult.succeeded(
                  null, CoreTestFixtures.EMPTY, List.of(notice("duplicate", "result")), List.of());
            },
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());

    assertHandlerFailure(fixture, CoreTestFixtures.EMPTY);
  }

  @Test
  void browserLaunchMustReferenceABrowserArtifactProducedByTheSameRun() {
    var missing =
        fixture(
            definition("applications.browser-missing", CoreTestFixtures.OBJECT_SCHEMA, null),
            (input, context) ->
                OperationResult.succeeded(
                    null,
                    CoreTestFixtures.EMPTY,
                    List.of(),
                    List.of(FollowUpAction.browserLaunch("Open", "session"))),
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());
    assertHandlerFailure(missing, CoreTestFixtures.EMPTY);

    var wrongKind =
        fixture(
            definition("applications.browser-wrong-kind", CoreTestFixtures.OBJECT_SCHEMA, null),
            (input, context) ->
                OperationResult.succeeded(
                    null,
                    CoreTestFixtures.EMPTY,
                    List.of(notice("session", "not a browser launch")),
                    List.of(FollowUpAction.browserLaunch("Open", "session"))),
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());
    assertHandlerFailure(wrongKind, CoreTestFixtures.EMPTY);
  }

  @Test
  void invokeOperationInputMustValidateAgainstTheTargetSchemaAndContainNoTargetSecrets() {
    var targetSchema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "required",
                List.of("token"),
                "properties",
                Map.of("token", Map.of("type", "string")),
                "additionalProperties",
                false));
    var targetHandling =
        new InputHandling(
            List.of(InputHandling.secretRule("/properties/token")), CoreTestFixtures.EMPTY);
    var source = definition("applications.source", CoreTestFixtures.OBJECT_SCHEMA, null);
    var target = definition("applications.target", targetSchema, targetHandling);
    var features = features();
    var operations = new OperationRegistry(features);
    operations.register(
        handler(target, (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY)));
    operations.register(
        handler(
            source,
            (input, context) ->
                OperationResult.succeeded(
                    null,
                    CoreTestFixtures.EMPTY,
                    List.of(),
                    List.of(
                        FollowUpAction.invokeOperation(
                            "Invalid target input", target.id(), null)))));
    var manager = manager(operations, new InMemoryRunStore(), new NetworkntSchemaValidator());

    var result = manager.create(source.id(), request(source, CoreTestFixtures.EMPTY, null));

    Run terminal = awaitTerminal(manager, result.run().id());
    assertEquals(RunState.FAILED, terminal.state());
    assertEquals("urn:gauntlet:problem:handler-failed", terminal.problem().type());
  }

  @Test
  void schemaInvalidInputDoesNotDispatchFrameworkBinding() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "required",
                List.of("name"),
                "properties",
                Map.of("name", Map.of("type", "string")),
                "additionalProperties",
                false));
    var definition = definition("applications.binding-preflight", schema, null);
    var bindingCalls = new AtomicInteger();
    var handlerCalls = new AtomicInteger();
    var operations = new OperationRegistry(features());
    operations.register(
        new OperationHandler<>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public List<ValidationError> validateInput(JsonObject input) {
            bindingCalls.incrementAndGet();
            return List.of();
          }

          @Override
          public OperationResult execute(JsonObject input, RunContext context) {
            handlerCalls.incrementAndGet();
            return OperationResult.succeeded(CoreTestFixtures.EMPTY);
          }
        });

    var result =
        manager(operations, new InMemoryRunStore(), new NetworkntSchemaValidator())
            .create(definition.id(), request(definition, CoreTestFixtures.EMPTY, null));

    assertFalse(result.isSuccess());
    assertEquals(422, result.problem().status());
    assertEquals(0, bindingCalls.get());
    assertEquals(0, handlerCalls.get());
  }

  @Test
  void secretGuardRejectsSubstringsScalarCollisionsKeysAndProducerDiagnostics() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "properties",
                Map.of("credentials", Map.of("$ref", "#/$defs/credentials")),
                "$defs",
                Map.of("credentials", Map.of("type", "object"))));
    var handling =
        new InputHandling(
            List.of(InputHandling.secretRule("/$defs/credentials")), CoreTestFixtures.EMPTY);
    var input =
        JsonOwnership.object(
            Map.of(
                "credentials",
                Map.of(
                    "token",
                    "secret-token",
                    "secret-key",
                    java.util.Arrays.asList(7, true, null))));
    var leaks =
        List.of(
            JsonOwnership.object(Map.of("value", "prefix secret-token suffix")),
            JsonOwnership.object(Map.of("value", 7)),
            JsonOwnership.object(Map.of("value", true)),
            JsonOwnership.object(java.util.Collections.singletonMap("value", null)),
            JsonOwnership.object(Map.of("secret-key", "safe")));

    for (int index = 0; index < leaks.size(); index++) {
      var definition = definition("applications.secret-" + index, schema, handling);
      JsonObject leak = leaks.get(index);
      var fixture =
          fixture(
              definition,
              (ignored, context) -> OperationResult.succeeded(leak),
              new InMemoryRunStore(),
              new NetworkntSchemaValidator());
      assertHandlerFailure(fixture, input);
    }

    var problemDefinition = definition("applications.secret-problem", schema, handling);
    var problemFixture =
        fixture(
            problemDefinition,
            (ignored, context) ->
                OperationResult.partial(
                    null,
                    CoreTestFixtures.EMPTY,
                    List.of(),
                    List.of(),
                    new Problem(
                        "urn:gauntlet:problem:secret-token",
                        "producer secret-token title",
                        409,
                        "secret-token detail",
                        null,
                        null,
                        List.of(),
                        null,
                        CoreTestFixtures.EMPTY)),
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());
    assertHandlerFailure(problemFixture, input);

    var artifactDefinition = definition("applications.secret-artifact", schema, handling);
    var artifactFixture =
        fixture(
            artifactDefinition,
            (ignored, context) ->
                OperationResult.succeeded(
                    null,
                    CoreTestFixtures.EMPTY,
                    List.of(notice("secret-token", "safe message")),
                    List.of()),
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());
    assertHandlerFailure(artifactFixture, input);
  }

  @Test
  void schemaValidationDiagnosticsAreSanitizedBeforeReturningAProblem() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema", "https://json-schema.org/draft/2020-12/schema",
                "type", "object",
                "properties", Map.of("password", Map.of("type", "string"))));
    var handling =
        new InputHandling(
            List.of(InputHandling.secretRule("/properties/password")), CoreTestFixtures.EMPTY);
    var definition = definition("applications.validation-secret", schema, handling);
    SchemaValidator hostile =
        (ignoredSchema, ignoredValue) ->
            List.of(
                new ValidationError(
                    "/secret-token",
                    "#/secret-token",
                    "secret-token",
                    "value secret-token is invalid",
                    JsonOwnership.object(Map.of("secret-token", "secret-token")),
                    JsonOwnership.object(Map.of("urn:test:diagnostic", "secret-token"))));
    var fixture =
        fixture(
            definition,
            (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY),
            new InMemoryRunStore(),
            hostile);
    var input = JsonOwnership.object(Map.of("password", "secret-token"));

    var result = fixture.manager.create(definition.id(), request(definition, input, null));

    assertFalse(result.isSuccess());
    assertEquals(422, result.problem().status());
    assertFalse(
        CanonicalJson.encodeString(result.problem().toProtocolMap()).contains("secret-token"));
  }

  @Test
  void finalProgressAndSummaryCannotExposeProtectedInput() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema", "https://json-schema.org/draft/2020-12/schema",
                "type", "object",
                "properties", Map.of("password", Map.of("type", "string"))));
    var handling =
        new InputHandling(
            List.of(InputHandling.secretRule("/properties/password")), CoreTestFixtures.EMPTY);
    var input = JsonOwnership.object(Map.of("password", "secret-token"));

    var progressDefinition = definition("applications.progress-secret", schema, handling);
    var progressFixture =
        fixture(
            progressDefinition,
            (ignored, context) -> {
              context.report(
                  new RunProgress(
                      1.0,
                      1.0,
                      "done",
                      "leaked secret-token",
                      "2026-08-29T12:00:00Z",
                      CoreTestFixtures.EMPTY));
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            },
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());
    assertHandlerFailure(progressFixture, input);

    var summaryDefinition = definition("applications.summary-secret", schema, handling);
    var summaryFixture =
        fixture(
            summaryDefinition,
            (ignored, context) ->
                OperationResult.succeeded(
                    new RunSummary(
                        "leaked secret-token", "safe", "success", CoreTestFixtures.EMPTY),
                    CoreTestFixtures.EMPTY,
                    List.of(),
                    List.of()),
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());
    assertHandlerFailure(summaryFixture, input);
  }

  @Test
  void logTimestampsCannotExposeProtectedInput() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "properties",
                Map.of("token", Map.of("type", "string"))));
    var handling =
        new InputHandling(
            List.of(InputHandling.secretRule("/properties/token")), CoreTestFixtures.EMPTY);
    var definition = definition("applications.log-timestamp-secret", schema, handling);
    var input = JsonOwnership.object(Map.of("token", "2026-08-29T12:00:00Z"));
    var artifact =
        new Artifact(
            "log",
            "log",
            null,
            JsonOwnership.object(
                Map.of(
                    "entries",
                    List.of(
                        Map.of(
                            "timestamp",
                            "2026-08-29T12:00:00Z",
                            "level",
                            "info",
                            "message",
                            "safe")))),
            CoreTestFixtures.EMPTY);
    var fixture =
        fixture(
            definition,
            (ignored, context) ->
                OperationResult.succeeded(
                    null, CoreTestFixtures.EMPTY, List.of(artifact), List.of()),
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());

    assertHandlerFailure(fixture, input);
  }

  @Test
  void handlerFailureCorrelationCannotEchoProtectedInput() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "properties",
                Map.of("token", Map.of("type", "string"))));
    var handling =
        new InputHandling(
            List.of(InputHandling.secretRule("/properties/token")), CoreTestFixtures.EMPTY);
    var definition = definition("applications.correlation-secret", schema, handling);
    var fixture =
        fixture(
            definition,
            (ignored, context) -> {
              throw new IllegalStateException("hostile");
            },
            new InMemoryRunStore(),
            new NetworkntSchemaValidator());
    var request =
        new CreateRunRequest(
            definition.revision(),
            JsonOwnership.object(Map.of("token", "secret-correlation")),
            new InvocationContext(
                "secret-correlation", null, null, null, null, CoreTestFixtures.EMPTY),
            false,
            null,
            CoreTestFixtures.EMPTY);

    var result = fixture.manager.create(definition.id(), request);

    assertTrue(result.isSuccess());
    Run terminal = awaitTerminal(fixture.manager, result.run().id());
    assertEquals(RunState.FAILED, terminal.state());
    assertEquals("run-1", terminal.problem().correlationId());
    assertFalse(
        CanonicalJson.encodeString(terminal.toProtocolMap()).contains("secret-correlation"));
  }

  @Test
  void fileRulesResolveReferencedSchemasToTheirConcreteInputLocations() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "required",
                List.of("attachment"),
                "properties",
                Map.of("attachment", Map.of("$ref", "#/$defs/file")),
                "$defs",
                Map.of("file", Map.of("type", "object")),
                "additionalProperties",
                false));
    var handling =
        new InputHandling(
            List.of(InputHandling.fileRule("/$defs/file", false, List.of("text/plain"), 10L)),
            CoreTestFixtures.EMPTY);
    var definition = definition("applications.file-reference", schema, handling);
    var operations = new OperationRegistry(features());
    operations.register(
        handler(definition, (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY)));
    var validated = new AtomicReference<FileReferenceValidator.ValidationRequest>();
    FileReferenceValidator fileValidator =
        request -> {
          validated.set(request);
          return List.of();
        };
    var manager =
        new RunManager(
            operations,
            new InMemoryRunStore(),
            new NetworkntSchemaValidator(),
            fileValidator,
            CoreTestFixtures.SECRET,
            CLOCK,
            () -> "run-file-reference");
    var file =
        new FileReference(
            "upload-1",
            "fixture.txt",
            "text/plain",
            5,
            null,
            "2026-08-29T12:30:00Z",
            CoreTestFixtures.EMPTY);
    var input = JsonOwnership.object(Map.of("attachment", file.toProtocolMap()));

    var result = manager.create(definition.id(), request(definition, input, null));

    assertTrue(result.isSuccess());
    assertEquals(RunState.SUCCEEDED, awaitTerminal(manager, result.run().id()).state());
    assertEquals("/attachment", validated.get().instancePath());
    assertEquals(definition.id(), validated.get().operationId());
    assertEquals(definition.revision(), validated.get().operationRevision());
    assertEquals(file, validated.get().reference());
  }

  @Test
  void malformedFileReferenceMembersAreRejectedWithoutCoercionOrValidatorDispatch() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "required",
                List.of("attachment"),
                "properties",
                Map.of("attachment", Map.of("$ref", "#/$defs/file")),
                "$defs",
                Map.of("file", Map.of("type", "object")),
                "additionalProperties",
                false));
    var handling =
        new InputHandling(
            List.of(InputHandling.fileRule("/$defs/file", false, List.of(), null)),
            CoreTestFixtures.EMPTY);
    var definition = definition("applications.hostile-file-reference", schema, handling);
    var operations = new OperationRegistry(features());
    var handled = new AtomicInteger();
    operations.register(
        handler(
            definition,
            (input, context) -> {
              handled.incrementAndGet();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            }));
    var validated = new AtomicInteger();
    FileReferenceValidator fileValidator =
        request -> {
          validated.incrementAndGet();
          return List.of();
        };
    var manager =
        new RunManager(
            operations,
            new InMemoryRunStore(),
            new NetworkntSchemaValidator(),
            fileValidator,
            CoreTestFixtures.SECRET,
            CLOCK,
            () -> "run-hostile-file-reference");
    List<Map<String, Object>> malformed =
        List.of(
            fileDocument(5L, 7L, CoreTestFixtures.EMPTY),
            fileDocument(5L, null, "not-an-object"),
            fileDocument(5.5d, null, CoreTestFixtures.EMPTY),
            fileDocument(-1L, null, CoreTestFixtures.EMPTY),
            fileDocument(1e21d, null, CoreTestFixtures.EMPTY));

    for (Map<String, Object> document : malformed) {
      JsonObject input = JsonOwnership.object(Map.of("attachment", document));
      var result = manager.create(definition.id(), request(definition, input, null));

      assertFalse(result.isSuccess(), document.toString());
      assertEquals(422, result.problem().status(), document.toString());
    }
    assertEquals(0, validated.get());
    assertEquals(0, handled.get());
  }

  @Test
  void mathematicallyIntegralJsonNumberIsAcceptedAsAFileSizeWithoutTruncation() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "required",
                List.of("attachment"),
                "properties",
                Map.of("attachment", Map.of("$ref", "#/$defs/file")),
                "$defs",
                Map.of("file", Map.of("type", "object")),
                "additionalProperties",
                false));
    var handling =
        new InputHandling(
            List.of(InputHandling.fileRule("/$defs/file", false, List.of(), null)),
            CoreTestFixtures.EMPTY);
    var definition = definition("applications.integral-file-size", schema, handling);
    var operations = new OperationRegistry(features());
    operations.register(
        handler(definition, (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY)));
    var validated = new AtomicReference<FileReference>();
    var manager =
        new RunManager(
            operations,
            new InMemoryRunStore(),
            new NetworkntSchemaValidator(),
            request -> {
              validated.set(request.reference());
              return List.of();
            },
            CoreTestFixtures.SECRET,
            CLOCK,
            () -> "run-integral-file-size");
    JsonObject input =
        JsonOwnership.object(
            Map.of("attachment", fileDocument(5.0d, null, CoreTestFixtures.EMPTY)));

    var result = manager.create(definition.id(), request(definition, input, null));

    assertTrue(result.isSuccess());
    assertEquals(5L, validated.get().sizeBytes());
  }

  @Test
  void hostileStoreLookupsCreatesAndUpdatesFailClosed() {
    var definition = definition("applications.store", CoreTestFixtures.OBJECT_SCHEMA, null);
    var wrongDefinition = definition("applications.wrong", CoreTestFixtures.OBJECT_SCHEMA, null);
    var wrongRun = Run.queued("wrong-run", wrongDefinition, CLOCK.instant());
    var calls = new AtomicInteger();

    RunStore corruptLookup =
        new DelegatingStore() {
          @Override
          public Optional<Run> findByIdempotencyFingerprint(
              String operationId, String fingerprint) {
            return Optional.of(wrongRun);
          }

          @Override
          public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
            calls.incrementAndGet();
            return super.createQueued(run, fingerprint);
          }
        };
    var corruptLookupFixture =
        fixture(
            definition,
            (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY),
            corruptLookup,
            new NetworkntSchemaValidator());
    var corruptLookupResult =
        corruptLookupFixture.manager.create(
            definition.id(), request(definition, CoreTestFixtures.EMPTY, "key"));
    assertFalse(corruptLookupResult.isSuccess());
    assertEquals(500, corruptLookupResult.problem().status());
    assertEquals(0, calls.get());

    for (ThrowPoint point : ThrowPoint.values()) {
      var store = new ThrowingStore(point);
      var fixture =
          fixture(
              definition,
              (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY),
              store,
              new NetworkntSchemaValidator());
      var result =
          fixture.manager.create(
              definition.id(), request(definition, CoreTestFixtures.EMPTY, "key"));
      if (point == ThrowPoint.LOOKUP || point == ThrowPoint.CREATE) {
        assertFalse(result.isSuccess(), point.name());
        assertEquals(500, result.problem().status(), point.name());
      } else {
        assertTrue(result.isSuccess(), point.name());
        assertEquals(RunState.FAILED, awaitTerminal(fixture.manager, result.run().id()).state());
      }
    }
  }

  @Test
  void directRunReadsDistinguishMissingValuesFromStoreFailureOrCorruption() {
    var definition = definition("applications.store-read", CoreTestFixtures.OBJECT_SCHEMA, null);
    var wrongDefinition = definition("applications.other", CoreTestFixtures.OBJECT_SCHEMA, null);
    var wrongRun = Run.queued("wrong-run", wrongDefinition, CLOCK.instant());
    var handler =
        handler(definition, (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY));
    var operations = new OperationRegistry(features());
    operations.register(handler);

    RunStore corrupt =
        new DelegatingStore() {
          @Override
          public Optional<Run> get(String runId) {
            return Optional.of(wrongRun);
          }
        };
    RunStore failing =
        new DelegatingStore() {
          @Override
          public Optional<Run> get(String runId) {
            throw new IllegalStateException("store-secret-sentinel");
          }
        };

    assertThrows(
        IllegalStateException.class,
        () -> manager(operations, corrupt, new NetworkntSchemaValidator()).get("requested-run"));
    assertThrows(
        IllegalStateException.class,
        () -> manager(operations, failing, new NetworkntSchemaValidator()).get("requested-run"));
    assertTrue(
        manager(operations, new InMemoryRunStore(), new NetworkntSchemaValidator())
            .get("missing-run")
            .isEmpty());
    assertTrue(
        manager(operations, new InMemoryRunStore(), new NetworkntSchemaValidator())
            .get("unsafe!run")
            .isEmpty());
  }

  @Test
  void directAndIdempotentStoreReadsRejectInvalidCatalogProjections() {
    var source = definition("applications.stored-source", CoreTestFixtures.OBJECT_SCHEMA, null);
    var targetSchema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                "https://json-schema.org/draft/2020-12/schema",
                "type",
                "object",
                "required",
                List.of("requiredValue"),
                "properties",
                Map.of("requiredValue", Map.of("type", "string")),
                "additionalProperties",
                false));
    var target = definition("applications.stored-target", targetSchema, null);
    var operations = new OperationRegistry(features());
    var handlerCalls = new AtomicInteger();
    operations.register(
        handler(
            source,
            (input, context) -> {
              handlerCalls.incrementAndGet();
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            }));
    operations.register(
        handler(target, (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY)));
    Run running = Run.queued("stored-run", source, CLOCK.instant()).running(CLOCK.instant());
    List<Run> corrupt =
        List.of(
            running.terminal(
                OperationResult.succeeded(
                    new dev.eightlines.gauntlet.core.json.JsonValue.Scalar("wrong-type")),
                CLOCK.instant()),
            running.terminal(
                OperationResult.succeeded(
                    null,
                    null,
                    List.of(),
                    List.of(
                        FollowUpAction.invokeOperation(
                            "Unknown", "applications.missing", CoreTestFixtures.EMPTY))),
                CLOCK.instant()),
            running.terminal(
                OperationResult.succeeded(
                    null,
                    null,
                    List.of(),
                    List.of(FollowUpAction.invokeOperation("Missing input", target.id(), null))),
                CLOCK.instant()),
            new Run(
                running.id(),
                running.operationId(),
                "sha256:" + "0".repeat(64),
                running.sequence(),
                running.state(),
                running.createdAt(),
                running.updatedAt(),
                running.startedAt(),
                running.completedAt(),
                running.progress(),
                running.summary(),
                running.output(),
                running.artifacts(),
                running.actions(),
                running.problem(),
                running.extensions()));

    for (Run candidate : corrupt) {
      RunStore store =
          new DelegatingStore() {
            @Override
            public Optional<Run> get(String runId) {
              return Optional.of(candidate);
            }

            @Override
            public Optional<Run> findByIdempotencyFingerprint(
                String operationId, String fingerprint) {
              return Optional.of(candidate);
            }
          };
      var manager = manager(operations, store, new NetworkntSchemaValidator());

      assertThrows(IllegalStateException.class, () -> manager.get(candidate.id()));
      var replay = manager.create(source.id(), request(source, CoreTestFixtures.EMPTY, "key"));
      assertFalse(replay.isSuccess());
      assertEquals(500, replay.problem().status());
    }
    assertEquals(0, handlerCalls.get());
  }

  @Test
  void cancelledAndTimedOutConstructorsRequireTheirExactTerminalProblems() {
    var definition =
        definition("applications.terminal-problem", CoreTestFixtures.OBJECT_SCHEMA, null);
    Run queued = Run.queued("terminal-problem-run", definition, CLOCK.instant());
    var wrongCancelledProblems =
        List.of(
            new Problem("urn:gauntlet:problem:handler-failed", "Run cancelled", 409),
            new Problem("urn:gauntlet:problem:run-cancelled", "Wrong title", 409),
            new Problem("urn:gauntlet:problem:run-cancelled", "Run cancelled", 500));
    var wrongTimeoutProblems =
        List.of(
            new Problem("urn:gauntlet:problem:handler-failed", "Run timed out", 504),
            new Problem("urn:gauntlet:problem:run-timed-out", "Wrong title", 504),
            new Problem("urn:gauntlet:problem:run-timed-out", "Run timed out", 500));

    for (Problem problem : wrongCancelledProblems) {
      assertThrows(
          IllegalArgumentException.class,
          () -> queued.terminated(RunState.CANCELLED, problem, CLOCK.instant()));
    }
    for (Problem problem : wrongTimeoutProblems) {
      assertThrows(
          IllegalArgumentException.class,
          () -> queued.terminated(RunState.TIMED_OUT, problem, CLOCK.instant()));
    }
  }

  @Test
  void hostileStoreCannotBypassExactCancellationOrTimeoutProblemValidation() throws Exception {
    var definition =
        definition("applications.corrupt-cancelled", CoreTestFixtures.OBJECT_SCHEMA, null);
    var operations = new OperationRegistry(features());
    operations.register(
        handler(definition, (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY)));
    List<Run> corrupted =
        List.of(
            Run.queued("corrupt-cancelled-run", definition, CLOCK.instant())
                .terminated(
                    RunState.CANCELLED,
                    new Problem("urn:gauntlet:problem:run-cancelled", "Run cancelled", 409),
                    CLOCK.instant()),
            Run.queued("corrupt-timeout-run", definition, CLOCK.instant())
                .terminated(
                    RunState.TIMED_OUT,
                    new Problem("urn:gauntlet:problem:run-timed-out", "Run timed out", 504),
                    CLOCK.instant()));
    var problemField = Run.class.getDeclaredField("problem");
    problemField.setAccessible(true);
    for (Run candidate : corrupted) {
      problemField.set(
          candidate, new Problem("urn:gauntlet:problem:handler-failed", "Operation failed", 500));
      RunStore hostile =
          new DelegatingStore() {
            @Override
            public Optional<Run> get(String runId) {
              return Optional.of(candidate);
            }
          };

      assertThrows(
          IllegalStateException.class,
          () -> manager(operations, hostile, new NetworkntSchemaValidator()).get(candidate.id()));
    }
  }

  @Test
  void succeededStoredRunMayOmitItsOptionalOutput() {
    var definition =
        definition("applications.output-optional", CoreTestFixtures.OBJECT_SCHEMA, null);
    var operations = new OperationRegistry(features());
    operations.register(handler(definition, (input, context) -> OperationResult.succeeded(null)));
    Run running =
        Run.queued("stored-no-output", definition, CLOCK.instant()).running(CLOCK.instant());
    Run succeeded = running.terminal(OperationResult.succeeded(null), CLOCK.instant());
    RunStore store =
        new DelegatingStore() {
          @Override
          public Optional<Run> get(String runId) {
            return Optional.of(succeeded);
          }
        };

    assertEquals(
        succeeded,
        manager(operations, store, new NetworkntSchemaValidator())
            .get(succeeded.id())
            .orElseThrow());
  }

  @Test
  void duplicateReservationSnapshotIsRereadAndValidatedAuthoritatively() {
    var definition =
        definition("applications.duplicate-store", CoreTestFixtures.OBJECT_SCHEMA, null);
    var wrong =
        Run.queued(
            "wrong-run",
            definition("applications.other", CoreTestFixtures.OBJECT_SCHEMA, null),
            CLOCK.instant());
    var executed = new AtomicBoolean();
    RunStore store =
        new RunStore() {
          @Override
          public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
            return RunStoreCreateResult.duplicate(wrong);
          }

          @Override
          public Optional<Run> get(String runId) {
            return Optional.of(wrong);
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
    var fixture =
        fixture(
            definition,
            (input, context) -> {
              executed.set(true);
              return OperationResult.succeeded(CoreTestFixtures.EMPTY);
            },
            store,
            new NetworkntSchemaValidator());

    var result =
        fixture.manager.create(definition.id(), request(definition, CoreTestFixtures.EMPTY, "key"));

    assertFalse(result.isSuccess());
    assertEquals(500, result.problem().status());
    assertFalse(executed.get());
  }

  @Test
  void inMemoryStoreRejectsSnapshotTimestampRegression() {
    var definition =
        definition("applications.timeline-store", CoreTestFixtures.OBJECT_SCHEMA, null);
    var store = new InMemoryRunStore();
    var queued = Run.queued("run-timeline", definition, Instant.parse("2026-08-29T12:00:00Z"));
    assertTrue(store.createQueued(queued, Optional.empty()).created());
    var running = queued.running(Instant.parse("2026-08-29T12:00:10Z"));
    assertTrue(store.updateExactSequence(running, 0));
    var regressed =
        new Run(
            running.id(),
            running.operationId(),
            running.operationRevision(),
            2,
            RunState.RUNNING,
            running.createdAt(),
            "2026-08-29T12:00:05Z",
            "2026-08-29T12:00:05Z",
            null,
            null,
            null,
            null,
            List.of(),
            List.of(),
            null,
            CoreTestFixtures.EMPTY);

    assertFalse(store.updateExactSequence(regressed, 1));
    assertEquals(running, store.get(running.id()).orElseThrow());
  }

  @Test
  void aRegressingClockDuringTheRunningTransitionFailsClosed() {
    var definition =
        definition("applications.regressing-clock", CoreTestFixtures.OBJECT_SCHEMA, null);
    var operations = new OperationRegistry(features());
    operations.register(
        handler(definition, (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY)));
    var clock =
        new SequenceClock(
            List.of(
                Instant.parse("2026-08-29T12:00:00Z"),
                Instant.parse("2026-08-29T12:00:10Z"),
                Instant.parse("2026-08-29T12:00:05Z")),
            ZoneOffset.UTC);
    var manager =
        new RunManager(
            operations,
            new InMemoryRunStore(),
            new NetworkntSchemaValidator(),
            null,
            CoreTestFixtures.SECRET,
            clock,
            () -> "run-regressing-clock");

    var result = manager.create(definition.id(), request(definition, CoreTestFixtures.EMPTY, null));

    assertTrue(result.isSuccess());
    Run terminal = awaitTerminal(manager, result.run().id());
    assertEquals(RunState.FAILED, terminal.state());
    assertEquals(500, terminal.problem().status());
  }

  @Test
  void falseStoreCompareAndSetFailsClosedInsteadOfLeavingANonTerminalRun() {
    for (int rejectedUpdate : List.of(1, 2)) {
      var definition =
          definition(
              "applications.false-cas-" + rejectedUpdate, CoreTestFixtures.OBJECT_SCHEMA, null);
      var updates = new AtomicInteger();
      var store =
          new DelegatingStore() {
            @Override
            public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
              if (updates.incrementAndGet() == rejectedUpdate) return false;
              return super.updateExactSequence(run, expectedPreviousSequence);
            }
          };
      var fixture =
          fixture(
              definition,
              (input, context) -> OperationResult.succeeded(CoreTestFixtures.EMPTY),
              store,
              new NetworkntSchemaValidator());

      var result =
          fixture.manager.create(
              definition.id(), request(definition, CoreTestFixtures.EMPTY, null));

      assertTrue(result.isSuccess());
      Run terminal = awaitTerminal(fixture.manager, result.run().id());
      assertEquals(RunState.FAILED, terminal.state());
      assertEquals(500, terminal.problem().status());
    }
  }

  private static void assertHandlerFailure(Fixture fixture, JsonObject input) {
    var result =
        fixture.manager.create(fixture.definition.id(), request(fixture.definition, input, null));
    assertTrue(result.isSuccess());
    Run terminal = awaitTerminal(fixture.manager, result.run().id());
    assertEquals(RunState.FAILED, terminal.state());
    assertEquals("urn:gauntlet:problem:handler-failed", terminal.problem().type());
    assertFalse(CanonicalJson.encodeString(terminal.toProtocolMap()).contains("secret-token"));
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

  private static Artifact notice(String id, String message) {
    return new Artifact(
        id,
        "notice",
        null,
        JsonOwnership.object(Map.of("level", "info", "message", message)),
        CoreTestFixtures.EMPTY);
  }

  private static CreateRunRequest request(
      OperationDefinition definition, JsonObject input, String idempotencyKey) {
    return new CreateRunRequest(
        definition.revision(), input, null, false, idempotencyKey, CoreTestFixtures.EMPTY);
  }

  private static OperationDefinition definition(
      String id, JsonObject inputSchema, InputHandling inputHandling) {
    return new OperationDefinition(
        id,
        "applications",
        "Fixture operation",
        null,
        inputSchema,
        inputHandling,
        null,
        null,
        List.of(),
        List.of(),
        new ExecutionPolicy(
            OperationImpact.WRITE,
            false,
            false,
            Idempotency.OPTIONAL,
            false,
            null,
            "allow",
            CoreTestFixtures.EMPTY),
        new OperationOutput(CoreTestFixtures.OBJECT_SCHEMA, null, CoreTestFixtures.EMPTY),
        null,
        0,
        List.of(),
        null,
        CoreTestFixtures.EMPTY);
  }

  private static Map<String, Object> fileDocument(
      Number sizeBytes, Object sha256, Object extensions) {
    var file = new java.util.LinkedHashMap<String, Object>();
    file.put("kind", "file");
    file.put("uploadId", "upload-1");
    file.put("name", "fixture.txt");
    file.put("mediaType", "text/plain");
    file.put("sizeBytes", sizeBytes);
    if (sha256 != null) file.put("sha256", sha256);
    file.put("expiresAt", "2026-08-29T12:30:00Z");
    file.put("extensions", extensions);
    return file;
  }

  private static FeatureRegistry features() {
    var features = new FeatureRegistry();
    features.register(
        new FeatureDefinition("applications", "Applications", null, 0, CoreTestFixtures.EMPTY));
    return features;
  }

  private static OperationHandler<JsonObject> handler(
      OperationDefinition definition, HandlerBody body) {
    return new OperationHandler<>() {
      @Override
      public OperationDefinition definition() {
        return definition;
      }

      @Override
      public OperationResult execute(JsonObject input, RunContext context) throws Exception {
        return body.execute(input, context);
      }
    };
  }

  private static Fixture fixture(
      OperationDefinition definition, HandlerBody body, RunStore store, SchemaValidator validator) {
    var operations = new OperationRegistry(features());
    operations.register(handler(definition, body));
    return new Fixture(manager(operations, store, validator), definition);
  }

  private static RunManager manager(
      OperationRegistry operations, RunStore store, SchemaValidator validator) {
    var ids = new AtomicInteger();
    return new RunManager(
        operations,
        store,
        validator,
        null,
        CoreTestFixtures.SECRET,
        CLOCK,
        () -> "run-" + ids.incrementAndGet());
  }

  private enum ThrowPoint {
    LOOKUP,
    CREATE,
    RUNNING_UPDATE,
    TERMINAL_UPDATE
  }

  private static class DelegatingStore implements RunStore {
    private final InMemoryRunStore delegate = new InMemoryRunStore();

    @Override
    public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
      return delegate.createQueued(run, fingerprint);
    }

    @Override
    public Optional<Run> get(String runId) {
      return delegate.get(runId);
    }

    @Override
    public Optional<Run> findByIdempotencyFingerprint(String operationId, String fingerprint) {
      return delegate.findByIdempotencyFingerprint(operationId, fingerprint);
    }

    @Override
    public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
      return delegate.updateExactSequence(run, expectedPreviousSequence);
    }
  }

  private static final class ThrowingStore extends DelegatingStore {
    private final ThrowPoint point;
    private int updates;

    private ThrowingStore(ThrowPoint point) {
      this.point = point;
    }

    @Override
    public Optional<Run> findByIdempotencyFingerprint(String operationId, String fingerprint) {
      if (point == ThrowPoint.LOOKUP) {
        throw new IllegalStateException("hostile lookup");
      }
      return super.findByIdempotencyFingerprint(operationId, fingerprint);
    }

    @Override
    public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
      if (point == ThrowPoint.CREATE) {
        throw new IllegalStateException("hostile create");
      }
      return super.createQueued(run, fingerprint);
    }

    @Override
    public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
      updates++;
      if ((point == ThrowPoint.RUNNING_UPDATE && updates == 1)
          || (point == ThrowPoint.TERMINAL_UPDATE && updates == 2)) {
        throw new IllegalStateException("hostile update");
      }
      return super.updateExactSequence(run, expectedPreviousSequence);
    }
  }

  @FunctionalInterface
  private interface HandlerBody {
    OperationResult execute(JsonObject input, RunContext context) throws Exception;
  }

  private record Fixture(RunManager manager, OperationDefinition definition) {}

  private static final class SequenceClock extends Clock {
    private final List<Instant> instants;
    private final ZoneId zone;
    private final AtomicInteger index = new AtomicInteger();

    private SequenceClock(List<Instant> instants, ZoneId zone) {
      this.instants = List.copyOf(instants);
      this.zone = zone;
    }

    @Override
    public ZoneId getZone() {
      return zone;
    }

    @Override
    public Clock withZone(ZoneId requestedZone) {
      return requestedZone.equals(zone) ? this : new SequenceClock(instants, requestedZone);
    }

    @Override
    public Instant instant() {
      int current = index.getAndIncrement();
      return instants.get(Math.min(current, instants.size() - 1));
    }
  }
}
