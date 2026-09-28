package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;

public record DataSourceItem(
    String value,
    String label,
    String description,
    String group,
    boolean disabled,
    JsonObject metadata,
    JsonObject extensions) {
  public DataSourceItem {
    value = Objects.requireNonNull(value, "value");
    label = Objects.requireNonNull(label, "label");
    metadata = Objects.requireNonNull(metadata, "metadata");
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("value", value);
          values.put("label", label);
          ProtocolMap.optional(values, "description", description);
          ProtocolMap.optional(values, "group", group);
          if (disabled) values.put("disabled", true);
          if (!metadata.values().isEmpty()) values.put("metadata", metadata);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
