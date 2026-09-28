package dev.eightlines.gauntlet.spring.catalog;

import dev.eightlines.gauntlet.core.model.DataSourceDefinition;
import dev.eightlines.gauntlet.core.model.DataSourcePage;
import dev.eightlines.gauntlet.core.model.DataSourceQuery;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;
import dev.eightlines.gauntlet.core.spi.DataSource;
import dev.eightlines.gauntlet.spring.spi.TypedDataSource;
import java.util.Objects;

/** A validated typed Spring bean exposed through the framework-neutral Core data-source SPI. */
public final class SpringDataSourceBinding implements DataSource {
  private final DataSourceDefinition definition;
  private final TypedDataSource delegate;

  public SpringDataSourceBinding(DataSourceDefinition definition, TypedDataSource delegate) {
    this.definition = Objects.requireNonNull(definition, "definition");
    this.delegate = Objects.requireNonNull(delegate, "delegate");
  }

  @Override
  public DataSourceDefinition definition() {
    return definition;
  }

  @Override
  public DataSourcePage query(DataSourceQuery request) throws Exception {
    return delegate.query(request);
  }

  @Override
  public DataSourceResolveResponse resolve(DataSourceResolveRequest request) throws Exception {
    return delegate.resolve(request);
  }
}
