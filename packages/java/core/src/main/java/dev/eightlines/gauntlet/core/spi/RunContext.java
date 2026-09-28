package dev.eightlines.gauntlet.core.spi;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.model.Artifact;
import dev.eightlines.gauntlet.core.model.FollowUpAction;
import dev.eightlines.gauntlet.core.model.InvocationContext;
import dev.eightlines.gauntlet.core.model.RunProgress;
import java.util.Optional;

public interface RunContext {
  String runId();

  String operationId();

  boolean isDryRun();

  Optional<InvocationContext> invocationContext();

  void report(RunProgress progress);

  void addArtifact(Artifact artifact);

  void addAction(FollowUpAction action);

  void log(String level, String message, JsonObject fields);

  void warn(String message);

  boolean isCancellationRequested();

  void throwIfCancelled();
}
