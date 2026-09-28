package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.schema.TcSchemaCore;
import java.util.Objects;
import java.util.Set;

public record OperationOutput(JsonObject schema, JsonObject presentation, JsonObject extensions) {
  public OperationOutput {
    schema = Objects.requireNonNull(schema, "schema");
    TcSchemaCore.assertValid(schema, false);
    if (presentation != null) {
      if (!Set.of("profile", "defaultView").containsAll(presentation.values().keySet())
          || !"tc-rich-results@1".equals(string(presentation, "profile"))) {
        throw new IllegalArgumentException("invalid result presentation");
      }
      String defaultView = string(presentation, "defaultView");
      if (presentation.get("defaultView") != null
          && !Set.of("summary", "details", "artifacts").contains(defaultView)) {
        throw new IllegalArgumentException("invalid result default view");
      }
    }
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("schema", schema);
          ProtocolMap.optional(values, "presentation", presentation);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  private static String string(JsonObject object, String key) {
    return object.get(key) != null && object.get(key).unwrap() instanceof String value
        ? value
        : null;
  }
}
