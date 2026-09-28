package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;
import java.util.Set;

public record AdapterDiagnostic(
    String severity, String code, String message, String operationId, JsonObject extensions) {
  public AdapterDiagnostic {
    if (!Set.of("warning", "error").contains(severity))
      throw new IllegalArgumentException("invalid diagnostic severity");
    code = Objects.requireNonNull(code, "code");
    message = Objects.requireNonNull(message, "message");
    if (operationId != null) operationId = ProtocolId.require(operationId);
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("severity", severity);
          values.put("code", code);
          values.put("message", message);
          ProtocolMap.optional(values, "operationId", operationId);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
