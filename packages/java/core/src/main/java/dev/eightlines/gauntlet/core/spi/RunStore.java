package dev.eightlines.gauntlet.core.spi;

import dev.eightlines.gauntlet.core.model.Run;
import java.util.Optional;

public interface RunStore {
  RunStoreCreateResult createQueued(Run run, Optional<String> idempotencyFingerprint);

  Optional<Run> get(String runId);

  Optional<Run> findByIdempotencyFingerprint(String operationId, String fingerprint);

  boolean updateExactSequence(Run run, long expectedPreviousSequence);
}
