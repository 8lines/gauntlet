package dev.eightlines.gauntlet.example;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.Artifact;
import dev.eightlines.gauntlet.core.model.FollowUpAction;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.RunProgress;
import dev.eightlines.gauntlet.core.model.RunSummary;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
@GauntletOperation(
    id = "agency-applications.finalize",
    featureId = "agency-applications",
    label = "Finalize agency application",
    input = FinalizeInput.class,
    definitionResource = "gauntlet/agency-applications.finalize.json")
public final class FinalizeOperation implements TypedOperationHandler<FinalizeInput> {
  private final Clock clock;

  public FinalizeOperation(Clock clock) {
    this.clock = clock;
  }

  @Override
  public OperationResult execute(FinalizeInput input, RunContext context) {
    context.report(
        new RunProgress(
            1.0, 1.0, "finalize", "Application finalized", clock.instant().toString(), empty()));
    context.addArtifact(
        new Artifact(
            "finalize-result",
            "notice",
            "Finalization result",
            JsonOwnership.object(Map.of("level", "success", "message", "Application finalized")),
            empty()));
    context.addAction(
        FollowUpAction.openLink(
            "Open application",
            "https://portal.example.test/applications/" + input.applicationId()));
    return OperationResult.succeeded(
        new RunSummary("Application finalized", "The workflow is complete.", "success", empty()),
        JsonOwnership.object(Map.of("finalized", true)),
        List.of(),
        List.of());
  }

  private static dev.eightlines.gauntlet.core.json.JsonObject empty() {
    return JsonOwnership.object(Map.of());
  }
}
