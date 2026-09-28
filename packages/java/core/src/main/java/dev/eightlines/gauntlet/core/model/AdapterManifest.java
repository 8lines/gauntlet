package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.schema.ProtocolSemantics;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;

public final class AdapterManifest {
  public static final String PROTOCOL_VERSION = "1.0";
  public static final String SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

  private final String manifestRevision;
  private final List<String> profiles;
  private final List<String> capabilities;
  private final ApplicationMetadata application;
  private final List<FeatureDefinition> features;
  private final List<OperationSummary> operations;
  private final List<DataSourceDefinition> dataSources;
  private final List<AdapterDiagnostic> diagnostics;
  private final JsonObject extensions;

  public AdapterManifest(
      List<String> profiles,
      List<String> capabilities,
      ApplicationMetadata application,
      List<FeatureDefinition> features,
      List<OperationSummary> operations,
      List<DataSourceDefinition> dataSources,
      List<AdapterDiagnostic> diagnostics,
      JsonObject extensions) {
    var requirements = new ProtocolRequirements(profiles, capabilities);
    this.profiles = requirements.profiles();
    this.capabilities = requirements.capabilities();
    this.application = Objects.requireNonNull(application, "application");
    this.features = List.copyOf(Objects.requireNonNull(features, "features"));
    this.operations = List.copyOf(Objects.requireNonNull(operations, "operations"));
    this.dataSources = List.copyOf(Objects.requireNonNull(dataSources, "dataSources"));
    this.diagnostics = List.copyOf(Objects.requireNonNull(diagnostics, "diagnostics"));
    this.extensions = ProtocolValidation.requireExtensions(extensions);
    rejectDuplicates(this.features.stream().map(FeatureDefinition::id).toList(), "feature");
    rejectDuplicates(this.operations.stream().map(OperationSummary::id).toList(), "operation");
    rejectDuplicates(
        this.dataSources.stream().map(DataSourceDefinition::id).toList(), "data source");
    this.manifestRevision = CanonicalJson.revision(toProtocolMap(false), "manifestRevision");
    if (!ProtocolSemantics.manifestIsValid(this)) {
      throw new IllegalArgumentException("manifest violates protocol semantics");
    }
  }

  public String manifestRevision() {
    return manifestRevision;
  }

  public List<String> profiles() {
    return profiles;
  }

  public List<String> capabilities() {
    return capabilities;
  }

  public ApplicationMetadata application() {
    return application;
  }

  public List<FeatureDefinition> features() {
    return features;
  }

  public List<OperationSummary> operations() {
    return operations;
  }

  public List<DataSourceDefinition> dataSources() {
    return dataSources;
  }

  public List<AdapterDiagnostic> diagnostics() {
    return diagnostics;
  }

  public JsonObject toProtocolMap() {
    return toProtocolMap(true);
  }

  public JsonObject toProtocolMap(boolean includeRevision) {
    return ProtocolMap.build(
        values -> {
          values.put("protocolVersion", PROTOCOL_VERSION);
          if (includeRevision) values.put("manifestRevision", manifestRevision);
          values.put("schemaDialect", SCHEMA_DIALECT);
          values.put("profiles", profiles);
          values.put("capabilities", capabilities);
          values.put("application", application.toProtocolMap());
          values.put("features", features.stream().map(FeatureDefinition::toProtocolMap).toList());
          values.put(
              "operations", operations.stream().map(OperationSummary::toProtocolMap).toList());
          values.put(
              "dataSources",
              dataSources.stream().map(DataSourceDefinition::toProtocolMap).toList());
          if (!diagnostics.isEmpty())
            values.put(
                "diagnostics", diagnostics.stream().map(AdapterDiagnostic::toProtocolMap).toList());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  private static void rejectDuplicates(List<String> ids, String kind) {
    if (new HashSet<>(ids).size() != ids.size())
      throw new IllegalArgumentException("duplicate " + kind + " ID");
  }
}
