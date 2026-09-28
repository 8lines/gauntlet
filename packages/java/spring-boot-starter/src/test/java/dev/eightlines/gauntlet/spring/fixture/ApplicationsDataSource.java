package dev.eightlines.gauntlet.spring.fixture;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.DataSourcePage;
import dev.eightlines.gauntlet.core.model.DataSourceQuery;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;
import dev.eightlines.gauntlet.spring.annotation.GauntletDataSource;
import dev.eightlines.gauntlet.spring.spi.TypedDataSource;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
@GauntletDataSource(id = "applications", label = "Applications")
public final class ApplicationsDataSource implements TypedDataSource {
  @Override
  public DataSourcePage query(DataSourceQuery request) {
    return new DataSourcePage(List.of(), null, JsonOwnership.object(Map.of()));
  }

  @Override
  public DataSourceResolveResponse resolve(DataSourceResolveRequest request) {
    return DataSourceResolveResponse.forRequest(
        request,
        request.values().stream()
            .map(value -> new DataSourceResolveResponse.Result(value, null))
            .toList(),
        JsonOwnership.object(Map.of()));
  }
}
