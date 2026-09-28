package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;

public record CreateRunRequest(
    String operationRevision,
    JsonObject input,
    InvocationContext context,
    boolean dryRun,
    String idempotencyKey,
    ConfirmationAcknowledgement confirmation,
    JsonObject extensions) {
  public CreateRunRequest {
    if (operationRevision == null || !operationRevision.matches("^sha256:[0-9a-f]{64}$")) {
      throw new IllegalArgumentException("invalid operation revision");
    }
    input = Objects.requireNonNull(input, "input");
    if (idempotencyKey != null && idempotencyKey.isEmpty()) {
      throw new IllegalArgumentException("idempotency key must not be empty");
    }
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public CreateRunRequest(
      String operationRevision,
      JsonObject input,
      InvocationContext context,
      boolean dryRun,
      String idempotencyKey,
      JsonObject extensions) {
    this(operationRevision, input, context, dryRun, idempotencyKey, null, extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("operationRevision", operationRevision);
          values.put("input", input);
          ProtocolMap.optional(values, "context", context == null ? null : context.toProtocolMap());
          if (dryRun) values.put("dryRun", true);
          ProtocolMap.optional(values, "idempotencyKey", idempotencyKey);
          ProtocolMap.optional(
              values, "confirmation", confirmation == null ? null : confirmation.toProtocolMap());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
