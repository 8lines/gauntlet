package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.schema.TcSchemaCore;

public record DataSourceDefinition(
    String id,
    String label,
    String description,
    boolean search,
    String pagination,
    boolean resolve,
    int defaultLimit,
    int maxLimit,
    JsonObject dependencySchema,
    JsonObject contextSchema,
    JsonObject extensions) {
  public DataSourceDefinition {
    id = ProtocolId.require(id);
    if (label == null || label.isEmpty())
      throw new IllegalArgumentException("data source label is blank");
    if (!"cursor".equals(pagination) || !resolve) {
      throw new IllegalArgumentException("unsupported data source capabilities");
    }
    if (defaultLimit <= 0 || maxLimit < defaultLimit) {
      throw new IllegalArgumentException("invalid data source limits");
    }
    if (dependencySchema != null) {
      TcSchemaCore.assertValid(dependencySchema, true);
    }
    if (contextSchema != null) {
      TcSchemaCore.assertValid(contextSchema, true);
    }
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("label", label);
          ProtocolMap.optional(values, "description", description);
          values.put(
              "capabilities",
              java.util.Map.of(
                  "search", search,
                  "pagination", pagination,
                  "resolve", resolve,
                  "defaultLimit", defaultLimit,
                  "maxLimit", maxLimit));
          ProtocolMap.optional(values, "dependencySchema", dependencySchema);
          ProtocolMap.optional(values, "contextSchema", contextSchema);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
