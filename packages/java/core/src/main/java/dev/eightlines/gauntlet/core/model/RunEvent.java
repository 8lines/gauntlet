package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;

public record RunEvent(
    String id, long sequence, String occurredAt, String type, Run run, JsonObject extensions) {
  public RunEvent {
    id = ProtocolId.require(id);
    if (sequence < 0 || sequence > ProtocolValidation.MAX_SAFE_INTEGER) {
      throw new IllegalArgumentException("invalid event sequence");
    }
    ProtocolValidation.requireTimestamp(occurredAt, "occurredAt");
    if (!"run.updated".equals(type))
      throw new IllegalArgumentException("unsupported run event type");
    run = Objects.requireNonNull(run, "run");
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("sequence", sequence);
          values.put("occurredAt", occurredAt);
          values.put("type", type);
          values.put("run", run.toProtocolMap());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
