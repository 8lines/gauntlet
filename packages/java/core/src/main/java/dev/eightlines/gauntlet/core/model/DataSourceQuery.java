package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;

public record DataSourceQuery(
    String search,
    Integer limit,
    String cursor,
    JsonObject dependencies,
    InvocationContext context,
    JsonObject extensions) {
  public DataSourceQuery {
    if (limit != null && limit <= 0) throw new IllegalArgumentException("limit must be positive");
    dependencies = Objects.requireNonNull(dependencies, "dependencies");
    dependencies.values().keySet().forEach(DataSourceReference::validatePointer);
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          ProtocolMap.optional(values, "search", search);
          ProtocolMap.optional(values, "cursor", cursor);
          ProtocolMap.optional(values, "limit", limit);
          if (!dependencies.values().isEmpty()) values.put("dependencies", dependencies);
          ProtocolMap.optional(values, "context", context == null ? null : context.toProtocolMap());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
