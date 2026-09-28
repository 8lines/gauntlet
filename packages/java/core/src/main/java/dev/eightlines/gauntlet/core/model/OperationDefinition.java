package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.schema.PlacementRules;
import dev.eightlines.gauntlet.core.schema.TcSchemaCore;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;

public final class OperationDefinition {
  private final String id;
  private final String revision;
  private final String featureId;
  private final String label;
  private final String description;
  private final JsonObject inputSchema;
  private final InputHandling inputHandling;
  private final JsonObject contextSchema;
  private final OperationUiSchema uiSchema;
  private final List<DataSourceReference> dataSources;
  private final List<OperationPreset> presets;
  private final ExecutionPolicy execution;
  private final OperationOutput output;
  private final String icon;
  private final int order;
  private final List<String> tags;
  private final ProtocolRequirements requirements;
  private final JsonObject extensions;
  private final List<OperationPlacement> placements;

  public OperationDefinition(
      String id,
      String featureId,
      String label,
      String description,
      JsonObject inputSchema,
      InputHandling inputHandling,
      JsonObject contextSchema,
      OperationUiSchema uiSchema,
      List<DataSourceReference> dataSources,
      List<OperationPreset> presets,
      ExecutionPolicy execution,
      OperationOutput output,
      String icon,
      int order,
      List<String> tags,
      ProtocolRequirements requirements,
      JsonObject extensions) {
    this(
        id,
        featureId,
        label,
        description,
        inputSchema,
        inputHandling,
        contextSchema,
        uiSchema,
        dataSources,
        presets,
        execution,
        output,
        icon,
        order,
        tags,
        requirements,
        extensions,
        List.of());
  }

  public OperationDefinition(
      String id,
      String featureId,
      String label,
      String description,
      JsonObject inputSchema,
      InputHandling inputHandling,
      JsonObject contextSchema,
      OperationUiSchema uiSchema,
      List<DataSourceReference> dataSources,
      List<OperationPreset> presets,
      ExecutionPolicy execution,
      OperationOutput output,
      String icon,
      int order,
      List<String> tags,
      ProtocolRequirements requirements,
      JsonObject extensions,
      List<OperationPlacement> placements) {
    this.id = ProtocolId.require(id);
    this.featureId = ProtocolId.require(featureId);
    if (label == null || label.isEmpty())
      throw new IllegalArgumentException("operation label is blank");
    this.label = label;
    this.description = description;
    this.inputSchema = Objects.requireNonNull(inputSchema, "inputSchema");
    TcSchemaCore.assertValid(inputSchema, true);
    this.inputHandling = inputHandling;
    this.contextSchema = contextSchema;
    if (contextSchema != null) TcSchemaCore.assertValid(contextSchema, true);
    this.uiSchema = uiSchema;
    this.dataSources = List.copyOf(Objects.requireNonNull(dataSources, "dataSources"));
    this.presets = List.copyOf(Objects.requireNonNull(presets, "presets"));
    rejectDuplicateIds(
        this.dataSources.stream().map(DataSourceReference::id).toList(), "data source");
    rejectDuplicateIds(this.presets.stream().map(OperationPreset::id).toList(), "preset");
    this.execution = Objects.requireNonNull(execution, "execution");
    this.output = Objects.requireNonNull(output, "output");
    this.icon = icon;
    this.order = order;
    this.tags = List.copyOf(Objects.requireNonNull(tags, "tags"));
    if (new HashSet<>(this.tags).size() != this.tags.size())
      throw new IllegalArgumentException("duplicate tag");
    this.requirements = requirements;
    this.extensions = ProtocolValidation.requireExtensions(extensions);
    this.placements = List.copyOf(Objects.requireNonNull(placements, "placements"));
    this.revision = CanonicalJson.revision(toProtocolMap(false), "revision");
    if (!this.placements.isEmpty()) {
      JsonObject wire = toProtocolMap(false);
      List<String> guarded =
          inputHandling == null
              ? List.of()
              : inputHandling.rules().stream()
                  .map(rule -> String.valueOf(rule.get("schemaPointer").unwrap()))
                  .toList();
      if (!PlacementRules.areValid(inputSchema, guarded, (JsonList) wire.get("placements")))
        throw new IllegalArgumentException("operation placements are invalid");
    }
  }

  public String id() {
    return id;
  }

  public String revision() {
    return revision;
  }

  public String featureId() {
    return featureId;
  }

  public String label() {
    return label;
  }

  public String description() {
    return description;
  }

  public JsonObject inputSchema() {
    return inputSchema;
  }

  public InputHandling inputHandling() {
    return inputHandling;
  }

  public JsonObject contextSchema() {
    return contextSchema;
  }

  public OperationUiSchema uiSchema() {
    return uiSchema;
  }

  public List<DataSourceReference> dataSources() {
    return dataSources;
  }

  public List<OperationPreset> presets() {
    return presets;
  }

  public ExecutionPolicy execution() {
    return execution;
  }

  public OperationOutput output() {
    return output;
  }

  public String icon() {
    return icon;
  }

  public int order() {
    return order;
  }

  public List<String> tags() {
    return tags;
  }

  public ProtocolRequirements requirements() {
    return requirements;
  }

  public JsonObject extensions() {
    return extensions;
  }

  public List<OperationPlacement> placements() {
    return placements;
  }

  public JsonObject toProtocolMap() {
    return toProtocolMap(true);
  }

  public JsonObject toProtocolMap(boolean includeRevision) {
    return ProtocolMap.build(
        values -> {
          values.put("id", id);
          if (includeRevision) values.put("revision", revision);
          values.put("label", label);
          values.put("featureId", featureId);
          ProtocolMap.optional(values, "description", description);
          ProtocolMap.optional(values, "icon", icon);
          values.put("order", order);
          values.put("tags", tags);
          ProtocolMap.optional(
              values, "requirements", requirements == null ? null : requirements.toProtocolMap());
          if (!placements.isEmpty())
            values.put(
                "placements", placements.stream().map(OperationPlacement::toProtocolMap).toList());
          values.put("inputSchema", inputSchema);
          ProtocolMap.optional(
              values,
              "inputHandling",
              inputHandling == null ? null : inputHandling.toProtocolMap());
          ProtocolMap.optional(values, "contextSchema", contextSchema);
          ProtocolMap.optional(
              values, "uiSchema", uiSchema == null ? null : uiSchema.toProtocolMap());
          values.put(
              "dataSources", dataSources.stream().map(DataSourceReference::toProtocolMap).toList());
          values.put("presets", presets.stream().map(OperationPreset::toProtocolMap).toList());
          values.put("execution", execution.toProtocolMap());
          values.put("output", output.toProtocolMap());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  private static void rejectDuplicateIds(List<String> ids, String kind) {
    if (new HashSet<>(ids).size() != ids.size())
      throw new IllegalArgumentException("duplicate " + kind + " ID");
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof OperationDefinition operation
        && toProtocolMap().equals(operation.toProtocolMap());
  }

  @Override
  public int hashCode() {
    return toProtocolMap().hashCode();
  }
}
