package dev.eightlines.gauntlet.core.run;

import dev.eightlines.gauntlet.core.model.ProtocolId;
import dev.eightlines.gauntlet.core.spi.ExecutionCoordinator;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * Process-local execution coordination for a single adapter replica. Applications with multiple
 * replicas must replace it with a distributed {@link ExecutionCoordinator} implementation.
 */
public final class InMemoryExecutionCoordinator implements ExecutionCoordinator {
  private static final Set<String> POLICIES = Set.of("allow", "forbid", "queue");
  private final Map<String, ArrayDeque<LocalReservation>> operationQueues = new HashMap<>();
  private final Map<String, LocalReservation> reservationsByRun = new HashMap<>();

  @Override
  public synchronized Reservation reserve(String operationId, String runId, String concurrency) {
    String safeOperationId = ProtocolId.require(operationId);
    String safeRunId = ProtocolId.require(runId);
    String policy = concurrency == null ? "allow" : concurrency;
    if (!POLICIES.contains(policy)) {
      throw new IllegalArgumentException("unsupported concurrency policy");
    }
    if (reservationsByRun.containsKey(safeRunId)) {
      throw new IllegalArgumentException("duplicate execution reservation");
    }

    if ("allow".equals(policy)) {
      var reservation =
          new LocalReservation(
              safeOperationId,
              safeRunId,
              policy,
              true,
              CompletableFuture.completedFuture(null),
              CompletableFuture.completedFuture(false));
      reservationsByRun.put(safeRunId, reservation);
      return reservation;
    }

    var queue = operationQueues.computeIfAbsent(safeOperationId, ignored -> new ArrayDeque<>());
    if ("forbid".equals(policy) && !queue.isEmpty()) {
      LocalReservation blocker = queue.peekFirst();
      return new LocalReservation(
          safeOperationId,
          safeRunId,
          policy,
          false,
          CompletableFuture.completedFuture(null),
          blocker.publication);
    }
    var turn = new CompletableFuture<Void>();
    if (queue.isEmpty()) turn.complete(null);
    var reservation =
        new LocalReservation(
            safeOperationId,
            safeRunId,
            policy,
            true,
            turn,
            CompletableFuture.completedFuture(false));
    queue.addLast(reservation);
    reservationsByRun.put(safeRunId, reservation);
    return reservation;
  }

  @Override
  public synchronized boolean requestCancellation(String operationId, String runId) {
    String safeOperationId = ProtocolId.require(operationId);
    String safeRunId = ProtocolId.require(runId);
    LocalReservation reservation = reservationsByRun.get(safeRunId);
    if (reservation == null
        || reservation.closed
        || !reservation.operationId.equals(safeOperationId)) {
      return false;
    }
    reservation.cancelled = true;
    if (!reservation.turn.isDone()) {
      removeQueued(reservation);
      reservation.turn.complete(null);
    }
    return true;
  }

  private synchronized void close(LocalReservation reservation) {
    if (reservation.closed) return;
    reservation.closed = true;
    reservation.publication.complete(false);
    reservationsByRun.remove(reservation.runId, reservation);
    if (!"allow".equals(reservation.policy) && reservation.admitted) {
      removeQueued(reservation);
    }
  }

  private void removeQueued(LocalReservation reservation) {
    ArrayDeque<LocalReservation> queue = operationQueues.get(reservation.operationId);
    if (queue == null) return;
    boolean wasHead = queue.peekFirst() == reservation;
    queue.remove(reservation);
    if (wasHead) {
      LocalReservation next = queue.peekFirst();
      if (next != null) next.turn.complete(null);
    }
    if (queue.isEmpty()) operationQueues.remove(reservation.operationId);
  }

  private final class LocalReservation implements Reservation {
    private final String operationId;
    private final String runId;
    private final String policy;
    private final boolean admitted;
    private final CompletableFuture<Void> turn;
    private final CompletableFuture<Boolean> conflictResolution;
    private final CompletableFuture<Boolean> publication = new CompletableFuture<>();
    private boolean cancelled;
    private boolean closed;

    private LocalReservation(
        String operationId,
        String runId,
        String policy,
        boolean admitted,
        CompletionStage<Void> turn,
        CompletionStage<Boolean> conflictResolution) {
      this.operationId = Objects.requireNonNull(operationId, "operationId");
      this.runId = Objects.requireNonNull(runId, "runId");
      this.policy = Objects.requireNonNull(policy, "policy");
      this.admitted = admitted;
      this.turn = turn.toCompletableFuture();
      this.conflictResolution = conflictResolution.toCompletableFuture();
    }

    @Override
    public boolean admitted() {
      return admitted;
    }

    @Override
    public CompletionStage<Void> turn() {
      return turn;
    }

    @Override
    public CompletionStage<Boolean> conflictResolution() {
      return conflictResolution;
    }

    @Override
    public void markPersisted() {
      synchronized (InMemoryExecutionCoordinator.this) {
        if (!admitted || closed) {
          throw new IllegalStateException("execution reservation is not active");
        }
        publication.complete(true);
      }
    }

    @Override
    public boolean cancellationRequested() {
      synchronized (InMemoryExecutionCoordinator.this) {
        return cancelled;
      }
    }

    @Override
    public void close() {
      InMemoryExecutionCoordinator.this.close(this);
    }
  }
}
