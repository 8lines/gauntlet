package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;

public record FileReference(
    String uploadId,
    String name,
    String mediaType,
    long sizeBytes,
    String sha256,
    String expiresAt,
    JsonObject extensions) {
  public FileReference {
    uploadId = ProtocolId.require(uploadId);
    if (name == null || name.isEmpty()) throw new IllegalArgumentException("file name is empty");
    if (mediaType == null || mediaType.isEmpty())
      throw new IllegalArgumentException("media type is empty");
    if (sizeBytes < 0 || sizeBytes > 9_007_199_254_740_991L)
      throw new IllegalArgumentException("invalid file size");
    if (sha256 != null && !sha256.matches("^sha256:[0-9a-f]{64}$"))
      throw new IllegalArgumentException("invalid file hash");
    RunProgress.parseTimestamp(expiresAt);
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("kind", "file");
          values.put("uploadId", uploadId);
          values.put("name", name);
          values.put("mediaType", mediaType);
          values.put("sizeBytes", sizeBytes);
          ProtocolMap.optional(values, "sha256", sha256);
          values.put("expiresAt", expiresAt);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
