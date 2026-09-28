package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;

public record ConfirmationAcknowledgement(
    String operationId, String operationRevision, OperationImpact impact, JsonObject extensions) {
  public ConfirmationAcknowledgement {
    operationId = ProtocolId.require(operationId);
    if (operationRevision == null || !operationRevision.matches("^sha256:[0-9a-f]{64}$")) {
      throw new IllegalArgumentException("invalid operation revision");
    }
    impact = Objects.requireNonNull(impact, "impact");
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("operationId", operationId);
          values.put("operationRevision", operationRevision);
          values.put("impact", impact.wireValue());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
