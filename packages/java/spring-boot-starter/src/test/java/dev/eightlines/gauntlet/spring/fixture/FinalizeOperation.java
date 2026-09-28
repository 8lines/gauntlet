package dev.eightlines.gauntlet.spring.fixture;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
@GauntletOperation(
    id = "applications.finalize",
    featureId = "applications",
    label = "Finalize application",
    input = FinalizeInput.class,
    idempotency = Idempotency.OPTIONAL)
public final class FinalizeOperation implements TypedOperationHandler<FinalizeInput> {
  @Override
  public OperationResult execute(FinalizeInput input, RunContext context) {
    if ("throw".equals(input.reason())) {
      throw new IllegalStateException("fixture boom");
    }
    return OperationResult.succeeded(
        null,
        JsonOwnership.object(Map.of("applicationId", input.applicationId().toString())),
        List.of(),
        List.of());
  }
}
