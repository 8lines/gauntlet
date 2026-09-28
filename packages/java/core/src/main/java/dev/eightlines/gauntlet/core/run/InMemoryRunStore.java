package dev.eightlines.gauntlet.core.run;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.core.spi.RunStoreCreateResult;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Atomic process-local store intended for development environment adapters. */
public final class InMemoryRunStore implements RunStore {
  private final Map<String, Run> runs = new LinkedHashMap<>();
  private final Map<String, String> fingerprints = new HashMap<>();

  @Override
  public synchronized RunStoreCreateResult createQueued(
      Run run, Optional<String> idempotencyFingerprint) {
    if (run.state() != dev.eightlines.gauntlet.core.model.RunState.QUEUED || run.sequence() != 0) {
      throw new IllegalArgumentException("only sequence-zero queued runs can be created");
    }
    if (idempotencyFingerprint.isPresent()) {
      String compound = compound(run.operationId(), idempotencyFingerprint.orElseThrow());
      String existingId = fingerprints.get(compound);
      if (existingId != null) return RunStoreCreateResult.duplicate(runs.get(existingId));
    }
    if (runs.containsKey(run.id())) throw new IllegalArgumentException("duplicate run ID");
    runs.put(run.id(), run);
    idempotencyFingerprint.ifPresent(
        fingerprint -> fingerprints.put(compound(run.operationId(), fingerprint), run.id()));
    return RunStoreCreateResult.created(run);
  }

  @Override
  public synchronized Optional<Run> get(String runId) {
    return Optional.ofNullable(runs.get(runId));
  }

  @Override
  public synchronized Optional<Run> findByIdempotencyFingerprint(
      String operationId, String fingerprint) {
    String id = fingerprints.get(compound(operationId, fingerprint));
    return id == null ? Optional.empty() : Optional.ofNullable(runs.get(id));
  }

  @Override
  public synchronized boolean updateExactSequence(Run run, long expectedPreviousSequence) {
    Run current = runs.get(run.id());
    if (current == null
        || current.sequence() != expectedPreviousSequence
        || run.sequence() != expectedPreviousSequence + 1
        || !current.operationId().equals(run.operationId())
        || !current.operationRevision().equals(run.operationRevision())
        || !current.createdAt().equals(run.createdAt())
        || OffsetDateTime.parse(run.updatedAt())
            .toInstant()
            .isBefore(OffsetDateTime.parse(current.updatedAt()).toInstant())
        || !validTransition(current, run)) return false;
    runs.put(run.id(), run);
    return true;
  }

  public synchronized List<Run> all() {
    return List.copyOf(runs.values());
  }

  public synchronized int fingerprintCount() {
    return fingerprints.size();
  }

  public synchronized boolean containsText(String text) {
    if (fingerprints.keySet().stream().anyMatch(value -> value.contains(text))
        || fingerprints.values().stream().anyMatch(value -> value.contains(text))) return true;
    return runs.values().stream()
        .map(Run::toProtocolMap)
        .map(CanonicalJson::encodeString)
        .anyMatch(value -> value.contains(text));
  }

  private static String compound(String operationId, String fingerprint) {
    return operationId + "\0" + fingerprint;
  }

  private static boolean validTransition(Run current, Run next) {
    if (current.state() == dev.eightlines.gauntlet.core.model.RunState.QUEUED) {
      return next.state() == dev.eightlines.gauntlet.core.model.RunState.RUNNING
          || next.state().terminal();
    }
    return current.state() == dev.eightlines.gauntlet.core.model.RunState.RUNNING
        && (next.state() == dev.eightlines.gauntlet.core.model.RunState.RUNNING
            || next.state().terminal());
  }
}
