package dev.eightlines.gauntlet.core.model;

import java.util.Objects;

public final class RunCreationResult {
  private final Run run;
  private final Problem problem;

  private RunCreationResult(Run run, Problem problem) {
    if ((run == null) == (problem == null))
      throw new IllegalArgumentException("exactly one result branch is required");
    this.run = run;
    this.problem = problem;
  }

  public static RunCreationResult success(Run run) {
    return new RunCreationResult(Objects.requireNonNull(run, "run"), null);
  }

  public static RunCreationResult failure(Problem problem) {
    return new RunCreationResult(null, Objects.requireNonNull(problem, "problem"));
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
