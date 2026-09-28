package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

public record ProtocolRequirements(List<String> profiles, List<String> capabilities) {
  private static final Pattern VERSIONED =
      Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:-]*@[1-9][0-9]*$");

  public ProtocolRequirements {
    profiles = validated(profiles, "profile");
    capabilities = validated(capabilities, "capability");
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          if (!profiles.isEmpty()) values.put("profiles", profiles);
          if (!capabilities.isEmpty()) values.put("capabilities", capabilities);
        });
  }

  private static List<String> validated(List<String> values, String kind) {
    Objects.requireNonNull(values, kind + "s");
    var copy = List.copyOf(values);
    if (copy.stream().anyMatch(value -> value == null || !VERSIONED.matcher(value).matches())
        || new HashSet<>(copy).size() != copy.size()) {
      throw new IllegalArgumentException("invalid or duplicate " + kind + " ID");
    }
    return copy;
  }
}
