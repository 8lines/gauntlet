package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;

public record FeatureDefinition(
    String id, String label, String parentId, int order, JsonObject extensions) {
  public FeatureDefinition {
    id = ProtocolId.require(id);
    if (label == null || label.isEmpty())
      throw new IllegalArgumentException("feature label is blank");
    if (parentId != null) parentId = ProtocolId.require(parentId);
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("label", label);
          ProtocolMap.optional(values, "parentId", parentId);
          if (order != 0) values.put("order", order);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
