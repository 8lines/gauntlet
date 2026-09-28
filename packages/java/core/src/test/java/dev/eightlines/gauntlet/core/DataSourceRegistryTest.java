package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import dev.eightlines.gauntlet.core.model.DataSourceDefinition;
import dev.eightlines.gauntlet.core.model.DataSourcePage;
import dev.eightlines.gauntlet.core.model.DataSourceQuery;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;
import dev.eightlines.gauntlet.core.registry.DataSourceRegistry;
import dev.eightlines.gauntlet.core.spi.DataSource;
import java.util.List;
import org.junit.jupiter.api.Test;

class DataSourceRegistryTest {
  @Test
  void registryRejectsDuplicatesAndKeepsDeterministicDefinitions() {
    var registry = new DataSourceRegistry();
    registry.register(source("zeta"));
    registry.register(source("alpha"));
    assertEquals(
        List.of("alpha", "zeta"),
        registry.definitions().stream().map(DataSourceDefinition::id).toList());
    assertThrows(IllegalArgumentException.class, () -> registry.register(source("alpha")));
  }

  @Test
  void resolveResponseMustEchoEveryRequestedValueInOrder() {
    var request =
        new DataSourceResolveRequest(
            List.of("", "two"), CoreTestFixtures.EMPTY, null, CoreTestFixtures.EMPTY);
    assertThrows(
        IllegalArgumentException.class,
        () ->
            DataSourceResolveResponse.forRequest(
                request,
                List.of(
                    new DataSourceResolveResponse.Result("two", null),
                    new DataSourceResolveResponse.Result("", null)),
                CoreTestFixtures.EMPTY));
  }

  private static DataSource source(String id) {
    return new DataSource() {
      @Override
      public DataSourceDefinition definition() {
        return new DataSourceDefinition(
            id, id, null, true, "cursor", true, 20, 100, null, null, CoreTestFixtures.EMPTY);
      }

      @Override
      public DataSourcePage query(DataSourceQuery request) {
        return new DataSourcePage(List.of(), null, CoreTestFixtures.EMPTY);
      }

      @Override
      public DataSourceResolveResponse resolve(DataSourceResolveRequest request) {
        return DataSourceResolveResponse.forRequest(
            request,
            request.values().stream()
                .map(value -> new DataSourceResolveResponse.Result(value, null))
                .toList(),
            CoreTestFixtures.EMPTY);
      }
    };
  }
}
