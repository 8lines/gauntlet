package dev.eightlines.gauntlet.spring.spi;

import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.spi.RunContext;

public interface TypedOperationHandler<I> {
  OperationResult execute(I input, RunContext context) throws Exception;
}
