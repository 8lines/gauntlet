package dev.eightlines.gauntlet.spring.catalog;

import dev.eightlines.gauntlet.core.model.Problem;
import java.util.Objects;

public final class SpringAdapterException extends RuntimeException {
  private final Problem problem;

  public SpringAdapterException(Problem problem) {
    super("adapter request rejected");
    this.problem = Objects.requireNonNull(problem, "problem");
  }

  public Problem problem() {
    return problem;
  }
}
