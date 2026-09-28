package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;

public record DataSourceReference(
    String id,
    String inputPointer,
    List<String> dependencyPointers,
    List<String> contextPointers,
    Boolean required,
    JsonObject extensions) {
  public DataSourceReference {
    id = ProtocolId.require(id);
    validatePointer(inputPointer);
    dependencyPointers = copyPointers(dependencyPointers);
    contextPointers = copyPointers(contextPointers);
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("inputPointer", inputPointer);
          values.put("dependencyPointers", dependencyPointers);
          if (!contextPointers.isEmpty()) values.put("contextPointers", contextPointers);
          ProtocolMap.optional(values, "required", required);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  static void validatePointer(String pointer) {
    Objects.requireNonNull(pointer, "pointer");
    if (!pointer.matches("^(?:/(?:[^~/]|~[01])*)*$")) {
      throw new IllegalArgumentException("invalid JSON Pointer");
    }
  }

  private static List<String> copyPointers(List<String> pointers) {
    var copy = List.copyOf(Objects.requireNonNull(pointers, "pointers"));
    copy.forEach(DataSourceReference::validatePointer);
    if (new HashSet<>(copy).size() != copy.size())
      throw new IllegalArgumentException("duplicate JSON Pointer");
    return copy;
  }
}
