package dev.eightlines.gauntlet.core.json;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

public final class JsonList implements JsonValue {
  private final List<JsonValue> values;

  public JsonList(List<JsonValue> values) {
    Objects.requireNonNull(values, "values");
    var copy = new ArrayList<JsonValue>(values.size());
    values.forEach(value -> copy.add(Objects.requireNonNull(value, "JSON array value")));
    this.values = Collections.unmodifiableList(copy);
  }

  public List<JsonValue> values() {
    return values;
  }

  @Override
  public Object unwrap() {
    return values;
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof JsonList list && values.equals(list.values);
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
