package dev.eightlines.gauntlet.example;

import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import org.springframework.stereotype.Component;

@Component
@GauntletOperation(
    id = "agency-applications.fail",
    featureId = "agency-applications",
    label = "Fail agency application",
    input = FinalizeInput.class,
    definitionResource = "gauntlet/agency-applications.fail.json")
public final class FailOperation implements TypedOperationHandler<FinalizeInput> {
  @Override
  public OperationResult execute(FinalizeInput input, RunContext context) {
    throw new IllegalStateException("fixture failure for secret " + input.confirmationCode());
  }
}
