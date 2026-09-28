package dev.eightlines.gauntlet.core.schema;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.ProtocolId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Canonical operation placement rules shared by definitions and wire semantics. */
public final class PlacementRules {
  public static final String PROFILE = "gauntlet-page-placements@1";
  private static final Set<String> SCALAR_TYPES = Set.of("string", "number", "integer", "boolean");
  private static final Pattern INVALID_ESCAPE = Pattern.compile("~(?![01])");

  /**
   * Keywords that make a schema node non-traversable / non-scalar: any node owning one of these
   * cannot be descended into (intermediate segments) nor treated as a scalar leaf, mirroring
   * packages/protocol/src/placements.ts.
   */
  private static final Set<String> NON_TRAVERSABLE_KEYWORDS =
      Set.of("$ref", "allOf", "anyOf", "oneOf", "not", "if", "then", "else");

  private PlacementRules() {}

  public static List<String> decode(String pointer) {
    if (pointer == null || pointer.isEmpty() || pointer.charAt(0) != '/') return null;
    var segments = new ArrayList<String>();
    for (String raw : pointer.substring(1).split("/", -1)) {
      if (INVALID_ESCAPE.matcher(raw).find()) return null;
      segments.add(raw.replace("~1", "/").replace("~0", "~"));
    }
    return segments;
  }

  public static String schemaPointer(String inputPointer) {
    List<String> segments = decode(inputPointer);
    if (segments == null) return null;
    var result = new StringBuilder();
    for (String segment : segments)
      result.append("/properties/").append(segment.replace("~", "~0").replace("/", "~1"));
    return result.toString();
  }

  public static boolean areValid(
      JsonObject inputSchema, List<String> guarded, JsonList placements) {
    if (placements.values().isEmpty()) return false;
    int globals = 0;
    var subjectTypes = new HashSet<String>();
    for (JsonValue value : placements.values()) {
      if (!(value instanceof JsonObject placement)) return false;
      String kind = string(placement.get("kind"));
      if ("global".equals(kind)) {
        globals++;
        continue;
      }
      String subjectType = string(placement.get("subjectType"));
      if (!"subject".equals(kind)
          || subjectType == null
          || !ProtocolId.isValid(subjectType)
          || !subjectTypes.add(subjectType)) return false;
      JsonValue bindingsValue = placement.get("bindings");
      if (bindingsValue == null) continue;
      if (!(bindingsValue instanceof JsonObject bindings)) return false;
      for (var entry : bindings.values().entrySet()) {
        String key = string(entry.getValue());
        String schemaPointer = schemaPointer(entry.getKey());
        if (key == null
            || !ProtocolId.isValid(key)
            || schemaPointer == null
            || !targetIsScalar(inputSchema, entry.getKey())) return false;
        for (String rule : guarded)
          if (schemaPointer.equals(rule) || schemaPointer.startsWith(rule + "/")) return false;
      }
    }
    return globals <= 1;
  }

  private static boolean targetIsScalar(JsonObject schema, String pointer) {
    JsonValue node = schema;
    if (!(node instanceof JsonObject object) || hasNonTraversableKeyword(object)) return false;
    for (String segment : decode(pointer)) {
      if (!(node instanceof JsonObject current)) return false;
      if (!(current.get("properties") instanceof JsonObject properties)
          || !properties.values().containsKey(segment)) return false;
      node = properties.get(segment);
      if (!(node instanceof JsonObject next) || hasNonTraversableKeyword(next)) return false;
    }
    if (!(node instanceof JsonObject leaf)) return false;
    if (leaf.values().containsKey("enum")) {
      return leaf.get("enum") instanceof JsonList values
          && !values.values().isEmpty()
          && values.values().stream().allMatch(PlacementRules::isScalar);
    }
    if (leaf.values().containsKey("const")) return isScalar(leaf.get("const"));
    String type = string(leaf.get("type"));
    return type != null && SCALAR_TYPES.contains(type);
  }

  private static boolean hasNonTraversableKeyword(JsonObject node) {
    for (String keyword : NON_TRAVERSABLE_KEYWORDS) {
      if (node.values().containsKey(keyword)) return true;
    }
    return false;
  }

  private static boolean isScalar(JsonValue value) {
    Object raw = value == null ? null : value.unwrap();
    return raw instanceof String || raw instanceof Number || raw instanceof Boolean;
  }

  private static String string(JsonValue value) {
    return value != null && value.unwrap() instanceof String result ? result : null;
  }
}
