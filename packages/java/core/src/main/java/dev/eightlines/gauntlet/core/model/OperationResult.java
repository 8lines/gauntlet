package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.util.List;
import java.util.Objects;

public final class OperationResult {
  private final RunState outcome;
  private final RunSummary summary;
  private final JsonValue output;
  private final List<Artifact> artifacts;
  private final List<FollowUpAction> actions;
  private final Problem problem;
  private final JsonObject extensions;

  private OperationResult(
      RunState outcome,
      RunSummary summary,
      JsonValue output,
      List<Artifact> artifacts,
      List<FollowUpAction> actions,
      Problem problem,
      JsonObject extensions) {
    if (outcome != RunState.SUCCEEDED && outcome != RunState.PARTIAL) {
      throw new IllegalArgumentException("operation result must be succeeded or partial");
    }
    if ((outcome == RunState.PARTIAL) != (problem != null)) {
      throw new IllegalArgumentException("partial operation result requires a problem");
    }
    this.outcome = outcome;
    this.summary = summary;
    this.output = output;
    this.artifacts = List.copyOf(Objects.requireNonNull(artifacts, "artifacts"));
    this.actions = List.copyOf(Objects.requireNonNull(actions, "actions"));
    this.problem = problem;
    this.extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public static OperationResult succeeded(JsonValue output) {
    return succeeded(null, output, List.of(), List.of());
  }

  public static OperationResult succeeded(
      RunSummary summary,
      JsonValue output,
      List<Artifact> artifacts,
      List<FollowUpAction> actions) {
    return new OperationResult(
        RunState.SUCCEEDED,
        summary,
        output,
        artifacts,
        actions,
        null,
        JsonOwnership.object(java.util.Map.of()));
  }

  public static OperationResult partial(
      RunSummary summary,
      JsonValue output,
      List<Artifact> artifacts,
      List<FollowUpAction> actions,
      Problem problem) {
    return new OperationResult(
        RunState.PARTIAL,
        summary,
        output,
        artifacts,
        actions,
        Objects.requireNonNull(problem, "problem"),
        JsonOwnership.object(java.util.Map.of()));
  }

  public RunState outcome() {
    return outcome;
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
}
