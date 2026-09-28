package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.List;
import java.util.Objects;

public record DataSourceResolveRequest(
    List<String> values,
    JsonObject dependencies,
    InvocationContext context,
    JsonObject extensions) {
  public DataSourceResolveRequest {
    values = List.copyOf(Objects.requireNonNull(values, "values"));
    if (values.stream().anyMatch(Objects::isNull)) {
      throw new IllegalArgumentException("resolve values must be strings");
    }
    dependencies = Objects.requireNonNull(dependencies, "dependencies");
    dependencies.values().keySet().forEach(DataSourceReference::validatePointer);
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        result -> {
          result.put("values", values);
          if (!dependencies.values().isEmpty()) result.put("dependencies", dependencies);
          ProtocolMap.optional(result, "context", context == null ? null : context.toProtocolMap());
          if (!extensions.values().isEmpty()) result.put("extensions", extensions);
        });
  }
}
