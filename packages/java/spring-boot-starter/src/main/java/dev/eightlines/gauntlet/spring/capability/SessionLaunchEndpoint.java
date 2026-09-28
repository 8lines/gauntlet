package dev.eightlines.gauntlet.spring.capability;

import dev.eightlines.gauntlet.core.model.SessionLaunchResponse;

@FunctionalInterface
public interface SessionLaunchEndpoint {
  SessionLaunchResponse launch(String runId, String artifactId) throws Exception;
}
