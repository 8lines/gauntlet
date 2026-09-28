package dev.eightlines.gauntlet.spring.capability;

import dev.eightlines.gauntlet.core.model.RunEvent;

@FunctionalInterface
public interface RunEventsEndpoint {
  Iterable<RunEvent> events(String runId, String lastEventId) throws Exception;
}
