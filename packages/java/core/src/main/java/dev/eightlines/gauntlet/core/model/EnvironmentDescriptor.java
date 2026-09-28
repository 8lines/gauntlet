package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.util.Set;
import java.util.regex.Pattern;

public record EnvironmentDescriptor(String name, EnvironmentKind kind) {
  private static final String INVALID = "Invalid non-production environment descriptor";
  private static final Pattern PRODUCTION_TOKEN =
      Pattern.compile("(^|[._:-])(prod|production|live)($|[._:-])", Pattern.CASE_INSENSITIVE);

  public EnvironmentDescriptor {
    try {
      name = ProtocolId.require(name);
      if (kind == null || PRODUCTION_TOKEN.matcher(name).find()) throw invalid();
    } catch (RuntimeException exception) {
      throw invalid();
    }
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("name", name);
          values.put("kind", kind.wireValue());
        });
  }

  public static EnvironmentDescriptor fromProtocolValue(JsonValue value) {
    try {
      if (!(value instanceof JsonObject object)
          || !object.values().keySet().equals(Set.of("name", "kind"))) {
        throw invalid();
      }
      Object rawName = object.get("name").unwrap();
      Object rawKind = object.get("kind").unwrap();
      if (!(rawName instanceof String name) || !(rawKind instanceof String kind)) {
        throw invalid();
      }
      return new EnvironmentDescriptor(name, EnvironmentKind.fromWireValue(kind));
    } catch (RuntimeException exception) {
      throw invalid();
    }
  }

  private static IllegalArgumentException invalid() {
    return new IllegalArgumentException(INVALID);
  }
}
