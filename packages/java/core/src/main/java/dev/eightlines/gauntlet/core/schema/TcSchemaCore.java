package dev.eightlines.gauntlet.core.schema;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Frozen {@code tc-schema-core@1} authoring profile. */
public final class TcSchemaCore {
  public static final String DIALECT = "https://json-schema.org/draft/2020-12/schema";

  private static final Set<String> ALLOWED_KEYWORDS =
      Set.of(
          "$schema",
          "$ref",
          "$defs",
          "$comment",
          "type",
          "enum",
          "const",
          "multipleOf",
          "maximum",
          "exclusiveMaximum",
          "minimum",
          "exclusiveMinimum",
          "maxLength",
          "minLength",
          "pattern",
          "format",
          "maxItems",
          "minItems",
          "uniqueItems",
          "maxContains",
          "minContains",
          "maxProperties",
          "minProperties",
          "required",
          "dependentRequired",
          "allOf",
          "anyOf",
          "oneOf",
          "not",
          "if",
          "then",
          "else",
          "dependentSchemas",
          "prefixItems",
          "items",
          "contains",
          "properties",
          "patternProperties",
          "additionalProperties",
          "propertyNames",
          "unevaluatedItems",
          "unevaluatedProperties",
          "title",
          "description",
          "default",
          "deprecated",
          "readOnly",
          "writeOnly",
          "examples",
          "contentEncoding",
          "contentMediaType",
          "contentSchema");
  private static final Set<String> ALLOWED_FORMATS =
      Set.of("date", "date-time", "email", "hostname", "ipv4", "ipv6", "uri", "uuid");
  private static final Set<String> ALLOWED_TYPES =
      Set.of("null", "boolean", "object", "array", "number", "string", "integer");
  private static final List<String> MAP_SCHEMAS =
      List.of("$defs", "dependentSchemas", "properties", "patternProperties");
  private static final List<String> ARRAY_SCHEMAS =
      List.of("allOf", "anyOf", "oneOf", "prefixItems");
  private static final List<String> SINGLE_SCHEMAS =
      List.of(
          "not",
          "if",
          "then",
          "else",
          "items",
          "contains",
          "additionalProperties",
          "propertyNames",
          "unevaluatedItems",
          "unevaluatedProperties",
          "contentSchema");
  private static final Set<String> SAME_INSTANCE =
      Set.of("dependentSchemas", "allOf", "anyOf", "oneOf", "not", "if", "then", "else");
  private static final List<String> NONNEGATIVE_INTEGER_KEYWORDS =
      List.of(
          "maxLength",
          "minLength",
          "maxItems",
          "minItems",
          "maxContains",
          "minContains",
          "maxProperties",
          "minProperties");
  private static final List<String> NUMBER_KEYWORDS =
      List.of("maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum");
  private static final List<String> STRING_KEYWORDS =
      List.of(
          "$schema",
          "$ref",
          "$comment",
          "pattern",
          "format",
          "title",
          "description",
          "contentEncoding",
          "contentMediaType");
  private static final List<String> BOOLEAN_KEYWORDS =
      List.of("uniqueItems", "deprecated", "readOnly", "writeOnly");

  private TcSchemaCore() {}

  public static void assertValid(JsonObject schema, boolean requireObjectRoot) {
    if (!DIALECT.equals(string(schema.get("$schema")))) {
      throw invalid("root schema dialect must be Draft 2020-12");
    }
    if (requireObjectRoot && !"object".equals(string(schema.get("type")))) {
      throw invalid("schema root type must be object");
    }

    Set<JsonObject> visited = identitySet();
    Map<JsonObject, Set<JsonObject>> sameInstanceEdges = new IdentityHashMap<>();
    List<LocalReference> localReferences = new ArrayList<>();
    ArrayDeque<SchemaVisit> pending = new ArrayDeque<>();
    pending.push(new SchemaVisit(schema, ""));

    while (!pending.isEmpty()) {
      SchemaVisit visit = pending.pop();
      if (isBooleanSchema(visit.schema)) {
        continue;
      }
      JsonObject current = requireSchemaObject(visit.schema);
      if (!visited.add(current)) {
        continue;
      }
      validateKeywordShape(current);
      for (String keyword : current.values().keySet()) {
        if (!ALLOWED_KEYWORDS.contains(keyword)) {
          throw invalid("unsupported schema keyword: " + keyword);
        }
      }

      String reference = string(current.get("$ref"));
      if (current.get("$ref") != null) {
        if (reference == null || !reference.startsWith("#")) {
          throw invalid("only fragment schema references are supported");
        }
        localReferences.add(new LocalReference(current, reference));
      }
      String format = string(current.get("format"));
      if (current.get("format") != null && !ALLOWED_FORMATS.contains(format)) {
        throw invalid("unsupported schema format");
      }
      String pattern = string(current.get("pattern"));
      if (current.get("pattern") != null) {
        PortablePattern.assertValid(pattern);
      }

      for (String keyword : MAP_SCHEMAS) {
        JsonValue child = current.get(keyword);
        if (child == null) {
          continue;
        }
        JsonObject map = requireObject(child, keyword + " must be an object");
        if ("patternProperties".equals(keyword)) {
          map.values().keySet().forEach(PortablePattern::assertValid);
        }
        for (JsonValue nested : map.values().values()) {
          requireSchemaNode(nested);
          if (SAME_INSTANCE.contains(keyword)) {
            addSameInstanceEdge(sameInstanceEdges, current, nested);
          }
          pending.push(new SchemaVisit(nested, keyword));
        }
      }
      for (String keyword : ARRAY_SCHEMAS) {
        JsonValue child = current.get(keyword);
        if (child == null) {
          continue;
        }
        JsonList list = requireList(child, keyword + " must be an array of schemas");
        for (JsonValue nested : list.values()) {
          requireSchemaNode(nested);
          if (SAME_INSTANCE.contains(keyword)) {
            addSameInstanceEdge(sameInstanceEdges, current, nested);
          }
          pending.push(new SchemaVisit(nested, keyword));
        }
      }
      for (String keyword : SINGLE_SCHEMAS) {
        JsonValue child = current.get(keyword);
        if (child == null) {
          continue;
        }
        requireSchemaNode(child);
        if (SAME_INSTANCE.contains(keyword)) {
          addSameInstanceEdge(sameInstanceEdges, current, child);
        }
        pending.push(new SchemaVisit(child, keyword));
      }
    }

    for (int cursor = 0; cursor < localReferences.size(); cursor++) {
      LocalReference reference = localReferences.get(cursor);
      JsonValue target = resolveLocal(schema, reference.reference);
      requireSchemaNode(target);
      if (target instanceof JsonObject targetObject) {
        if (reachesSameInstance(sameInstanceEdges, targetObject, reference.source)) {
          throw invalid("non-productive same-instance cycle");
        }
        addSameInstanceEdge(sameInstanceEdges, reference.source, targetObject);
        if (!visited.contains(targetObject)) {
          pending.push(new SchemaVisit(targetObject, reference.reference));
          while (!pending.isEmpty()) {
            SchemaVisit visit = pending.pop();
            if (isBooleanSchema(visit.schema)) {
              continue;
            }
            JsonObject current = requireSchemaObject(visit.schema);
            if (!visited.add(current)) {
              continue;
            }
            validateReferencedTarget(current, pending, localReferences, sameInstanceEdges);
          }
        }
      }
    }
  }

  private static void validateReferencedTarget(
      JsonObject current,
      ArrayDeque<SchemaVisit> pending,
      List<LocalReference> localReferences,
      Map<JsonObject, Set<JsonObject>> sameInstanceEdges) {
    validateKeywordShape(current);
    for (String keyword : current.values().keySet()) {
      if (!ALLOWED_KEYWORDS.contains(keyword)) {
        throw invalid("unsupported schema keyword: " + keyword);
      }
    }
    if (current.get("$ref") != null) {
      String reference = string(current.get("$ref"));
      if (reference == null || !reference.startsWith("#")) {
        throw invalid("only fragment schema references are supported");
      }
      localReferences.add(new LocalReference(current, reference));
    }
    if (current.get("format") != null && !ALLOWED_FORMATS.contains(string(current.get("format")))) {
      throw invalid("unsupported schema format");
    }
    if (current.get("pattern") != null) {
      PortablePattern.assertValid(string(current.get("pattern")));
    }
    for (String keyword : MAP_SCHEMAS) {
      JsonValue child = current.get(keyword);
      if (child == null) {
        continue;
      }
      JsonObject map = requireObject(child, keyword + " must be an object");
      if ("patternProperties".equals(keyword)) {
        map.values().keySet().forEach(PortablePattern::assertValid);
      }
      for (JsonValue nested : map.values().values()) {
        requireSchemaNode(nested);
        if (SAME_INSTANCE.contains(keyword)) {
          addSameInstanceEdge(sameInstanceEdges, current, nested);
        }
        pending.push(new SchemaVisit(nested, keyword));
      }
    }
    for (String keyword : ARRAY_SCHEMAS) {
      JsonValue child = current.get(keyword);
      if (child == null) {
        continue;
      }
      JsonList list = requireList(child, keyword + " must be an array of schemas");
      for (JsonValue nested : list.values()) {
        requireSchemaNode(nested);
        if (SAME_INSTANCE.contains(keyword)) {
          addSameInstanceEdge(sameInstanceEdges, current, nested);
        }
        pending.push(new SchemaVisit(nested, keyword));
      }
    }
    for (String keyword : SINGLE_SCHEMAS) {
      JsonValue child = current.get(keyword);
      if (child != null) {
        requireSchemaNode(child);
        if (SAME_INSTANCE.contains(keyword)) {
          addSameInstanceEdge(sameInstanceEdges, current, child);
        }
        pending.push(new SchemaVisit(child, keyword));
      }
    }
  }

  private static void validateKeywordShape(JsonObject schema) {
    for (String keyword : STRING_KEYWORDS) {
      JsonValue value = schema.get(keyword);
      if (value != null && string(value) == null) {
        throw invalid(keyword + " must be a string");
      }
    }
    for (String keyword : BOOLEAN_KEYWORDS) {
      JsonValue value = schema.get(keyword);
      if (value != null && !(value.unwrap() instanceof Boolean)) {
        throw invalid(keyword + " must be a boolean");
      }
    }
    for (String keyword : NUMBER_KEYWORDS) {
      JsonValue value = schema.get(keyword);
      if (value != null && !(value.unwrap() instanceof Number)) {
        throw invalid(keyword + " must be a number");
      }
    }
    JsonValue multipleOf = schema.get("multipleOf");
    if (multipleOf != null
        && (!(multipleOf.unwrap() instanceof Number number) || number.doubleValue() <= 0)) {
      throw invalid("multipleOf must be a positive number");
    }
    for (String keyword : NONNEGATIVE_INTEGER_KEYWORDS) {
      JsonValue value = schema.get(keyword);
      if (value != null && (!(value.unwrap() instanceof Long number) || number < 0)) {
        throw invalid(keyword + " must be a non-negative integer");
      }
    }
    validateType(schema.get("type"));
    validateStringSet(schema.get("required"), "required", true);
    JsonValue dependentRequired = schema.get("dependentRequired");
    if (dependentRequired != null) {
      JsonObject dependencies =
          requireObject(dependentRequired, "dependentRequired must be an object");
      for (JsonValue dependency : dependencies.values().values()) {
        validateStringSet(dependency, "dependentRequired entry", true);
      }
    }
    JsonValue enumeration = schema.get("enum");
    if (enumeration != null) {
      JsonList values = requireList(enumeration, "enum must be an array");
      if (values.values().isEmpty()) {
        throw invalid("enum must not be empty");
      }
      Set<String> canonicalValues = new HashSet<>();
      for (JsonValue value : values.values()) {
        if (!canonicalValues.add(CanonicalJson.encodeString(value))) {
          throw invalid("enum values must be unique");
        }
      }
    }
    JsonValue examples = schema.get("examples");
    if (examples != null) {
      requireList(examples, "examples must be an array");
    }
    for (String keyword : List.of("allOf", "anyOf", "oneOf")) {
      JsonValue value = schema.get(keyword);
      if (value instanceof JsonList list && list.values().isEmpty()) {
        throw invalid(keyword + " must not be empty");
      }
    }
  }

  private static void validateType(JsonValue value) {
    if (value == null) {
      return;
    }
    String single = string(value);
    if (single != null) {
      if (!ALLOWED_TYPES.contains(single)) {
        throw invalid("unsupported JSON Schema type");
      }
      return;
    }
    JsonList types = requireList(value, "type must be a string or array");
    if (types.values().isEmpty()) {
      throw invalid("type array must not be empty");
    }
    Set<String> unique = new HashSet<>();
    for (JsonValue type : types.values()) {
      String name = string(type);
      if (!ALLOWED_TYPES.contains(name) || !unique.add(name)) {
        throw invalid("type array must contain unique supported types");
      }
    }
  }

  private static void validateStringSet(JsonValue value, String keyword, boolean allowEmpty) {
    if (value == null) {
      return;
    }
    JsonList list = requireList(value, keyword + " must be an array");
    if (!allowEmpty && list.values().isEmpty()) {
      throw invalid(keyword + " must not be empty");
    }
    Set<String> unique = new HashSet<>();
    for (JsonValue item : list.values()) {
      String string = string(item);
      if (string == null || !unique.add(string)) {
        throw invalid(keyword + " must contain unique strings");
      }
    }
  }

  private static boolean reachesSameInstance(
      Map<JsonObject, Set<JsonObject>> edges, JsonObject start, JsonObject destination) {
    Set<JsonObject> seen = identitySet();
    ArrayDeque<JsonObject> pending = new ArrayDeque<>();
    pending.push(start);
    while (!pending.isEmpty()) {
      JsonObject current = pending.pop();
      if (current == destination) {
        return true;
      }
      if (seen.add(current)) {
        pending.addAll(edges.getOrDefault(current, Set.of()));
      }
    }
    return false;
  }

  private static void addSameInstanceEdge(
      Map<JsonObject, Set<JsonObject>> edges, JsonObject source, JsonValue target) {
    if (target instanceof JsonObject targetObject) {
      edges.computeIfAbsent(source, ignored -> identitySet()).add(targetObject);
    }
  }

  private static JsonValue resolveLocal(JsonObject root, String reference) {
    if ("#".equals(reference)) {
      return root;
    }
    if (!reference.startsWith("#/")) {
      throw invalid("unresolved local schema reference");
    }
    String fragment;
    try {
      fragment =
          URLDecoder.decode(reference.substring(1).replace("+", "%2B"), StandardCharsets.UTF_8);
    } catch (IllegalArgumentException exception) {
      throw invalid("unresolved local schema reference");
    }
    JsonValue current = root;
    for (String encoded : fragment.substring(1).split("/", -1)) {
      if (encoded.matches(".*~(?:[^01]|$).*$")) {
        throw invalid("unresolved local schema reference");
      }
      String segment = encoded.replace("~1", "/").replace("~0", "~");
      if (!(current instanceof JsonObject object) || object.get(segment) == null) {
        throw invalid("unresolved local schema reference");
      }
      current = object.get(segment);
    }
    return current;
  }

  private static JsonObject requireSchemaObject(JsonValue value) {
    return requireObject(value, "schema must be boolean or object");
  }

  private static void requireSchemaNode(JsonValue value) {
    if (value == null || !(value instanceof JsonObject) && !isBooleanSchema(value)) {
      throw invalid("schema must be boolean or object");
    }
  }

  private static JsonObject requireObject(JsonValue value, String message) {
    if (!(value instanceof JsonObject object)) {
      throw invalid(message);
    }
    return object;
  }

  private static JsonList requireList(JsonValue value, String message) {
    if (!(value instanceof JsonList list)) {
      throw invalid(message);
    }
    return list;
  }

  private static boolean isBooleanSchema(JsonValue value) {
    return value instanceof JsonValue.Scalar scalar && scalar.value() instanceof Boolean;
  }

  private static String string(JsonValue value) {
    return value != null && value.unwrap() instanceof String string ? string : null;
  }

  private static Set<JsonObject> identitySet() {
    return Collections.newSetFromMap(new IdentityHashMap<>());
  }

  private static IllegalArgumentException invalid(String message) {
    return new IllegalArgumentException(message);
  }

  private record SchemaVisit(JsonValue schema, String pointer) {}

  private record LocalReference(JsonObject source, String reference) {}
}
