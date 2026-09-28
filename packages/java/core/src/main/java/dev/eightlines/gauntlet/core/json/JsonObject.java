package dev.eightlines.gauntlet.core.json;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

public final class JsonObject implements JsonValue {
  private final Map<String, JsonValue> values;

  public JsonObject(Map<String, JsonValue> values) {
    Objects.requireNonNull(values, "values");
    var copy = new LinkedHashMap<String, JsonValue>();
    values.forEach(
        (key, value) -> {
          JsonOwnership.validateString(Objects.requireNonNull(key, "JSON object key"));
          copy.put(key, Objects.requireNonNull(value, "JSON object value"));
        });
    this.values = Collections.unmodifiableMap(copy);
  }

  public Map<String, JsonValue> values() {
    return values;
  }

  public JsonValue get(String key) {
    return values.get(key);
  }

  @Override
  public Object unwrap() {
    return values;
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof JsonObject object && values.equals(object.values);
  }

  @Override
  public int hashCode() {
    return values.hashCode();
  }

  @Override
  public String toString() {
    return CanonicalJson.encodeString(this);
  }
}
