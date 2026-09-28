package dev.eightlines.gauntlet.core.spi;

import dev.eightlines.gauntlet.core.model.Run;
import java.util.Objects;

public record RunStoreCreateResult(Run run, boolean created) {
  public RunStoreCreateResult {
    run = Objects.requireNonNull(run, "run");
  }

  public static RunStoreCreateResult created(Run run) {
    return new RunStoreCreateResult(run, true);
  }

  public static RunStoreCreateResult duplicate(Run run) {
    return new RunStoreCreateResult(run, false);
  }
}
