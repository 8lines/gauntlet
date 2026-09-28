package dev.eightlines.gauntlet.core.spi;

import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.ValidationError;
import java.util.List;

public interface OperationHandler<I> {
  OperationDefinition definition();

  /** Validates framework-specific input binding before a Run is reserved. */
  default List<ValidationError> validateInput(I input) {
    return List.of();
  }

  OperationResult execute(I input, RunContext context) throws Exception;
}
