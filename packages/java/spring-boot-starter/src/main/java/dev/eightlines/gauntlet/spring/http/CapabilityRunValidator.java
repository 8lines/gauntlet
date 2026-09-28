package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.model.Run;

/** Validates an externally supplied Run against the authoritative adapter catalog. */
@FunctionalInterface
public interface CapabilityRunValidator {
  enum Origin {
    CAPABILITY,
    STORE
  }

  Run validate(Run run, String expectedRunId, String expectedOperationId, Origin origin);
}
