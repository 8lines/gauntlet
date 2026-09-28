package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;

public record UploadResponse(FileReference file, JsonObject extensions) {
  public UploadResponse {
    file = Objects.requireNonNull(file, "file");
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("file", file.toProtocolMap());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
