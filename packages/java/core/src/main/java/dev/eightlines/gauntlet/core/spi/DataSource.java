package dev.eightlines.gauntlet.core.spi;

import dev.eightlines.gauntlet.core.model.DataSourceDefinition;
import dev.eightlines.gauntlet.core.model.DataSourcePage;
import dev.eightlines.gauntlet.core.model.DataSourceQuery;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;

public interface DataSource {
  DataSourceDefinition definition();

  DataSourcePage query(DataSourceQuery request) throws Exception;

  DataSourceResolveResponse resolve(DataSourceResolveRequest request) throws Exception;
}
