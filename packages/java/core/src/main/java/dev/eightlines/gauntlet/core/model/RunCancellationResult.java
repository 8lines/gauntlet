package dev.eightlines.gauntlet.core.model;

import java.util.Objects;

/** A cancellation request returns either the authoritative run snapshot or a typed Problem. */
public final class RunCancellationResult {
  private final Run run;
  private final Problem problem;

  private RunCancellationResult(Run run, Problem problem) {
    if ((run == null) == (problem == null)) {
      throw new IllegalArgumentException("exactly one result branch is required");
    }
    this.run = run;
    this.problem = problem;
  }

  public static RunCancellationResult success(Run run) {
    return new RunCancellationResult(Objects.requireNonNull(run, "run"), null);
  }

  public static RunCancellationResult failure(Problem problem) {
    return new RunCancellationResult(null, Objects.requireNonNull(problem, "problem"));
  }

  public boolean isSuccess() {
    return run != null;
  }

  public Run run() {
    return run;
  }

  public Problem problem() {
    return problem;
  }
}
