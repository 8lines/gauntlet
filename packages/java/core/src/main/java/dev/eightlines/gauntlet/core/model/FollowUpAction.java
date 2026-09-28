package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.Objects;
import java.util.Set;

public final class FollowUpAction {
  private final String kind;
  private final String label;
  private final String operationId;
  private final JsonObject input;
  private final String url;
  private final String artifactId;

  private FollowUpAction(
      String kind,
      String label,
      String operationId,
      JsonObject input,
      String url,
      String artifactId) {
    this.kind = Objects.requireNonNull(kind, "kind");
    this.label = Objects.requireNonNull(label, "label");
    this.operationId = operationId;
    this.input = input;
    this.url = url;
    this.artifactId = artifactId;
    if (!Set.of("invoke-operation", "open-link", "browser-launch").contains(kind)) {
      throw new IllegalArgumentException("unsupported follow-up action");
    }
  }

  public static FollowUpAction invokeOperation(String label, String operationId, JsonObject input) {
    return new FollowUpAction(
        "invoke-operation", label, ProtocolId.require(operationId), input, null, null);
  }

  public static FollowUpAction openLink(String label, String url) {
    ProtocolValidation.requireHttpUrl(url, "follow-up URL");
    return new FollowUpAction("open-link", label, null, null, url, null);
  }

  public static FollowUpAction browserLaunch(String label, String artifactId) {
    return new FollowUpAction(
        "browser-launch", label, null, null, null, ProtocolId.require(artifactId));
  }

  public String kind() {
    return kind;
  }

  public String label() {
    return label;
  }

  public String operationId() {
    return operationId;
  }

  public JsonObject input() {
    return input;
  }

  public String url() {
    return url;
  }

  public String artifactId() {
    return artifactId;
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("kind", kind);
          values.put("label", label);
          ProtocolMap.optional(values, "operationId", operationId);
          ProtocolMap.optional(values, "input", input);
          ProtocolMap.optional(values, "url", url);
          ProtocolMap.optional(values, "artifactId", artifactId);
        });
  }
}
