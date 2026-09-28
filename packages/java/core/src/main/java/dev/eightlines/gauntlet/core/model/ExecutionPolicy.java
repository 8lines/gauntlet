package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;
import java.util.Set;

public record ExecutionPolicy(
    OperationImpact impact,
    boolean confirmationRequired,
    boolean dryRunSupported,
    Idempotency idempotency,
    boolean cancellationSupported,
    Integer timeoutSeconds,
    String concurrency,
    JsonObject extensions) {
  public ExecutionPolicy {
    impact = Objects.requireNonNull(impact, "impact");
    idempotency = Objects.requireNonNull(idempotency, "idempotency");
    extensions = ProtocolValidation.requireExtensions(extensions);
    if (timeoutSeconds != null && timeoutSeconds <= 0) {
      throw new IllegalArgumentException("timeoutSeconds must be positive");
    }
    if (concurrency != null && !Set.of("allow", "forbid", "queue").contains(concurrency)) {
      throw new IllegalArgumentException("unsupported concurrency policy");
    }
    if (impact == OperationImpact.DESTRUCTIVE
        && (!confirmationRequired || idempotency != Idempotency.REQUIRED)) {
      throw new IllegalArgumentException(
          "destructive operations require confirmation and required idempotency");
    }
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("impact", impact.wireValue());
          values.put("confirmationRequired", confirmationRequired);
          values.put("dryRunSupported", dryRunSupported);
          values.put("idempotency", idempotency.wireValue());
          values.put("cancellationSupported", cancellationSupported);
          ProtocolMap.optional(values, "timeoutSeconds", timeoutSeconds);
          ProtocolMap.optional(values, "concurrency", concurrency);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
