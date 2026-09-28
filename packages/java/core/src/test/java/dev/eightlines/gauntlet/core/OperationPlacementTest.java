package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.*;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.*;
import dev.eightlines.gauntlet.core.schema.PlacementRules;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class OperationPlacementTest {
  private static OperationDefinition operation(List<OperationPlacement> placements) {
    return new OperationDefinition(
        "test.pay",
        "test",
        "Pay",
        null,
        JsonOwnership.object(
            Map.of(
                "$schema", "https://json-schema.org/draft/2020-12/schema",
                "type", "object",
                "properties",
                    Map.of(
                        "orderId", Map.of("type", "string"),
                        "token", Map.of("type", "string"),
                        "tags", Map.of("type", "array", "items", Map.of("type", "string"))))),
        new InputHandling(
            List.of(
                JsonOwnership.object(
                    Map.of(
                        "kind", "secret",
                        "schemaPointer", "/properties/token",
                        "retention", "none"))),
            CoreTestFixtures.EMPTY),
        null,
        null,
        List.of(),
        List.of(),
        new ExecutionPolicy(
            OperationImpact.READ,
            false,
            false,
            Idempotency.OPTIONAL,
            false,
            null,
            null,
            CoreTestFixtures.EMPTY),
        new OperationOutput(
            JsonOwnership.object(Map.of("$schema", "https://json-schema.org/draft/2020-12/schema")),
            null,
            CoreTestFixtures.EMPTY),
        null,
        0,
        List.of(),
        null,
        CoreTestFixtures.EMPTY,
        placements);
  }

  @Test
  void placementsAreEmittedAndHashed() {
    var plain = operation(List.of());
    var placed =
        operation(List.of(OperationPlacement.subject("order", Map.of("/orderId", "orderId"))));
    assertNull(plain.toProtocolMap().get("placements"));
    assertEquals(
        listOf(
            Map.of(
                "kind",
                "subject",
                "subjectType",
                "order",
                "bindings",
                Map.of("/orderId", "orderId"))),
        placed.toProtocolMap().get("placements"));
    assertNotEquals(plain.revision(), placed.revision());
    assertEquals(Map.of("kind", "global"), OperationPlacement.global().toProtocolMap());
  }

  @Test
  void invalidPlacementsAreRejected() {
    for (var placements :
        List.of(
            List.of(OperationPlacement.subject("order", Map.of("/missing", "orderId"))),
            List.of(OperationPlacement.subject("order", Map.of("/token", "token"))),
            List.of(OperationPlacement.subject("order", Map.of("/tags", "tags"))),
            List.of(OperationPlacement.global(), OperationPlacement.global()),
            List.of(
                OperationPlacement.subject("order", Map.of()),
                OperationPlacement.subject("order", Map.of())))) {
      assertThrows(
          IllegalArgumentException.class, () -> operation(placements), placements.toString());
    }
    assertThrows(
        IllegalArgumentException.class, () -> OperationPlacement.subject("bad id", Map.of()));
  }

  @Test
  void bindingsKeepTheirInsertionOrder() {
    var bindings = new java.util.LinkedHashMap<String, String>();
    for (int index = 20; index > 0; index--) bindings.put("/field" + index, "key" + index);
    var placement = OperationPlacement.subject("order", bindings);
    assertEquals(List.copyOf(bindings.keySet()), List.copyOf(placement.bindings().keySet()));
    @SuppressWarnings("unchecked")
    var emitted = (Map<String, String>) placement.toProtocolMap().get("bindings");
    assertEquals(List.copyOf(bindings.keySet()), List.copyOf(emitted.keySet()));
    bindings.put("/late", "late");
    assertFalse(placement.bindings().containsKey("/late"));
    assertThrows(UnsupportedOperationException.class, () -> placement.bindings().put("/x", "x"));
  }

  @Test
  void theCanonicalConstructorRejectsInconsistentPlacements() {
    for (Runnable invalid :
        List.<Runnable>of(
            () -> new OperationPlacement("page", null, Map.of()),
            () -> new OperationPlacement(null, null, Map.of()),
            () -> new OperationPlacement("global", "order", Map.of()),
            () -> new OperationPlacement("global", null, Map.of("/orderId", "orderId")),
            () -> new OperationPlacement("subject", null, Map.of()),
            () -> new OperationPlacement("subject", "bad id", Map.of()),
            () -> new OperationPlacement("subject", "order", Map.of("/orderId", "bad key")))) {
      assertThrows(IllegalArgumentException.class, invalid::run);
    }
    assertEquals(OperationPlacement.global(), new OperationPlacement("global", null, null));
    assertEquals(
        OperationPlacement.subject("order", Map.of("/orderId", "orderId")),
        new OperationPlacement("subject", "order", Map.of("/orderId", "orderId")));
  }

  @Test
  void escapedPointersResolveToTheDecodedProperty() {
    var schema =
        JsonOwnership.object(
            Map.of("type", "object", "properties", Map.of("a/b", Map.of("type", "string"))));
    var escaped =
        listOf(Map.of("kind", "subject", "subjectType", "s", "bindings", Map.of("/a~1b", "k")));
    var literal =
        listOf(Map.of("kind", "subject", "subjectType", "s", "bindings", Map.of("/a/b", "k")));
    assertTrue(PlacementRules.areValid(schema, List.of(), escaped));
    assertFalse(PlacementRules.areValid(schema, List.of(), literal));
  }

  @Test
  void combinatorGuardedLeafIsRejected() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "type",
                "object",
                "properties",
                Map.of(
                    "message",
                    Map.of("type", "string", "anyOf", List.of(Map.of("type", "string"))))));
    var placements =
        listOf(
            Map.of(
                "kind", "subject", "subjectType", "s", "bindings", Map.of("/message", "message")));
    assertFalse(PlacementRules.areValid(schema, List.of(), placements));
  }

  @Test
  void combinatorGuardedIntermediateNodeIsRejected() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "type",
                "object",
                "properties",
                Map.of(
                    "parent",
                    Map.of(
                        "type", "object",
                        "oneOf", List.of(Map.of("type", "object")),
                        "properties", Map.of("child", Map.of("type", "string"))))));
    var placements =
        listOf(
            Map.of(
                "kind",
                "subject",
                "subjectType",
                "s",
                "bindings",
                Map.of("/parent/child", "child")));
    assertFalse(PlacementRules.areValid(schema, List.of(), placements));
  }

  private static JsonList listOf(Object... items) {
    return (JsonList) JsonOwnership.object(Map.of("v", List.of(items))).get("v");
  }
}
