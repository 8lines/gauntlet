package dev.eightlines.gauntlet.spring.spi;

import dev.eightlines.gauntlet.core.model.DataSourcePage;
import dev.eightlines.gauntlet.core.model.DataSourceQuery;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;

public interface TypedDataSource {
  DataSourcePage query(DataSourceQuery request) throws Exception;

  DataSourceResolveResponse resolve(DataSourceResolveRequest request) throws Exception;
}
