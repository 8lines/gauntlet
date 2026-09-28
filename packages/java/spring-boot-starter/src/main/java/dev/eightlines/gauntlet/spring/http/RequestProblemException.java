package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.model.Problem;
import java.util.Objects;

public final class RequestProblemException extends RuntimeException {
  private final Problem problem;

  public RequestProblemException(Problem problem) {
    super("adapter request rejected");
    this.problem = Objects.requireNonNull(problem, "problem");
  }

  public Problem problem() {
    return problem;
  }
}
