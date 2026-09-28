package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;

public record OperationPreset(
    String id,
    String label,
    String description,
    JsonObject input,
    List<String> lockedPointers,
    JsonObject extensions) {
  public OperationPreset {
    id = ProtocolId.require(id);
    label = Objects.requireNonNull(label, "label");
    input = Objects.requireNonNull(input, "input");
    lockedPointers = List.copyOf(Objects.requireNonNull(lockedPointers, "lockedPointers"));
    lockedPointers.forEach(DataSourceReference::validatePointer);
    if (new HashSet<>(lockedPointers).size() != lockedPointers.size()) {
      throw new IllegalArgumentException("duplicate locked pointer");
    }
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("label", label);
          ProtocolMap.optional(values, "description", description);
          values.put("input", input);
          if (!lockedPointers.isEmpty()) values.put("lockedPointers", lockedPointers);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
