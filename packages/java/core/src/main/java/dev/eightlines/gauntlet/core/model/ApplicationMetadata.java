package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;

public record ApplicationMetadata(
    String id, String label, EnvironmentDescriptor environment, JsonObject extensions) {
  public ApplicationMetadata {
    id = ProtocolId.require(id);
    if (label == null || label.isEmpty())
      throw new IllegalArgumentException("application label is blank");
    environment = Objects.requireNonNull(environment, "environment");
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("label", label);
          values.put("environment", environment.toProtocolMap());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
