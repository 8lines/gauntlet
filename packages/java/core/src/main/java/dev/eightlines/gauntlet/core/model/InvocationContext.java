package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.util.Set;

public record InvocationContext(
    String requestId,
    String locale,
    String timeZone,
    JsonObject actor,
    JsonObject target,
    JsonObject extensions) {
  public InvocationContext {
    requestId = ProtocolId.require(requestId);
    validateIdentity(actor, "actor", Set.of("id", "displayName"));
    validateIdentity(target, "target", Set.of("id", "environment"));
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("requestId", requestId);
          ProtocolMap.optional(values, "locale", locale);
          ProtocolMap.optional(values, "timeZone", timeZone);
          ProtocolMap.optional(values, "actor", actor);
          ProtocolMap.optional(values, "target", target);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  private static void validateIdentity(JsonObject value, String name, Set<String> allowedKeys) {
    if (value == null) return;
    if (!allowedKeys.containsAll(value.values().keySet())) {
      throw new IllegalArgumentException(name + " contains an unknown member");
    }
    JsonValue id = value.get("id");
    if (id == null || !(id.unwrap() instanceof String string)) {
      throw new IllegalArgumentException(name + " must contain an ID");
    }
    ProtocolId.of(string);
    for (String key : allowedKeys) {
      JsonValue member = value.get(key);
      if (member != null && !(member.unwrap() instanceof String)) {
        throw new IllegalArgumentException(name + " members must be strings");
      }
    }
  }
}
