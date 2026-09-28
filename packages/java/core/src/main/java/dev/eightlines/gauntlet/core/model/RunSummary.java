package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;
import java.util.Set;

public record RunSummary(String title, String message, String tone, JsonObject extensions) {
  public RunSummary {
    title = Objects.requireNonNull(title, "title");
    if (!Set.of("neutral", "success", "warning", "error").contains(tone)) {
      throw new IllegalArgumentException("unsupported summary tone");
    }
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("title", title);
          ProtocolMap.optional(values, "message", message);
          values.put("tone", tone);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
