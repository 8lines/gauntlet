package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.List;
import java.util.Objects;

public final class OperationSummary {
  private final String id;
  private final String revision;
  private final String label;
  private final String featureId;
  private final Problem unavailableProblem;
  private final ProtocolRequirements requirements;
  private final JsonObject extensions;
  private final List<OperationPlacement> placements;

  private OperationSummary(OperationDefinition operation, Problem unavailableProblem) {
    this.id = operation.id();
    this.revision = operation.revision();
    this.label = operation.label();
    this.featureId = operation.featureId();
    this.unavailableProblem = unavailableProblem;
    this.requirements = operation.requirements();
    this.extensions = operation.extensions();
    this.placements = operation.placements();
  }

  public static OperationSummary available(OperationDefinition operation) {
    return new OperationSummary(Objects.requireNonNull(operation, "operation"), null);
  }

  public static OperationSummary unavailable(OperationDefinition operation, Problem problem) {
    return new OperationSummary(
        Objects.requireNonNull(operation, "operation"), Objects.requireNonNull(problem, "problem"));
  }

  public String id() {
    return id;
  }

  public String revision() {
    return revision;
  }

  public String label() {
    return label;
  }

  public String featureId() {
    return featureId;
  }

  public boolean available() {
    return unavailableProblem == null;
  }

  public Problem unavailableProblem() {
    return unavailableProblem;
  }

  public ProtocolRequirements requirements() {
    return requirements;
  }

  public List<OperationPlacement> placements() {
    return placements;
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          values.put("revision", revision);
          values.put("label", label);
          values.put("featureId", featureId);
          values.put(
              "availability",
              available()
                  ? java.util.Map.of("state", "available")
                  : java.util.Map.of(
                      "state", "unavailable", "problem", unavailableProblem.toProtocolMap()));
          ProtocolMap.optional(
              values, "requirements", requirements == null ? null : requirements.toProtocolMap());
          if (!placements.isEmpty())
            values.put(
                "placements", placements.stream().map(OperationPlacement::toProtocolMap).toList());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
