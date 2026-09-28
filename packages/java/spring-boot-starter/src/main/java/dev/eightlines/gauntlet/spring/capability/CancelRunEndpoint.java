package dev.eightlines.gauntlet.spring.capability;

import dev.eightlines.gauntlet.core.model.Run;

@FunctionalInterface
public interface CancelRunEndpoint {
  Run cancel(String runId) throws Exception;
}
