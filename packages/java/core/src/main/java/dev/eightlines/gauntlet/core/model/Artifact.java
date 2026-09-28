package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/** A member of the closed protocol artifact union. */
public record Artifact(
    String id, String kind, String title, JsonObject payload, JsonObject extensions) {
  private static final Pattern CUSTOM_KIND = Pattern.compile("^urn:[A-Za-z0-9][A-Za-z0-9:._/-]*$");
  private static final Set<String> LEVELS = Set.of("info", "success", "warning", "error");
  private static final Set<String> LOG_LEVELS = Set.of("debug", "info", "warning", "error");

  public Artifact {
    id = ProtocolId.require(id);
    kind = Objects.requireNonNull(kind, "kind");
    payload = Objects.requireNonNull(payload, "payload");
    extensions = ProtocolValidation.requireExtensions(extensions);
    if (payload.values().keySet().stream()
        .anyMatch(Set.of("id", "kind", "title", "extensions")::contains)) {
      throw new IllegalArgumentException("artifact payload contains envelope member");
    }
    validatePayload(kind, payload);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("kind", kind);
          ProtocolMap.optional(values, "title", title);
          for (Map.Entry<String, JsonValue> entry : payload.values().entrySet()) {
            values.put(entry.getKey(), entry.getValue());
          }
          if (!extensions.values().isEmpty()) {
            values.put("extensions", extensions);
          }
        });
  }

  private static void validatePayload(String kind, JsonObject payload) {
    switch (kind) {
      case "notice" -> validateNotice(payload);
      case "metrics" -> validateMetrics(payload);
      case "key-value" -> validateKeyValue(payload);
      case "table" -> validateTable(payload);
      case "json" -> requireKeys(payload, Set.of("value"), Set.of("value"));
      case "markdown" -> {
        requireKeys(payload, Set.of("markdown"), Set.of("markdown"));
        requireString(payload, "markdown");
      }
      case "diff" -> validateDiff(payload);
      case "timeline" -> validateTimeline(payload);
      case "log" -> validateLog(payload);
      case "download" -> validateDownload(payload);
      case "link" -> validateLink(payload);
      case "browser-launch" -> {
        requireKeys(payload, Set.of("label"), Set.of("label"));
        requireString(payload, "label");
      }
      default -> {
        if (!CUSTOM_KIND.matcher(kind).matches()) {
          throw new IllegalArgumentException("unsupported artifact kind");
        }
        requireKeys(payload, Set.of("data"), Set.of("data"));
      }
    }
  }

  private static void validateNotice(JsonObject payload) {
    requireKeys(payload, Set.of("level", "message"), Set.of("level", "message"));
    if (!LEVELS.contains(requireString(payload, "level"))) {
      throw new IllegalArgumentException("unsupported notice level");
    }
    requireString(payload, "message");
  }

  private static void validateMetrics(JsonObject payload) {
    requireKeys(payload, Set.of("metrics"), Set.of("metrics"));
    for (JsonValue value : requireList(payload, "metrics").values()) {
      JsonObject metric = requireObject(value, "metric");
      requireKeys(metric, Set.of("name", "value"), Set.of("name", "value", "unit"));
      requireString(metric, "name");
      requireNumber(metric, "value");
      requireOptionalString(metric, "unit");
    }
  }

  private static void validateKeyValue(JsonObject payload) {
    requireKeys(payload, Set.of("entries"), Set.of("entries"));
    for (JsonValue value : requireList(payload, "entries").values()) {
      JsonObject entry = requireObject(value, "key-value entry");
      requireKeys(entry, Set.of("key", "label", "value"), Set.of("key", "label", "value"));
      requireString(entry, "key");
      requireString(entry, "label");
    }
  }

  private static void validateTable(JsonObject payload) {
    requireKeys(payload, Set.of("columns", "rows"), Set.of("columns", "rows"));
    for (JsonValue value : requireList(payload, "columns").values()) {
      JsonObject column = requireObject(value, "table column");
      requireKeys(column, Set.of("key", "label"), Set.of("key", "label"));
      requireString(column, "key");
      requireString(column, "label");
    }
    for (JsonValue value : requireList(payload, "rows").values()) {
      requireObject(value, "table row");
    }
  }

  private static void validateDiff(JsonObject payload) {
    requireKeys(payload, Set.of("format", "content"), Set.of("format", "content"));
    if (!"unified".equals(requireString(payload, "format"))) {
      throw new IllegalArgumentException("unsupported diff format");
    }
    requireString(payload, "content");
  }

  private static void validateTimeline(JsonObject payload) {
    requireKeys(payload, Set.of("items"), Set.of("items"));
    for (JsonValue value : requireList(payload, "items").values()) {
      JsonObject item = requireObject(value, "timeline item");
      requireKeys(item, Set.of("timestamp", "title"), Set.of("timestamp", "title", "description"));
      ProtocolValidation.requireTimestamp(requireString(item, "timestamp"), "timestamp");
      requireString(item, "title");
      requireOptionalString(item, "description");
    }
  }

  private static void validateLog(JsonObject payload) {
    requireKeys(payload, Set.of("entries"), Set.of("entries"));
    for (JsonValue value : requireList(payload, "entries").values()) {
      JsonObject entry = requireObject(value, "log entry");
      requireKeys(entry, Set.of("level", "message"), Set.of("timestamp", "level", "message"));
      if (!LOG_LEVELS.contains(requireString(entry, "level"))) {
        throw new IllegalArgumentException("unsupported log level");
      }
      requireString(entry, "message");
      String timestamp = optionalString(entry, "timestamp");
      if (timestamp != null) {
        ProtocolValidation.requireTimestamp(timestamp, "timestamp");
      }
    }
  }

  private static void validateDownload(JsonObject payload) {
    requireKeys(
        payload,
        Set.of("url", "name", "mediaType"),
        Set.of("url", "name", "mediaType", "sizeBytes"));
    ProtocolValidation.requireHttpUrl(requireString(payload, "url"), "download URL");
    requireString(payload, "name");
    requireString(payload, "mediaType");
    JsonValue size = payload.get("sizeBytes");
    if (size != null) {
      Object raw = size.unwrap();
      if (!(raw instanceof Long number)
          || number < 0
          || number > ProtocolValidation.MAX_SAFE_INTEGER) {
        throw new IllegalArgumentException("invalid download size");
      }
    }
  }

  private static void validateLink(JsonObject payload) {
    requireKeys(payload, Set.of("label", "url"), Set.of("label", "url"));
    requireString(payload, "label");
    ProtocolValidation.requireHttpUrl(requireString(payload, "url"), "link URL");
  }

  private static void requireKeys(JsonObject object, Set<String> required, Set<String> allowed) {
    if (!object.values().keySet().containsAll(required)
        || !allowed.containsAll(object.values().keySet())) {
      throw new IllegalArgumentException("artifact payload has invalid members");
    }
  }

  private static String requireString(JsonObject object, String key) {
    String value = optionalString(object, key);
    if (value == null) {
      throw new IllegalArgumentException("artifact " + key + " must be a string");
    }
    return value;
  }

  private static void requireOptionalString(JsonObject object, String key) {
    if (object.get(key) != null) {
      requireString(object, key);
    }
  }

  private static String optionalString(JsonObject object, String key) {
    JsonValue value = object.get(key);
    return value != null && value.unwrap() instanceof String string ? string : null;
  }

  private static Number requireNumber(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value == null || !(value.unwrap() instanceof Number number)) {
      throw new IllegalArgumentException("artifact " + key + " must be a number");
    }
    return number;
  }

  private static JsonList requireList(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (!(value instanceof JsonList list)) {
      throw new IllegalArgumentException("artifact " + key + " must be an array");
    }
    return list;
  }

  private static JsonObject requireObject(JsonValue value, String name) {
    if (!(value instanceof JsonObject object)) {
      throw new IllegalArgumentException(name + " must be an object");
    }
    return object;
  }
}
