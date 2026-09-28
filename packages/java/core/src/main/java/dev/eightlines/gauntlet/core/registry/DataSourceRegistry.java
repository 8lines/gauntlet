package dev.eightlines.gauntlet.core.registry;

import dev.eightlines.gauntlet.core.model.DataSourceDefinition;
import dev.eightlines.gauntlet.core.spi.DataSource;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class DataSourceRegistry {
  private final Map<String, DataSource> sources = new LinkedHashMap<>();

  public DataSourceRegistry() {}

  public DataSourceRegistry(Iterable<DataSource> values) {
    values.forEach(this::register);
  }

  public synchronized void register(DataSource source) {
    DataSourceDefinition definition =
        java.util.Objects.requireNonNull(source.definition(), "definition");
    if (sources.containsKey(definition.id()))
      throw new IllegalArgumentException("duplicate data source ID");
    sources.put(
        definition.id(),
        new DataSource() {
          @Override
          public DataSourceDefinition definition() {
            return definition;
          }

          @Override
          public dev.eightlines.gauntlet.core.model.DataSourcePage query(
              dev.eightlines.gauntlet.core.model.DataSourceQuery request) throws Exception {
            return source.query(request);
          }

          @Override
          public dev.eightlines.gauntlet.core.model.DataSourceResolveResponse resolve(
              dev.eightlines.gauntlet.core.model.DataSourceResolveRequest request)
              throws Exception {
            return source.resolve(request);
          }
        });
  }

  public synchronized Optional<DataSource> find(String id) {
    return Optional.ofNullable(sources.get(id));
  }

  public synchronized List<DataSourceDefinition> definitions() {
    return sources.values().stream()
        .map(DataSource::definition)
        .sorted(java.util.Comparator.comparing(DataSourceDefinition::id))
        .toList();
  }
}
