package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;

final class ProtocolMap {
  private ProtocolMap() {}

  static JsonObject build(Consumer<Map<String, Object>> writer) {
    var values = new LinkedHashMap<String, Object>();
    writer.accept(values);
    return JsonOwnership.revisionObject(values);
  }

  static void required(Map<String, Object> target, String key, Object value) {
    target.put(key, Objects.requireNonNull(value, key));
  }

  static void optional(Map<String, Object> target, String key, Object value) {
    if (value != null) target.put(key, value);
  }
}
