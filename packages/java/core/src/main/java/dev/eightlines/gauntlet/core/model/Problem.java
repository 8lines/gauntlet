package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

public record Problem(
    String type,
    String title,
    int status,
    String detail,
    String instance,
    String correlationId,
    List<ValidationError> errors,
    String capability,
    JsonObject extensions) {
  private static final Pattern TYPE =
      Pattern.compile("^urn:gauntlet:problem:[A-Za-z0-9][A-Za-z0-9._:-]*$");

  public Problem(String type, String title, int status) {
    this(
        type,
        title,
        status,
        null,
        null,
        null,
        List.of(),
        null,
        JsonOwnership.object(java.util.Map.of()));
  }

  public Problem {
    if (type == null || !TYPE.matcher(type).matches())
      throw new IllegalArgumentException("invalid problem type");
    if (title == null || title.isEmpty())
      throw new IllegalArgumentException("problem title is blank");
    if (status < 100 || status > 599) throw new IllegalArgumentException("invalid problem status");
    errors = List.copyOf(Objects.requireNonNull(errors, "errors"));
    if (capability != null) new ProtocolRequirements(List.of(), List.of(capability));
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("type", type);
          values.put("title", title);
          values.put("status", status);
          ProtocolMap.optional(values, "detail", detail);
          ProtocolMap.optional(values, "instance", instance);
          ProtocolMap.optional(values, "correlationId", correlationId);
          if (!errors.isEmpty())
            values.put("errors", errors.stream().map(ValidationError::toProtocolMap).toList());
          ProtocolMap.optional(values, "capability", capability);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
