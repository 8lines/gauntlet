package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.schema.ProtocolSemantics;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ProtocolSemanticsTest {
  @Test
  void allFiftySixDocumentPredicatesMatchTheStrictLoadedArtifact() {
    SemanticVectorLoader.Loaded loaded = SemanticVectorLoader.load();
    var requiredSafetyVectors =
        new HashSet<>(
            Set.of(
                "manifest.environment.production-name",
                "operation.destructive.valid",
                "operation.destructive.missing-confirmation",
                "operation.destructive.optional-idempotency"));
    int outcomes = 0;
    for (JsonObject vector : objects(loaded.artifact().get("documentVectors"))) {
      SemanticVectorLoader.MaterializedDocument materialized =
          SemanticVectorLoader.materializeDocumentVector(loaded, vector);
      requiredSafetyVectors.remove(materialized.id());
      boolean actual =
          switch (materialized.predicate()) {
            case "manifest" -> ProtocolSemantics.manifestMapIsValid(materialized.document());
            case "operation" -> ProtocolSemantics.operationMapIsValid(materialized.document());
            case "resolve" ->
                ProtocolSemantics.resolveMapsAreValid(
                    materialized.request(), materialized.response());
            default -> throw new AssertionError("unknown predicate");
          };
      assertEquals(materialized.expected(), actual, materialized.id());
      outcomes++;
    }
    assertEquals(56, outcomes);
    assertEquals(Set.of(), requiredSafetyVectors);
  }

  @Test
  void allFiftyFourPresetCasesMatchTheirPinnedRevisionsAndOutcomes() {
    SemanticVectorLoader.Loaded loaded = SemanticVectorLoader.load();
    int outcomes = 0;
    for (JsonObject suite : objects(loaded.artifact().get("presetSuites"))) {
      for (JsonObject presetCase : objects(suite.get("cases"))) {
        SemanticVectorLoader.MaterializedOperation materialized =
            SemanticVectorLoader.materializePresetCase(loaded, suite, presetCase);
        assertEquals(
            materialized.expected(),
            ProtocolSemantics.operationMapIsValid(materialized.operation()),
            materialized.id());
        outcomes++;
      }
    }
    assertEquals(54, outcomes);
  }

  @Test
  void allSevenGeneratedWorkloadsMatchPinnedBytesRevisionsAndOutcomes() {
    SemanticVectorLoader.Loaded loaded = SemanticVectorLoader.load();
    int outcomes = 0;
    for (JsonObject workload : objects(loaded.artifact().get("workloads"))) {
      SemanticVectorLoader.MaterializedOperation materialized =
          SemanticVectorLoader.materializeWorkload(loaded, workload);
      assertEquals(
          materialized.expected(),
          ProtocolSemantics.operationMapIsValid(materialized.operation()),
          materialized.id());
      outcomes++;
    }
    assertEquals(7, outcomes);
  }

  private static List<JsonObject> objects(JsonValue value) {
    if (!(value instanceof JsonList list)) {
      throw new AssertionError("expected vector array");
    }
    return list.values().stream()
        .map(
            item -> {
              if (item instanceof JsonObject object) {
                return object;
              }
              throw new AssertionError("expected vector object");
            })
        .toList();
  }
}
