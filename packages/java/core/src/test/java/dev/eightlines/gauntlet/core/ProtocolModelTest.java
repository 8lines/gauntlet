package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.ApplicationMetadata;
import dev.eightlines.gauntlet.core.model.Artifact;
import dev.eightlines.gauntlet.core.model.ConfirmationAcknowledgement;
import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.model.DataSourceItem;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;
import dev.eightlines.gauntlet.core.model.EnvironmentDescriptor;
import dev.eightlines.gauntlet.core.model.EnvironmentKind;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.FollowUpAction;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.ProtocolId;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunEvent;
import dev.eightlines.gauntlet.core.model.RunProgress;
import dev.eightlines.gauntlet.core.model.RunState;
import dev.eightlines.gauntlet.core.model.SessionLaunchResponse;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ProtocolModelTest {
  private static final String REVISION = "sha256:" + "a".repeat(64);

  @Test
  void environmentKindsHaveExactlyTheSevenProtocolWireValues() {
    assertEquals(
        List.of("development", "test", "qa", "staging", "uat", "preview", "sandbox"),
        java.util.Arrays.stream(EnvironmentKind.values()).map(EnvironmentKind::wireValue).toList());
    for (var kind : EnvironmentKind.values()) {
      assertEquals(kind, EnvironmentKind.fromWireValue(kind.wireValue()));
    }
    for (String invalid : List.of("production", "dev", "TEST", "")) {
      var error =
          assertThrows(
              IllegalArgumentException.class, () -> EnvironmentKind.fromWireValue(invalid));
      assertEquals("Invalid non-production environment descriptor", error.getMessage());
    }
  }

  @Test
  void environmentDescriptorIsClosedImmutableAndUsesOneGenericFailure() {
    var environment = new EnvironmentDescriptor("product-demo", EnvironmentKind.PREVIEW);
    assertEquals(
        Map.of("name", "product-demo", "kind", "preview"),
        JsonOwnership.toJava(environment.toProtocolMap()));
    assertEquals(
        environment,
        EnvironmentDescriptor.fromProtocolValue(
            JsonOwnership.object(Map.of("name", "product-demo", "kind", "preview"))));

    List<Runnable> invalid =
        List.of(
            () -> new EnvironmentDescriptor(null, EnvironmentKind.TEST),
            () -> new EnvironmentDescriptor("unsafe/name", EnvironmentKind.TEST),
            () -> new EnvironmentDescriptor("fixture-test", null),
            () -> EnvironmentKind.fromWireValue(null),
            () -> EnvironmentDescriptor.fromProtocolValue(JsonOwnership.ownRuntime("fixture-test")),
            () ->
                EnvironmentDescriptor.fromProtocolValue(
                    JsonOwnership.object(Map.of("name", "fixture-test"))),
            () ->
                EnvironmentDescriptor.fromProtocolValue(
                    JsonOwnership.object(
                        Map.of("name", "fixture-test", "kind", "test", "extra", true))),
            () ->
                EnvironmentDescriptor.fromProtocolValue(
                    JsonOwnership.object(Map.of("name", 1, "kind", "test"))),
            () ->
                EnvironmentDescriptor.fromProtocolValue(
                    JsonOwnership.object(Map.of("name", "fixture-test", "kind", "production"))));
    for (Runnable candidate : invalid) {
      var error = assertThrows(IllegalArgumentException.class, candidate::run);
      assertEquals("Invalid non-production environment descriptor", error.getMessage());
    }
  }

  @Test
  void rejectsProductionLikeEnvironmentNamesAsSeparatedTokensOnly() {
    for (String name :
        List.of(
            "prod",
            "portal-prod",
            "PRODUCTION",
            "live_eu",
            "sandbox:prod:blue",
            "non-production")) {
      var error =
          assertThrows(
              IllegalArgumentException.class,
              () -> new EnvironmentDescriptor(name, EnvironmentKind.TEST));
      assertEquals("Invalid non-production environment descriptor", error.getMessage());
    }
    assertEquals(
        "product-demo", new EnvironmentDescriptor("product-demo", EnvironmentKind.PREVIEW).name());
    assertEquals("lively", new EnvironmentDescriptor("lively", EnvironmentKind.TEST).name());
  }

  @Test
  void serializesRevisionBoundConfirmationAndCanonicalCreateRunOrder() {
    var extensionSource = new LinkedHashMap<String, Object>();
    extensionSource.put("urn:fixture:confirmation", Map.of("owned", true));
    var acknowledgement =
        new ConfirmationAcknowledgement(
            "application-access-review",
            REVISION,
            OperationImpact.WRITE,
            JsonOwnership.object(extensionSource));
    extensionSource.clear();

    assertEquals(
        Map.of(
            "operationId",
            "application-access-review",
            "operationRevision",
            REVISION,
            "impact",
            "write",
            "extensions",
            Map.of("urn:fixture:confirmation", Map.of("owned", true))),
        JsonOwnership.toJava(acknowledgement.toProtocolMap()));

    var requestExtensions = JsonOwnership.object(Map.of("urn:fixture:request", true));
    var request =
        new CreateRunRequest(
            REVISION,
            CoreTestFixtures.EMPTY,
            null,
            true,
            "replay-key",
            acknowledgement,
            requestExtensions);
    assertEquals(
        List.of(
            "operationRevision", "input", "dryRun", "idempotencyKey", "confirmation", "extensions"),
        List.copyOf(request.toProtocolMap().values().keySet()));
    assertEquals(acknowledgement.toProtocolMap(), request.toProtocolMap().get("confirmation"));

    var compatibilityRequest =
        new CreateRunRequest(
            REVISION, CoreTestFixtures.EMPTY, null, false, null, CoreTestFixtures.EMPTY);
    assertEquals(null, compatibilityRequest.confirmation());
  }

  @Test
  void applicationMetadataRequiresAndSerializesStructuredEnvironment() {
    var application =
        new ApplicationMetadata(
            "fixture-app", "Fixture App", CoreTestFixtures.ENVIRONMENT, CoreTestFixtures.EMPTY);
    assertEquals(
        Map.of(
            "id",
            "fixture-app",
            "label",
            "Fixture App",
            "environment",
            Map.of("name", "fixture-test", "kind", "test")),
        JsonOwnership.toJava(application.toProtocolMap()));
    assertThrows(
        NullPointerException.class,
        () -> new ApplicationMetadata("fixture-app", "Fixture App", null, CoreTestFixtures.EMPTY));
  }

  @Test
  void destructiveExecutionRequiresConfirmationAndRequiredIdempotency() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new ExecutionPolicy(
                OperationImpact.DESTRUCTIVE,
                false,
                false,
                Idempotency.REQUIRED,
                false,
                null,
                null,
                CoreTestFixtures.EMPTY));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new ExecutionPolicy(
                OperationImpact.DESTRUCTIVE,
                true,
                false,
                Idempotency.OPTIONAL,
                false,
                null,
                null,
                CoreTestFixtures.EMPTY));
    assertEquals(
        "destructive",
        new ExecutionPolicy(
                OperationImpact.DESTRUCTIVE,
                true,
                false,
                Idempotency.REQUIRED,
                false,
                null,
                null,
                CoreTestFixtures.EMPTY)
            .impact()
            .wireValue());
  }

  @Test
  void protocolIdsAndResolveResultsUseCanonicalPortableShapes() {
    assertThrows(IllegalArgumentException.class, () -> ProtocolId.of("a/b"));
    assertEquals("optional", Idempotency.OPTIONAL.wireValue());
    assertEquals(Idempotency.OPTIONAL, Idempotency.fromWireValue("optional"));

    var response =
        new DataSourceResolveResponse(
            List.of(
                new DataSourceResolveResponse.Result(
                    "app-1",
                    new DataSourceItem(
                        "app-1",
                        "Application 1",
                        null,
                        null,
                        false,
                        JsonOwnership.object(Map.of()),
                        JsonOwnership.object(Map.of()))),
                new DataSourceResolveResponse.Result("", null)),
            JsonOwnership.object(Map.of()));

    assertEquals(
        List.of("app-1", ""),
        response.results().stream().map(DataSourceResolveResponse.Result::value).toList());
    assertEquals(
        "write",
        new ExecutionPolicy(
                OperationImpact.WRITE,
                true,
                false,
                Idempotency.REQUIRED,
                false,
                30,
                "forbid",
                JsonOwnership.object(Map.of()))
            .toProtocolMap()
            .get("impact")
            .unwrap());
  }

  @Test
  void protocolCollectionsAreDefensivelyOwnedAndValidated() {
    var source = new java.util.ArrayList<>(List.of("tc-schema-core@1"));
    var requirements =
        new dev.eightlines.gauntlet.core.model.ProtocolRequirements(
            source, List.of("tc-uploads@1"));
    source.clear();
    assertEquals(List.of("tc-schema-core@1"), requirements.profiles());
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new dev.eightlines.gauntlet.core.model.ProtocolRequirements(List.of("bad"), List.of()));
    assertTrue(requirements.toProtocolMap().values().containsKey("profiles"));
  }

  @Test
  void artifactsAreAClosedKindSpecificUnion() {
    var empty = JsonOwnership.object(Map.of());
    assertThrows(
        IllegalArgumentException.class,
        () -> new Artifact("artifact-1", "unknown", null, empty, empty));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new Artifact(
                "artifact-1",
                "notice",
                null,
                JsonOwnership.object(Map.of("level", "info")),
                empty));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new Artifact(
                "artifact-1",
                "metrics",
                null,
                JsonOwnership.object(
                    Map.of("metrics", List.of(Map.of("name", "count", "value", "not-a-number")))),
                empty));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new Artifact(
                "artifact-1",
                "timeline",
                null,
                JsonOwnership.object(
                    Map.of(
                        "items",
                        List.of(
                            Map.of(
                                "timestamp", "2026-02-30T12:00:00Z",
                                "title", "Impossible date")))),
                empty));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new Artifact(
                "artifact-1",
                "urn:vendor:custom",
                null,
                JsonOwnership.object(Map.of("unexpected", true)),
                empty));

    var custom =
        new Artifact(
            "artifact-1",
            "urn:vendor:custom",
            "Custom",
            JsonOwnership.object(Map.of("data", Map.of("ok", true))),
            empty);
    assertEquals("urn:vendor:custom", custom.kind());
  }

  @Test
  void httpUrlsMustBeAbsoluteAndSessionTimestampsMustBeStrict() {
    var empty = JsonOwnership.object(Map.of());
    var clock = Clock.fixed(Instant.parse("2026-08-29T12:00:00Z"), ZoneOffset.UTC);
    assertThrows(
        IllegalArgumentException.class, () -> FollowUpAction.openLink("Relative", "http:relative"));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new SessionLaunchResponse(
                "https://example.test/session", "2026-02-30T12:00:00Z", true, empty));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new SessionLaunchResponse(
                "https://user:password@example.test/session",
                "2026-08-29T12:00:01Z",
                true,
                empty,
                clock));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new SessionLaunchResponse(
                "https://example.test/session", "2026-08-29T12:00:00Z", true, empty, clock));
    var session =
        new SessionLaunchResponse(
            "https://example.test/session", "2026-08-29T12:00:01Z", true, empty, clock);
    assertEquals("https://example.test/session", session.url());
    assertThrows(
        IllegalArgumentException.class,
        () -> new SessionLaunchResponse("http:relative", "2026-08-29T12:00:00Z", true, empty));
  }

  @Test
  void runTimestampsCannotRegressOrContradictLifecycleOrder() {
    var empty = JsonOwnership.object(Map.of());
    var revision = "sha256:" + "a".repeat(64);
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new Run(
                "run-regressed",
                "applications.test",
                revision,
                0,
                RunState.QUEUED,
                "2026-08-29T12:00:01Z",
                "2026-08-29T12:00:00Z",
                null,
                null,
                null,
                null,
                null,
                List.of(),
                List.of(),
                null,
                empty));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new Run(
                "run-started-early",
                "applications.test",
                revision,
                1,
                RunState.RUNNING,
                "2026-08-29T12:00:01Z",
                "2026-08-29T12:00:02Z",
                "2026-08-29T12:00:00Z",
                null,
                null,
                null,
                null,
                List.of(),
                List.of(),
                null,
                empty));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new Run(
                "run-completed-late",
                "applications.test",
                revision,
                2,
                RunState.SUCCEEDED,
                "2026-08-29T12:00:00Z",
                "2026-08-29T12:00:02Z",
                "2026-08-29T12:00:01Z",
                "2026-08-29T12:00:03Z",
                null,
                null,
                null,
                List.of(),
                List.of(),
                null,
                empty));
  }

  @Test
  void extensionMembersRequireNamespacedUrnKeys() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new ApplicationMetadata(
                "application",
                "Application",
                CoreTestFixtures.ENVIRONMENT,
                JsonOwnership.object(Map.of("not-namespaced", true))));
    var application =
        new ApplicationMetadata(
            "application",
            "Application",
            CoreTestFixtures.ENVIRONMENT,
            JsonOwnership.object(Map.of("urn:vendor:feature", true)));
    assertTrue(application.toProtocolMap().values().containsKey("extensions"));
  }

  @Test
  void runEventSequenceIsBoundedToTheWireSafeIntegerDomain() {
    var definition = CoreTestFixtures.fixtureDefinition("applications.event");
    var run = Run.queued("run-event", definition, Instant.parse("2026-08-29T12:00:00Z"));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new RunEvent(
                "event-1",
                9_007_199_254_740_992L,
                "2026-08-29T12:00:00Z",
                "run.updated",
                run,
                JsonOwnership.object(Map.of())));
  }

  @Test
  void progressValuesRespectTheSharedNonnegativeOrderedBounds() {
    var empty = JsonOwnership.object(Map.of());
    String updatedAt = "2026-08-29T12:00:00Z";

    assertThrows(
        IllegalArgumentException.class,
        () -> new RunProgress(-1d, null, null, null, updatedAt, empty));
    assertThrows(
        IllegalArgumentException.class,
        () -> new RunProgress(null, -1d, null, null, updatedAt, empty));
    assertThrows(
        IllegalArgumentException.class,
        () -> new RunProgress(2d, 1d, null, null, updatedAt, empty));
    assertEquals(1d, new RunProgress(1d, 2d, null, null, updatedAt, empty).current());
  }

  @Test
  void stringBoundsMatchThePublishedWireSchemasWithoutExtraWhitespaceRules() {
    var empty = JsonOwnership.object(Map.of());
    assertEquals(
        " ",
        new ApplicationMetadata("application", " ", CoreTestFixtures.ENVIRONMENT, empty).label());
    assertEquals(
        "",
        new dev.eightlines.gauntlet.core.model.AdapterDiagnostic("warning", "", "", null, empty)
            .code());
    assertEquals(
        "",
        new dev.eightlines.gauntlet.core.model.OperationPreset(
                "preset", "", null, empty, List.of(), empty)
            .label());
    assertEquals(
        " ",
        new dev.eightlines.gauntlet.core.model.Problem("urn:gauntlet:problem:fixture", " ", 400)
            .title());
    assertThrows(
        IllegalArgumentException.class,
        () -> new ApplicationMetadata("application", "", CoreTestFixtures.ENVIRONMENT, empty));
  }
}
