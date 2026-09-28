package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Objects;

/** Immutable constructor-validated run state union. */
public final class Run {
  private final String id;
  private final String operationId;
  private final String operationRevision;
  private final long sequence;
  private final RunState state;
  private final String createdAt;
  private final String updatedAt;
  private final String startedAt;
  private final String completedAt;
  private final RunProgress progress;
  private final RunSummary summary;
  private final JsonValue output;
  private final List<Artifact> artifacts;
  private final List<FollowUpAction> actions;
  private final Problem problem;
  private final JsonObject extensions;

  public Run(
      String id,
      String operationId,
      String operationRevision,
      long sequence,
      RunState state,
      String createdAt,
      String updatedAt,
      String startedAt,
      String completedAt,
      RunProgress progress,
      RunSummary summary,
      JsonValue output,
      List<Artifact> artifacts,
      List<FollowUpAction> actions,
      Problem problem,
      JsonObject extensions) {
    this.id = ProtocolId.require(id);
    this.operationId = ProtocolId.require(operationId);
    if (operationRevision == null || !operationRevision.matches("^sha256:[0-9a-f]{64}$")) {
      throw new IllegalArgumentException("invalid operation revision");
    }
    this.operationRevision = operationRevision;
    if (sequence < 0 || sequence > 9_007_199_254_740_991L)
      throw new IllegalArgumentException("invalid run sequence");
    this.sequence = sequence;
    this.state = Objects.requireNonNull(state, "state");
    OffsetDateTime created = ProtocolValidation.requireTimestamp(createdAt, "createdAt");
    OffsetDateTime updated = ProtocolValidation.requireTimestamp(updatedAt, "updatedAt");
    OffsetDateTime started =
        startedAt == null ? null : ProtocolValidation.requireTimestamp(startedAt, "startedAt");
    OffsetDateTime completed =
        completedAt == null
            ? null
            : ProtocolValidation.requireTimestamp(completedAt, "completedAt");
    if (updated.toInstant().isBefore(created.toInstant())
        || started != null && started.toInstant().isBefore(created.toInstant())
        || started != null && started.toInstant().isAfter(updated.toInstant())
        || completed != null && completed.toInstant().isAfter(updated.toInstant())
        || completed != null
            && completed
                .toInstant()
                .isBefore(started == null ? created.toInstant() : started.toInstant())) {
      throw new IllegalArgumentException("run timestamps are out of lifecycle order");
    }
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.startedAt = startedAt;
    this.completedAt = completedAt;
    this.progress = progress;
    if (progress != null) {
      OffsetDateTime progressUpdated =
          ProtocolValidation.requireTimestamp(progress.updatedAt(), "progress.updatedAt");
      if (progressUpdated.toInstant().isBefore(created.toInstant())
          || progressUpdated.toInstant().isAfter(updated.toInstant())) {
        throw new IllegalArgumentException("progress timestamp is outside the run lifecycle");
      }
    }
    this.summary = summary;
    this.output = output;
    this.artifacts = List.copyOf(Objects.requireNonNull(artifacts, "artifacts"));
    this.actions = List.copyOf(Objects.requireNonNull(actions, "actions"));
    this.problem = problem;
    this.extensions = ProtocolValidation.requireExtensions(extensions);
    validateUnion();
  }

  public static Run queued(String id, OperationDefinition operation, Instant now) {
    String timestamp = now.toString();
    return new Run(
        id,
        operation.id(),
        operation.revision(),
        0,
        RunState.QUEUED,
        timestamp,
        timestamp,
        null,
        null,
        null,
        null,
        null,
        List.of(),
        List.of(),
        null,
        JsonOwnership.object(java.util.Map.of()));
  }

  public Run running(Instant now) {
    return copy(
        sequence + 1,
        RunState.RUNNING,
        now.toString(),
        null,
        progress,
        summary,
        output,
        artifacts,
        actions,
        null);
  }

  public Run terminal(OperationResult result, Instant now) {
    return terminal(result, progress, now);
  }

  public Run terminal(OperationResult result, RunProgress finalProgress, Instant now) {
    return copy(
        sequence + 1,
        result.outcome(),
        now.toString(),
        now.toString(),
        finalProgress,
        result.summary(),
        result.output(),
        result.artifacts(),
        result.actions(),
        result.problem());
  }

  public Run failed(Problem failure, Instant now) {
    return terminated(RunState.FAILED, failure, now);
  }

  public Run terminated(RunState terminalState, Problem failure, Instant now) {
    if (terminalState == null
        || !terminalState.terminal()
        || terminalState == RunState.SUCCEEDED
        || terminalState == RunState.PARTIAL) {
      throw new IllegalArgumentException("failure terminal state is required");
    }
    return copy(
        sequence + 1,
        terminalState,
        now.toString(),
        now.toString(),
        progress,
        summary,
        null,
        artifacts,
        actions,
        Objects.requireNonNull(failure, "failure"));
  }

  private Run copy(
      long nextSequence,
      RunState nextState,
      String nextUpdated,
      String nextCompleted,
      RunProgress nextProgress,
      RunSummary nextSummary,
      JsonValue nextOutput,
      List<Artifact> nextArtifacts,
      List<FollowUpAction> nextActions,
      Problem nextProblem) {
    String nextStarted = startedAt;
    if (nextState == RunState.RUNNING && nextStarted == null) nextStarted = nextUpdated;
    return new Run(
        id,
        operationId,
        operationRevision,
        nextSequence,
        nextState,
        createdAt,
        nextUpdated,
        nextStarted,
        nextCompleted,
        nextProgress,
        nextSummary,
        nextOutput,
        nextArtifacts,
        nextActions,
        nextProblem,
        extensions);
  }

  public String id() {
    return id;
  }

  public String operationId() {
    return operationId;
  }

  public String operationRevision() {
    return operationRevision;
  }

  public long sequence() {
    return sequence;
  }

  public RunState state() {
    return state;
  }

  public String createdAt() {
    return createdAt;
  }

  public String updatedAt() {
    return updatedAt;
  }

  public String startedAt() {
    return startedAt;
  }

  public String completedAt() {
    return completedAt;
  }

  public RunProgress progress() {
    return progress;
  }

  public RunSummary summary() {
    return summary;
  }

  public JsonValue output() {
    return output;
  }

  public List<Artifact> artifacts() {
    return artifacts;
  }

  public List<FollowUpAction> actions() {
    return actions;
  }

  public Problem problem() {
    return problem;
  }

  public JsonObject extensions() {
    return extensions;
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("operationId", operationId);
          values.put("operationRevision", operationRevision);
          values.put("sequence", sequence);
          values.put("state", state.wireValue());
          values.put("createdAt", createdAt);
          values.put("updatedAt", updatedAt);
          ProtocolMap.optional(values, "startedAt", startedAt);
          ProtocolMap.optional(values, "completedAt", completedAt);
          ProtocolMap.optional(
              values, "progress", progress == null ? null : progress.toProtocolMap());
          ProtocolMap.optional(values, "summary", summary == null ? null : summary.toProtocolMap());
          ProtocolMap.optional(values, "output", output);
          values.put("artifacts", artifacts.stream().map(Artifact::toProtocolMap).toList());
          values.put("actions", actions.stream().map(FollowUpAction::toProtocolMap).toList());
          ProtocolMap.optional(values, "problem", problem == null ? null : problem.toProtocolMap());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  private void validateUnion() {
    if ((!state.terminal() && (completedAt != null || problem != null))
        || (state == RunState.SUCCEEDED && (completedAt == null || problem != null))
        || (state.terminal()
            && state != RunState.SUCCEEDED
            && (completedAt == null || problem == null))
        || (state == RunState.CANCELLED
            && !problemMatches(problem, "urn:gauntlet:problem:run-cancelled", "Run cancelled", 409))
        || (state == RunState.TIMED_OUT
            && !problemMatches(
                problem, "urn:gauntlet:problem:run-timed-out", "Run timed out", 504))) {
      throw new IllegalArgumentException("run fields do not match state");
    }
  }

  private static boolean problemMatches(Problem candidate, String type, String title, int status) {
    return candidate != null
        && type.equals(candidate.type())
        && title.equals(candidate.title())
        && status == candidate.status();
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof Run run && toProtocolMap().equals(run.toProtocolMap());
  }

  @Override
  public int hashCode() {
    return toProtocolMap().hashCode();
  }
}
