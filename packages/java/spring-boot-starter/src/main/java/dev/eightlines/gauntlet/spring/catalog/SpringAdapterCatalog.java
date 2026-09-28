package dev.eightlines.gauntlet.spring.catalog;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.AdapterDiagnostic;
import dev.eightlines.gauntlet.core.model.AdapterHealth;
import dev.eightlines.gauntlet.core.model.AdapterManifest;
import dev.eightlines.gauntlet.core.model.ApplicationMetadata;
import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.model.DataSourceDefinition;
import dev.eightlines.gauntlet.core.model.DataSourcePage;
import dev.eightlines.gauntlet.core.model.DataSourceQuery;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;
import dev.eightlines.gauntlet.core.model.EnvironmentDescriptor;
import dev.eightlines.gauntlet.core.model.EnvironmentKind;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.FeatureDefinition;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationOutput;
import dev.eightlines.gauntlet.core.model.OperationPlacement;
import dev.eightlines.gauntlet.core.model.OperationSummary;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.ProtocolId;
import dev.eightlines.gauntlet.core.model.ProtocolRequirements;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunCreationResult;
import dev.eightlines.gauntlet.core.model.ValidationError;
import dev.eightlines.gauntlet.core.registry.DataSourceRegistry;
import dev.eightlines.gauntlet.core.registry.FeatureRegistry;
import dev.eightlines.gauntlet.core.registry.OperationRegistry;
import dev.eightlines.gauntlet.core.run.RunManager;
import dev.eightlines.gauntlet.core.schema.PlacementRules;
import dev.eightlines.gauntlet.core.schema.SchemaValidator;
import dev.eightlines.gauntlet.core.schema.TcSchemaCore;
import dev.eightlines.gauntlet.core.spi.ExecutionCoordinator;
import dev.eightlines.gauntlet.core.spi.FileReferenceValidator;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.spring.GauntletApplicationProperties;
import dev.eightlines.gauntlet.spring.GauntletProperties;
import dev.eightlines.gauntlet.spring.annotation.GauntletDataSource;
import dev.eightlines.gauntlet.spring.annotation.GauntletFeature;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.annotation.PlacementBinding;
import dev.eightlines.gauntlet.spring.annotation.SubjectPlacement;
import dev.eightlines.gauntlet.spring.capability.SpringCapabilityRegistry;
import dev.eightlines.gauntlet.spring.spi.TypedDataSource;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import jakarta.validation.Validator;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.core.ResolvableType;
import org.springframework.core.annotation.AnnotatedElementUtils;
import tools.jackson.databind.ObjectMapper;

/** Immutable catalog built only from explicitly annotated application beans. */
public final class SpringAdapterCatalog implements AutoCloseable {
  private final AdapterManifest manifest;
  private final Map<String, OperationDefinition> definitions;
  private final Map<String, OperationSummary> summaries;
  private final DataSourceRegistry dataSources;
  private final RunManager runs;
  private final SchemaValidator schemaValidator;
  private final SpringCapabilityRegistry capabilities;

  public SpringAdapterCatalog(
      GauntletProperties properties,
      SpringCapabilityRegistry capabilities,
      ListableBeanFactory beanFactory,
      RecordSchemaFactory recordSchemas,
      ObjectMapper objectMapper,
      Validator beanValidator,
      SchemaValidator schemaValidator,
      RunStore runStore,
      FileReferenceValidator fileReferenceValidator,
      IdempotencySecret idempotencySecret,
      Clock clock) {
    this(
        properties,
        capabilities,
        beanFactory,
        recordSchemas,
        objectMapper,
        beanValidator,
        schemaValidator,
        runStore,
        new dev.eightlines.gauntlet.core.run.InMemoryExecutionCoordinator(),
        fileReferenceValidator,
        idempotencySecret,
        clock);
  }

  public SpringAdapterCatalog(
      GauntletProperties properties,
      SpringCapabilityRegistry capabilities,
      ListableBeanFactory beanFactory,
      RecordSchemaFactory recordSchemas,
      ObjectMapper objectMapper,
      Validator beanValidator,
      SchemaValidator schemaValidator,
      RunStore runStore,
      ExecutionCoordinator executionCoordinator,
      FileReferenceValidator fileReferenceValidator,
      IdempotencySecret idempotencySecret,
      Clock clock) {
    Objects.requireNonNull(properties, "properties");
    this.capabilities = Objects.requireNonNull(capabilities, "capabilities");
    Objects.requireNonNull(beanFactory, "beanFactory");
    Objects.requireNonNull(recordSchemas, "recordSchemas");
    Objects.requireNonNull(objectMapper, "objectMapper");
    Objects.requireNonNull(beanValidator, "beanValidator");
    this.schemaValidator = Objects.requireNonNull(schemaValidator, "schemaValidator");
    Objects.requireNonNull(runStore, "runStore");
    Objects.requireNonNull(executionCoordinator, "executionCoordinator");
    Objects.requireNonNull(idempotencySecret, "idempotencySecret");
    Objects.requireNonNull(clock, "clock");

    var diagnostics = new ArrayList<AdapterDiagnostic>(capabilities.diagnostics());
    List<FeatureDefinition> featureDefinitions = scanFeatures(beanFactory, diagnostics);
    var featureRegistry = new FeatureRegistry(featureDefinitions);
    List<SpringDataSourceBinding> dataSourceBindings = scanDataSources(beanFactory, diagnostics);
    this.dataSources = new DataSourceRegistry();
    dataSourceBindings.forEach(this.dataSources::register);
    List<SpringOperationBinding> operationBindings =
        scanOperations(
            beanFactory,
            recordSchemas,
            objectMapper,
            beanValidator,
            featureRegistry,
            this.dataSources,
            diagnostics);

    var operationRegistry = new OperationRegistry(featureRegistry);
    var acceptedBindings = new ArrayList<SpringOperationBinding>();
    for (SpringOperationBinding binding : operationBindings) {
      try {
        operationRegistry.register(binding);
        acceptedBindings.add(binding);
      } catch (RuntimeException exception) {
        diagnostics.add(diagnostic("invalid-operation-binding", binding.definition().id()));
      }
    }

    var availableProfiles = new HashSet<>(properties.profiles());
    var availableCapabilities = new HashSet<>(capabilities.ids());
    var operationSummaries = new ArrayList<OperationSummary>();
    var definitionIndex = new LinkedHashMap<String, OperationDefinition>();
    for (SpringOperationBinding binding :
        acceptedBindings.stream()
            .sorted(Comparator.comparing(value -> value.definition().id()))
            .toList()) {
      OperationDefinition definition = binding.definition();
      ProtocolRequirements requirements = definition.requirements();
      boolean available =
          requirements == null
              || availableProfiles.containsAll(requirements.profiles())
                  && availableCapabilities.containsAll(requirements.capabilities());
      operationSummaries.add(
          available
              ? OperationSummary.available(definition)
              : OperationSummary.unavailable(definition, unavailableOperation()));
      definitionIndex.put(definition.id(), definition);
    }
    diagnostics.sort(
        Comparator.comparing(AdapterDiagnostic::code)
            .thenComparing(value -> value.operationId() == null ? "" : value.operationId()));

    this.manifest =
        new AdapterManifest(
            profilesWithPlacements(properties.profiles(), operationSummaries),
            capabilities.ids(),
            application(properties),
            featureDefinitions,
            operationSummaries,
            this.dataSources.definitions(),
            diagnostics,
            empty());
    this.definitions = Map.copyOf(definitionIndex);
    this.summaries =
        Map.copyOf(
            operationSummaries.stream()
                .collect(
                    LinkedHashMap::new,
                    (values, value) -> values.put(value.id(), value),
                    LinkedHashMap::putAll));
    this.runs =
        new RunManager(
            operationRegistry,
            runStore,
            schemaValidator,
            fileReferenceValidator,
            idempotencySecret.copyForRuntime(),
            clock,
            () -> "run-" + UUID.randomUUID(),
            executionCoordinator);
  }

  public AdapterHealth health() {
    return new AdapterHealth("ok", AdapterManifest.PROTOCOL_VERSION, empty());
  }

  public AdapterManifest manifest() {
    return manifest;
  }

  public Optional<OperationDefinition> operation(String id) {
    try {
      return Optional.ofNullable(definitions.get(ProtocolId.require(id)));
    } catch (RuntimeException exception) {
      return Optional.empty();
    }
  }

  public Optional<OperationSummary> operationSummary(String id) {
    try {
      return Optional.ofNullable(summaries.get(ProtocolId.require(id)));
    } catch (RuntimeException exception) {
      return Optional.empty();
    }
  }

  /** The authoritative preflight shared by manifest serialization and invocation. */
  public Optional<Problem> operationProblem(String id) {
    OperationSummary summary;
    try {
      summary = summaries.get(ProtocolId.require(id));
    } catch (RuntimeException exception) {
      return Optional.of(operationNotFound());
    }
    if (summary == null) return Optional.of(operationNotFound());
    return summary.available() ? Optional.empty() : Optional.of(summary.unavailableProblem());
  }

  /** Rechecks summary availability immediately before Core request processing. */
  public RunCreationResult createRun(String operationId, CreateRunRequest request) {
    Optional<Problem> unavailable = operationProblem(operationId);
    if (unavailable.isPresent()) return RunCreationResult.failure(unavailable.orElseThrow());
    return runs.create(operationId, request);
  }

  public Optional<Run> run(String id) {
    return runs.get(id);
  }

  public Run cancelRun(String id) {
    var result = runs.cancel(id);
    if (!result.isSuccess()) throw new SpringAdapterException(result.problem());
    return result.run();
  }

  @Override
  public void close() {
    runs.close();
  }

  /** Applies Core's full catalog-aware projection validation to an external snapshot. */
  public boolean runProjectionIsValid(Run run, String expectedRunId, String expectedOperationId) {
    return runs.runProjectionIsValid(run, expectedRunId, expectedOperationId);
  }

  public Optional<DataSourceDefinition> dataSourceDefinition(String id) {
    try {
      return dataSources.find(ProtocolId.require(id)).map(source -> source.definition());
    } catch (RuntimeException exception) {
      return Optional.empty();
    }
  }

  public DataSourcePage queryDataSource(String id, DataSourceQuery request) throws Exception {
    var source =
        dataSources.find(id).orElseThrow(() -> new SpringAdapterException(dataSourceNotFound()));
    DataSourceDefinition definition = source.definition();
    if (!definition.search() && request.search() != null
        || request.limit() != null && request.limit() > definition.maxLimit()) {
      throw new SpringAdapterException(validationProblem(List.of()));
    }
    validateEnvelope(definition.dependencySchema(), request.dependencies(), "/dependencies");
    validateEnvelope(
        definition.contextSchema(),
        request.context() == null ? empty() : request.context().toProtocolMap(),
        "/context");
    DataSourcePage page = Objects.requireNonNull(source.query(request), "data source page");
    CanonicalJson.encode(page.toProtocolMap());
    return page;
  }

  public DataSourceResolveResponse resolveDataSource(String id, DataSourceResolveRequest request)
      throws Exception {
    var source =
        dataSources.find(id).orElseThrow(() -> new SpringAdapterException(dataSourceNotFound()));
    DataSourceDefinition definition = source.definition();
    validateEnvelope(definition.dependencySchema(), request.dependencies(), "/dependencies");
    validateEnvelope(
        definition.contextSchema(),
        request.context() == null ? empty() : request.context().toProtocolMap(),
        "/context");
    DataSourceResolveResponse response =
        Objects.requireNonNull(source.resolve(request), "data source resolve response");
    response =
        DataSourceResolveResponse.forRequest(request, response.results(), response.extensions());
    CanonicalJson.encode(response.toProtocolMap());
    return response;
  }

  public SpringCapabilityRegistry capabilities() {
    return capabilities;
  }

  private void validateEnvelope(JsonObject schema, JsonObject value, String prefix) {
    if (schema == null) return;
    List<ValidationError> errors =
        Objects.requireNonNull(schemaValidator.validate(schema, value), "schema validation errors");
    if (!errors.isEmpty()) {
      List<ValidationError> prefixed =
          errors.stream()
              .map(
                  error ->
                      new ValidationError(
                          prefix + error.instancePath(),
                          error.schemaPath(),
                          error.keyword(),
                          "value does not satisfy schema",
                          empty()))
              .toList();
      throw new SpringAdapterException(validationProblem(prefixed));
    }
  }

  private static List<FeatureDefinition> scanFeatures(
      ListableBeanFactory beanFactory, List<AdapterDiagnostic> diagnostics) {
    var candidates = new ArrayList<FeatureDefinition>();
    var counts = new HashMap<String, Integer>();
    for (String beanName : beanFactory.getBeanNamesForAnnotation(GauntletFeature.class)) {
      Class<?> type = beanFactory.getType(beanName);
      GauntletFeature annotation =
          type == null
              ? null
              : AnnotatedElementUtils.findMergedAnnotation(type, GauntletFeature.class);
      if (annotation == null) continue;
      try {
        var definition =
            new FeatureDefinition(
                annotation.id(),
                annotation.label(),
                emptyToNull(annotation.parentId()),
                annotation.order(),
                empty());
        candidates.add(definition);
        counts.merge(definition.id(), 1, Integer::sum);
      } catch (RuntimeException exception) {
        diagnostics.add(diagnostic("invalid-feature-binding", null));
      }
    }
    var unique = new LinkedHashMap<String, FeatureDefinition>();
    for (FeatureDefinition candidate : candidates) {
      if (counts.get(candidate.id()) == 1) unique.put(candidate.id(), candidate);
      else diagnostics.add(diagnostic("duplicate-feature-id", null));
    }

    var ordered = new ArrayList<FeatureDefinition>();
    var remaining = new LinkedHashMap<>(unique);
    boolean changed;
    do {
      changed = false;
      for (FeatureDefinition feature :
          List.copyOf(remaining.values()).stream()
              .sorted(Comparator.comparing(FeatureDefinition::id))
              .toList()) {
        if (feature.parentId() == null
            || ordered.stream().anyMatch(parent -> parent.id().equals(feature.parentId()))) {
          ordered.add(feature);
          remaining.remove(feature.id());
          changed = true;
        }
      }
    } while (changed);
    for (int index = 0; index < remaining.size(); index++) {
      diagnostics.add(diagnostic("invalid-feature-parent", null));
    }
    return List.copyOf(ordered);
  }

  private static List<SpringDataSourceBinding> scanDataSources(
      ListableBeanFactory beanFactory, List<AdapterDiagnostic> diagnostics) {
    var loader = new ClasspathDocumentLoader();
    var mapper = new ProtocolDocumentMapper();
    var candidates = new ArrayList<SpringDataSourceBinding>();
    var counts = new HashMap<String, Integer>();
    for (String beanName : beanFactory.getBeanNamesForAnnotation(GauntletDataSource.class)) {
      Class<?> declaredType = beanFactory.getType(beanName);
      GauntletDataSource annotation =
          declaredType == null
              ? null
              : AnnotatedElementUtils.findMergedAnnotation(declaredType, GauntletDataSource.class);
      if (annotation == null) continue;
      String safeId = safeId(annotation.id());
      try {
        Object bean = beanFactory.getBean(beanName);
        if (!(bean instanceof TypedDataSource source)) throw new IllegalArgumentException();
        Class<?> owner = AopUtils.getTargetClass(bean);
        DataSourceDefinition definition;
        if (!annotation.definitionResource().isEmpty()) {
          definition = mapper.dataSource(loader.load(owner, annotation.definitionResource()));
          if (!definition.id().equals(annotation.id())
              || !definition.label().equals(annotation.label()))
            throw new IllegalArgumentException();
        } else {
          JsonObject dependency =
              annotation.dependencySchemaResource().isEmpty()
                  ? null
                  : schema(loader.load(owner, annotation.dependencySchemaResource()));
          JsonObject context =
              annotation.contextSchemaResource().isEmpty()
                  ? null
                  : schema(loader.load(owner, annotation.contextSchemaResource()));
          definition =
              new DataSourceDefinition(
                  annotation.id(),
                  annotation.label(),
                  emptyToNull(annotation.description()),
                  annotation.search(),
                  "cursor",
                  true,
                  annotation.defaultLimit(),
                  annotation.maxLimit(),
                  dependency,
                  context,
                  empty());
        }
        candidates.add(new SpringDataSourceBinding(definition, source));
        counts.merge(definition.id(), 1, Integer::sum);
      } catch (RuntimeException exception) {
        diagnostics.add(diagnostic("invalid-data-source-binding", null));
      }
    }
    var accepted = new ArrayList<SpringDataSourceBinding>();
    for (SpringDataSourceBinding candidate : candidates) {
      if (counts.get(candidate.definition().id()) == 1) accepted.add(candidate);
      else diagnostics.add(diagnostic("duplicate-data-source-id", null));
    }
    accepted.sort(Comparator.comparing(value -> value.definition().id()));
    return List.copyOf(accepted);
  }

  private static List<SpringOperationBinding> scanOperations(
      ListableBeanFactory beanFactory,
      RecordSchemaFactory recordSchemas,
      ObjectMapper objectMapper,
      Validator beanValidator,
      FeatureRegistry features,
      DataSourceRegistry dataSources,
      List<AdapterDiagnostic> diagnostics) {
    var loader = new ClasspathDocumentLoader();
    var mapper = new ProtocolDocumentMapper();
    var candidates = new ArrayList<SpringOperationBinding>();
    var counts = new HashMap<String, Integer>();
    for (String beanName : beanFactory.getBeanNamesForAnnotation(GauntletOperation.class)) {
      Class<?> declaredType = beanFactory.getType(beanName);
      GauntletOperation annotation =
          declaredType == null
              ? null
              : AnnotatedElementUtils.findMergedAnnotation(declaredType, GauntletOperation.class);
      if (annotation == null) continue;
      String safeId = safeId(annotation.id());
      try {
        ProtocolId.require(annotation.featureId());
        Object bean = beanFactory.getBean(beanName);
        if (!(bean instanceof TypedOperationHandler<?> handler)) {
          throw new IllegalArgumentException();
        }
        Class<?> owner = AopUtils.getTargetClass(bean);
        Class<?> generic =
            ResolvableType.forClass(owner).as(TypedOperationHandler.class).getGeneric(0).resolve();
        if (generic == null || generic != annotation.input()) throw new IllegalArgumentException();
        recordSchemas.schemaFor(annotation.input());

        OperationDefinition definition;
        if (!annotation.definitionResource().isEmpty()) {
          definition = mapper.operation(loader.load(owner, annotation.definitionResource()));
          if (!definition.id().equals(annotation.id())
              || !definition.featureId().equals(annotation.featureId())
              || !definition.label().equals(annotation.label()))
            throw new IllegalArgumentException();
        } else {
          JsonObject inputSchema =
              annotation.inputSchemaResource().isEmpty()
                  ? recordSchemas.schemaFor(annotation.input())
                  : schema(loader.load(owner, annotation.inputSchemaResource()));
          definition = generatedOperation(annotation, inputSchema);
        }
        if (features.find(definition.featureId()).isEmpty()
            || definition.dataSources().stream()
                .anyMatch(reference -> dataSources.find(reference.id()).isEmpty())) {
          throw new IllegalArgumentException();
        }
        candidates.add(
            new SpringOperationBinding(
                definition, annotation.input(), handler, objectMapper, beanValidator));
        counts.merge(definition.id(), 1, Integer::sum);
      } catch (RuntimeException exception) {
        diagnostics.add(diagnostic("invalid-operation-binding", safeId));
      }
    }
    var accepted = new ArrayList<SpringOperationBinding>();
    for (SpringOperationBinding candidate : candidates) {
      if (counts.get(candidate.definition().id()) == 1) accepted.add(candidate);
      else diagnostics.add(diagnostic("duplicate-operation-id", candidate.definition().id()));
    }
    accepted.sort(Comparator.comparing(value -> value.definition().id()));
    return List.copyOf(accepted);
  }

  private static OperationDefinition generatedOperation(
      GauntletOperation annotation, JsonObject inputSchema) {
    JsonObject outputSchema =
        JsonOwnership.object(
            Map.of("$schema", "https://json-schema.org/draft/2020-12/schema", "type", "object"));
    return new OperationDefinition(
        annotation.id(),
        annotation.featureId(),
        annotation.label(),
        emptyToNull(annotation.description()),
        inputSchema,
        null,
        null,
        null,
        List.of(),
        List.of(),
        new ExecutionPolicy(
            annotation.impact(),
            annotation.confirmationRequired(),
            annotation.dryRunSupported(),
            annotation.idempotency(),
            annotation.cancellationSupported(),
            annotation.timeoutSeconds() < 0 ? null : annotation.timeoutSeconds(),
            emptyToNull(annotation.concurrency()),
            empty()),
        new OperationOutput(outputSchema, null, empty()),
        null,
        annotation.order(),
        List.of(annotation.tags()),
        new ProtocolRequirements(
            List.of(annotation.requiredProfiles()), List.of(annotation.requiredCapabilities())),
        empty(),
        placements(annotation));
  }

  private static List<OperationPlacement> placements(GauntletOperation annotation) {
    var result = new ArrayList<OperationPlacement>();
    if (annotation.globalPlacement()) result.add(OperationPlacement.global());
    for (SubjectPlacement subject : annotation.subjectPlacements()) {
      var bindings = new LinkedHashMap<String, String>();
      for (PlacementBinding binding : subject.bindings())
        bindings.put(binding.pointer(), binding.key());
      result.add(OperationPlacement.subject(subject.subjectType(), bindings));
    }
    return List.copyOf(result);
  }

  private static List<String> profilesWithPlacements(
      List<String> configured, List<OperationSummary> summaries) {
    if (configured.contains(PlacementRules.PROFILE)
        || summaries.stream().noneMatch(summary -> !summary.placements().isEmpty())) {
      return configured;
    }
    var profiles = new ArrayList<>(configured);
    profiles.add(PlacementRules.PROFILE);
    return List.copyOf(profiles);
  }

  private static JsonObject schema(JsonObject value) {
    TcSchemaCore.assertValid(value, true);
    return value;
  }

  private static ApplicationMetadata application(GauntletProperties properties) {
    GauntletApplicationProperties configured = properties.application();
    if (configured != null) return configured.toMetadata();
    if (properties.enabled()) {
      throw new IllegalArgumentException("enabled adapter requires application metadata");
    }
    return new ApplicationMetadata(
        "disabled-adapter",
        "Disabled adapter",
        new EnvironmentDescriptor("disabled-adapter", EnvironmentKind.DEVELOPMENT),
        empty());
  }

  private static String safeId(String value) {
    try {
      return ProtocolId.require(value);
    } catch (RuntimeException exception) {
      return null;
    }
  }

  private static String emptyToNull(String value) {
    return value == null || value.isEmpty() ? null : value;
  }

  private static AdapterDiagnostic diagnostic(String code, String operationId) {
    return new AdapterDiagnostic(
        "error",
        code,
        "An annotated Gauntlet binding was invalid and was omitted.",
        operationId,
        empty());
  }

  private static Problem unavailableOperation() {
    return new Problem(
        "urn:gauntlet:problem:adapter-unavailable",
        "Operation unavailable",
        503,
        "The operation requirements are not available in this adapter.",
        null,
        null,
        List.of(),
        null,
        empty());
  }

  private static Problem operationNotFound() {
    return new Problem("urn:gauntlet:problem:operation-not-found", "Operation not found", 404);
  }

  private static Problem dataSourceNotFound() {
    return new Problem("urn:gauntlet:problem:data-source-not-found", "Data source not found", 404);
  }

  private static Problem validationProblem(List<ValidationError> errors) {
    return new Problem(
        "urn:gauntlet:problem:validation-failed",
        "Validation failed",
        422,
        null,
        null,
        null,
        errors,
        null,
        empty());
  }

  private static JsonObject empty() {
    return JsonOwnership.object(Map.of());
  }
}
