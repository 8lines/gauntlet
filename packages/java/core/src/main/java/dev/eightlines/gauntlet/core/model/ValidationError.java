package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;

public record ValidationError(
    String instancePath,
    String schemaPath,
    String keyword,
    String message,
    JsonObject params,
    JsonObject extensions) {
  public ValidationError(
      String instancePath, String schemaPath, String keyword, String message, JsonObject params) {
    this(
        instancePath,
        schemaPath,
        keyword,
        message,
        params,
        dev.eightlines.gauntlet.core.json.JsonOwnership.object(java.util.Map.of()));
  }

  public ValidationError {
    instancePath = Objects.requireNonNull(instancePath, "instancePath");
    schemaPath = Objects.requireNonNull(schemaPath, "schemaPath");
    keyword = Objects.requireNonNull(keyword, "keyword");
    message = Objects.requireNonNull(message, "message");
    params = Objects.requireNonNull(params, "params");
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("instancePath", instancePath);
          values.put("schemaPath", schemaPath);
          values.put("keyword", keyword);
          values.put("message", message);
          values.put("params", params);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
