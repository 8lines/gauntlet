package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;

public record AdapterHealth(String status, String protocolVersion, JsonObject extensions) {
  public AdapterHealth {
    if (!"ok".equals(status)) throw new IllegalArgumentException("health status must be ok");
    if (protocolVersion == null || !protocolVersion.matches("^1\\.(0|[1-9][0-9]*)$")) {
      throw new IllegalArgumentException("unsupported protocol version");
    }
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("status", status);
          values.put("protocolVersion", protocolVersion);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
