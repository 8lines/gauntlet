package dev.eightlines.gauntlet.core.registry;

import dev.eightlines.gauntlet.core.model.FeatureDefinition;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class FeatureRegistry {
  private final Map<String, FeatureDefinition> features = new LinkedHashMap<>();

  public FeatureRegistry() {}

  public FeatureRegistry(Iterable<FeatureDefinition> definitions) {
    definitions.forEach(this::register);
  }

  public synchronized void register(FeatureDefinition feature) {
    if (features.containsKey(feature.id()))
      throw new IllegalArgumentException("duplicate feature ID");
    if (feature.parentId() != null && !features.containsKey(feature.parentId())) {
      throw new IllegalArgumentException("unknown parent feature");
    }
    features.put(feature.id(), feature);
  }

  public synchronized Optional<FeatureDefinition> find(String id) {
    return Optional.ofNullable(features.get(id));
  }

  public synchronized List<FeatureDefinition> definitions() {
    return features.values().stream()
        .sorted(java.util.Comparator.comparing(FeatureDefinition::id))
        .toList();
  }
}
