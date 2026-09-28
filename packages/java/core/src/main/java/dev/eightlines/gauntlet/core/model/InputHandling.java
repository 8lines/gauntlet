package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public record InputHandling(List<JsonObject> rules, JsonObject extensions) {
  public InputHandling {
    rules = List.copyOf(Objects.requireNonNull(rules, "rules"));
    extensions = ProtocolValidation.requireExtensions(extensions);
    for (JsonObject rule : rules) validateRule(rule);
  }

  public static JsonObject secretRule(String schemaPointer) {
    DataSourceReference.validatePointer(schemaPointer);
    return JsonOwnership.object(
        Map.of("kind", "secret", "schemaPointer", schemaPointer, "retention", "none"));
  }

  public static JsonObject fileRule(
      String schemaPointer, boolean multiple, List<String> mediaTypes, Long maxBytes) {
    DataSourceReference.validatePointer(schemaPointer);
    var values = new java.util.LinkedHashMap<String, Object>();
    values.put("kind", "file");
    values.put("schemaPointer", schemaPointer);
    values.put("multiple", multiple);
    if (mediaTypes != null && !mediaTypes.isEmpty())
      values.put("mediaTypes", List.copyOf(mediaTypes));
    if (maxBytes != null) values.put("maxBytes", maxBytes);
    return JsonOwnership.object(values);
  }

  public List<String> secretSchemaPointers() {
    var pointers = new ArrayList<String>();
    for (JsonObject rule : rules) {
      if ("secret".equals(string(rule, "kind"))) pointers.add(string(rule, "schemaPointer"));
    }
    return List.copyOf(pointers);
  }

  public List<FileRule> fileRules() {
    var result = new ArrayList<FileRule>();
    for (JsonObject rule : rules) {
      if (!"file".equals(string(rule, "kind"))) continue;
      boolean multiple = Boolean.TRUE.equals(scalar(rule, "multiple"));
      List<String> mediaTypes = List.of();
      if (rule.get("mediaTypes") instanceof JsonList list) {
        mediaTypes = list.values().stream().map(value -> (String) value.unwrap()).toList();
      }
      Long maxBytes =
          rule.get("maxBytes") == null
              ? null
              : ((Number) rule.get("maxBytes").unwrap()).longValue();
      result.add(new FileRule(string(rule, "schemaPointer"), multiple, mediaTypes, maxBytes));
    }
    return List.copyOf(result);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("rules", rules);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  private static void validateRule(JsonObject rule) {
    Objects.requireNonNull(rule, "rule");
    String kind = string(rule, "kind");
    String pointer = string(rule, "schemaPointer");
    DataSourceReference.validatePointer(pointer);
    if ("secret".equals(kind)) {
      requireKeys(rule, Set.of("kind", "schemaPointer", "retention"));
      if (!"none".equals(string(rule, "retention"))) {
        throw new IllegalArgumentException("secret retention must be none");
      }
    } else if ("file".equals(kind)) {
      requireKeys(rule, Set.of("kind", "schemaPointer", "multiple", "mediaTypes", "maxBytes"));
      if (!(scalar(rule, "multiple") instanceof Boolean)) {
        throw new IllegalArgumentException("file rule multiple must be boolean");
      }
      if (rule.get("mediaTypes") != null) {
        if (!(rule.get("mediaTypes") instanceof JsonList mediaTypes)) {
          throw new IllegalArgumentException("file mediaTypes must be an array");
        }
        var unique = new java.util.HashSet<String>();
        for (JsonValue mediaType : mediaTypes.values()) {
          if (!(mediaType.unwrap() instanceof String value)
              || value.isEmpty()
              || !unique.add(value)) {
            throw new IllegalArgumentException(
                "file mediaTypes must contain unique non-empty strings");
          }
        }
      }
      if (rule.get("maxBytes") != null
          && (!(rule.get("maxBytes").unwrap() instanceof Long value)
              || value <= 0
              || value > ProtocolValidation.MAX_SAFE_INTEGER)) {
        throw new IllegalArgumentException("file maxBytes must be positive");
      }
    } else {
      throw new IllegalArgumentException("unsupported input handling rule");
    }
  }

  private static String string(JsonObject object, String key) {
    Object value = scalar(object, key);
    if (!(value instanceof String string)) throw new IllegalArgumentException("missing " + key);
    return string;
  }

  private static Object scalar(JsonObject object, String key) {
    JsonValue value = object.get(key);
    return value == null ? null : value.unwrap();
  }

  private static void requireKeys(JsonObject object, Set<String> allowed) {
    if (!allowed.containsAll(object.values().keySet())) {
      throw new IllegalArgumentException("input handling rule contains an unknown member");
    }
  }

  public record FileRule(
      String schemaPointer, boolean multiple, List<String> mediaTypes, Long maxBytes) {
    public FileRule {
      DataSourceReference.validatePointer(schemaPointer);
      mediaTypes = List.copyOf(mediaTypes);
    }
  }
}
