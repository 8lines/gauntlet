package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.schema.NetworkntSchemaValidator;
import dev.eightlines.gauntlet.core.schema.TcSchemaCore;
import java.io.InputStream;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class SchemaValidatorTest {
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void draft202012FormatsAreAssertionsAndErrorsAreSafePointers() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                TcSchemaCore.DIALECT,
                "type",
                "object",
                "required",
                List.of("when"),
                "properties",
                Map.of("when", Map.of("type", "string", "format", "date-time")),
                "additionalProperties",
                false));
    var errors =
        new NetworkntSchemaValidator()
            .validate(schema, JsonOwnership.object(Map.of("when", "not-a-date")));
    assertFalse(errors.isEmpty());
    assertEquals("format", errors.getFirst().keyword());
    assertFalse(errors.getFirst().message().contains("not-a-date"));
  }

  @Test
  void requiredPropertyErrorsPointAtTheMissingEscapedProperty() {
    var schema =
        JsonOwnership.object(
            Map.of(
                "$schema",
                TcSchemaCore.DIALECT,
                "type",
                "object",
                "required",
                List.of("a~/b"),
                "properties",
                Map.of("a~/b", Map.of("type", "string")),
                "additionalProperties",
                false));

    var errors = new NetworkntSchemaValidator().validate(schema, JsonOwnership.object(Map.of()));

    assertEquals(1, errors.size());
    assertEquals("required", errors.getFirst().keyword());
    assertEquals("/a~0~1b", errors.getFirst().instancePath());
  }

  @Test
  void schemaCoreRejectsRemoteReferencesUnknownKeywordsAndNonObjectRoots() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            TcSchemaCore.assertValid(
                JsonOwnership.object(
                    Map.of(
                        "$schema", TcSchemaCore.DIALECT, "$ref", "https://example.invalid/schema")),
                false));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            TcSchemaCore.assertValid(
                JsonOwnership.object(
                    Map.of("$schema", TcSchemaCore.DIALECT, "type", "object", "unknown", true)),
                true));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            TcSchemaCore.assertValid(
                JsonOwnership.object(Map.of("$schema", TcSchemaCore.DIALECT, "type", "array")),
                true));
  }

  @Test
  void schemaCoreRejectsMalformedDraftKeywordValues() {
    List<JsonObject> malformed =
        List.of(
            JsonOwnership.object(
                Map.of(
                    "$schema", TcSchemaCore.DIALECT,
                    "type", "object",
                    "required", "id")),
            JsonOwnership.object(
                Map.of(
                    "$schema",
                    TcSchemaCore.DIALECT,
                    "type",
                    "object",
                    "properties",
                    Map.of("id", Map.of("type", 17)))),
            JsonOwnership.object(
                Map.of(
                    "$schema",
                    TcSchemaCore.DIALECT,
                    "type",
                    "object",
                    "properties",
                    Map.of("id", Map.of("type", "string", "minLength", -1)))));
    for (JsonObject schema : malformed) {
      assertThrows(IllegalArgumentException.class, () -> TcSchemaCore.assertValid(schema, true));
    }
  }

  @Test
  void schemaCoreAllowsProductiveRecursionAndRejectsSameInstanceCycles() {
    var productive =
        JsonOwnership.object(
            Map.of(
                "$schema",
                TcSchemaCore.DIALECT,
                "type",
                "object",
                "$defs",
                Map.of(
                    "node",
                    Map.of(
                        "type",
                        "object",
                        "properties",
                        Map.of(
                            "next", Map.of("$ref", "#/$defs/node"),
                            "children",
                                Map.of("type", "array", "items", Map.of("$ref", "#/$defs/node"))))),
                "properties",
                Map.of("root", Map.of("$ref", "#/$defs/node"))));
    TcSchemaCore.assertValid(productive, true);

    assertThrows(
        IllegalArgumentException.class,
        () ->
            TcSchemaCore.assertValid(
                JsonOwnership.object(Map.of("$schema", TcSchemaCore.DIALECT, "$ref", "#")), false));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            TcSchemaCore.assertValid(
                JsonOwnership.object(
                    Map.of(
                        "$schema", TcSchemaCore.DIALECT,
                        "type", "object",
                        "default", Map.of("$ref", "#/examples/0"),
                        "examples", List.of(Map.of("$ref", "#/default")),
                        "properties", Map.of("value", Map.of("$ref", "#/default")))),
                true));
  }

  @Test
  void referencedAnnotationDataIsValidatedAsSchemaButUnreferencedDataIsNot() {
    var referenced =
        JsonOwnership.object(
            Map.of(
                "$schema",
                TcSchemaCore.DIALECT,
                "type",
                "object",
                "default",
                Map.of("transform", List.of("trim")),
                "properties",
                Map.of("value", Map.of("$ref", "#/default"))));
    assertThrows(IllegalArgumentException.class, () -> TcSchemaCore.assertValid(referenced, true));

    var unreferenced =
        JsonOwnership.object(
            Map.of(
                "$schema",
                TcSchemaCore.DIALECT,
                "type",
                "object",
                "default",
                Map.of("transform", List.of("trim"))));
    TcSchemaCore.assertValid(unreferenced, true);
  }

  @Test
  @SuppressWarnings("unchecked")
  void everyPortablePatternVectorHasTheFrozenValidityAndSearchSemantics() throws Exception {
    try (InputStream source =
        getClass().getClassLoader().getResourceAsStream("tc-schema-core-pattern-vectors.json")) {
      org.junit.jupiter.api.Assertions.assertNotNull(
          source, "mounted pattern vectors are required");
      Map<String, Object> document = mapper.readValue(source, Map.class);
      assertEquals("tc-schema-core@1", document.get("profile"));
      List<Map<String, Object>> vectors = (List<Map<String, Object>>) document.get("vectors");
      assertEquals(113, vectors.size());

      for (Map<String, Object> vector : vectors) {
        String name = (String) vector.get("name");
        String pattern = mapper.readValue((String) vector.get("sourceJson"), String.class);
        JsonObject schema = null;
        boolean valid;
        try {
          schema =
              JsonOwnership.object(
                  Map.of("$schema", TcSchemaCore.DIALECT, "type", "string", "pattern", pattern));
          TcSchemaCore.assertValid(schema, false);
          valid = true;
        } catch (IllegalArgumentException exception) {
          valid = false;
        }
        assertEquals(vector.get("valid"), valid, name);
        if (valid) {
          JsonObject validSchema = schema;
          for (String match : (List<String>) vector.getOrDefault("matches", List.of())) {
            org.junit.jupiter.api.Assertions.assertTrue(
                new NetworkntSchemaValidator()
                    .validate(validSchema, JsonOwnership.ownRuntime(match))
                    .isEmpty(),
                name + " match " + match);
          }
          for (String nonMatch : (List<String>) vector.getOrDefault("nonMatches", List.of())) {
            org.junit.jupiter.api.Assertions.assertFalse(
                new NetworkntSchemaValidator()
                    .validate(validSchema, JsonOwnership.ownRuntime(nonMatch))
                    .isEmpty(),
                name + " non-match " + nonMatch);
          }
        }
      }
    }
  }
}
