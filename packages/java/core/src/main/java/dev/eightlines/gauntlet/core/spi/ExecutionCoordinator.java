package dev.eightlines.gauntlet.core.spi;

import java.util.concurrent.CompletionStage;

/**
 * Coordinates operation execution across {@code RunManager} instances that share this SPI.
 * Implementations intended for multiple application replicas must provide distributed ordering and
 * cancellation visibility.
 */
public interface ExecutionCoordinator {
  /**
   * Reserves a place for one run. A non-admitted reservation represents an atomic {@code forbid}
   * conflict and must never be persisted as a run.
   */
  Reservation reserve(String operationId, String runId, String concurrency);

  /** Makes a cancellation request visible to the reservation that owns the run, if it exists. */
  boolean requestCancellation(String operationId, String runId);

  interface Reservation extends AutoCloseable {
    boolean admitted();

    /** Completes when an admitted run owns its turn. */
    CompletionStage<Void> turn();

    /**
     * For a rejected reservation, completes with {@code true} when the conflicting run was durably
     * published or {@code false} when that candidate was released before publication.
     */
    CompletionStage<Boolean> conflictResolution();

    /** Publishes that the admitted reservation now has a durable queued run. */
    void markPersisted();

    boolean cancellationRequested();

    @Override
    void close();
  }
}
