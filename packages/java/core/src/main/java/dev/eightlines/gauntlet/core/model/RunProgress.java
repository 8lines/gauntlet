package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;

public record RunProgress(
    Double current,
    Double total,
    String phase,
    String message,
    String updatedAt,
    JsonObject extensions) {
  public RunProgress {
    if (current != null && (!Double.isFinite(current) || current < 0))
      throw new IllegalArgumentException("invalid progress current");
    if (total != null && (!Double.isFinite(total) || total < 0))
      throw new IllegalArgumentException("invalid progress total");
    if (current != null && total != null && current > total)
      throw new IllegalArgumentException("progress current exceeds total");
    parseTimestamp(updatedAt);
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          ProtocolMap.optional(values, "current", current);
          ProtocolMap.optional(values, "total", total);
          ProtocolMap.optional(values, "phase", phase);
          ProtocolMap.optional(values, "message", message);
          values.put("updatedAt", updatedAt);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  static void parseTimestamp(String value) {
    ProtocolValidation.requireTimestamp(value, "timestamp");
  }
}
