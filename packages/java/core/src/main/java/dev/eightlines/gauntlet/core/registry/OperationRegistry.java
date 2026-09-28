package dev.eightlines.gauntlet.core.registry;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.schema.ProtocolSemantics;
import dev.eightlines.gauntlet.core.spi.OperationHandler;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class OperationRegistry {
  private final FeatureRegistry features;
  private final Map<String, OperationHandler<JsonObject>> handlers = new LinkedHashMap<>();

  public OperationRegistry(FeatureRegistry features) {
    this.features = java.util.Objects.requireNonNull(features, "features");
  }

  @SuppressWarnings("unchecked")
  public synchronized <I extends JsonObject> void register(OperationHandler<I> handler) {
    OperationDefinition definition =
        java.util.Objects.requireNonNull(handler.definition(), "definition");
    if (handlers.containsKey(definition.id()))
      throw new IllegalArgumentException("duplicate operation ID");
    if (features.find(definition.featureId()).isEmpty())
      throw new IllegalArgumentException("unknown feature");
    String revision = CanonicalJson.revision(definition.toProtocolMap(), "revision");
    if (!revision.equals(definition.revision()))
      throw new IllegalArgumentException("operation revision mismatch");
    if (!ProtocolSemantics.operationIsValid(definition)) {
      throw new IllegalArgumentException("operation definition violates protocol semantics");
    }
    OperationHandler<JsonObject> delegate = (OperationHandler<JsonObject>) handler;
    handlers.put(
        definition.id(),
        new OperationHandler<>() {
          @Override
          public OperationDefinition definition() {
            return definition;
          }

          @Override
          public java.util.List<dev.eightlines.gauntlet.core.model.ValidationError> validateInput(
              JsonObject input) {
            return delegate.validateInput(input);
          }

          @Override
          public dev.eightlines.gauntlet.core.model.OperationResult execute(
              JsonObject input, dev.eightlines.gauntlet.core.spi.RunContext context)
              throws Exception {
            return delegate.execute(input, context);
          }
        });
  }

  public synchronized Optional<OperationHandler<JsonObject>> find(String id) {
    return Optional.ofNullable(handlers.get(id));
  }

  public synchronized List<OperationDefinition> definitions() {
    return handlers.values().stream()
        .map(OperationHandler::definition)
        .sorted(java.util.Comparator.comparing(OperationDefinition::id))
        .toList();
  }

  public FeatureRegistry features() {
    return features;
  }
}
