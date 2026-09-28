package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationPlacement;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.schema.PlacementRules;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.annotation.PlacementBinding;
import dev.eightlines.gauntlet.spring.annotation.SubjectPlacement;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.fixture.FinalizeInput;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

@SpringBootTest(
    classes = {FixtureApplication.class, SpringAdapterCatalogPlacementsTest.Fixture.class},
    properties = {
      "gauntlet.application.id=fixture-app",
      "gauntlet.application.label=Fixture application",
      "gauntlet.application.environment.name=fixture-test",
      "gauntlet.application.environment.kind=test",
      "gauntlet.profiles=tc-schema-core@1,tc-rich-forms@1"
    })
class SpringAdapterCatalogPlacementsTest {
  private static final List<OperationPlacement> EXPECTED =
      List.of(
          OperationPlacement.global(),
          OperationPlacement.subject("application", Map.of("/applicationId", "applicationId")));

  @Autowired GauntletProperties properties;
  @Autowired SpringAdapterCatalog catalog;

  @Test
  void annotationDeclaredPlacementsReachTheSummaryAndTheDefinition() {
    assertThat(catalog.manifest().diagnostics()).isEmpty();
    assertThat(catalog.operationSummary("applications.placed").orElseThrow().placements())
        .containsExactlyElementsOf(EXPECTED);
    assertThat(catalog.operation("applications.placed").orElseThrow().placements())
        .containsExactlyElementsOf(EXPECTED);
    assertThat(catalog.operationSummary("applications.finalize").orElseThrow().placements())
        .isEmpty();
  }

  @Test
  void thePlacementsProfileIsAppendedOnceAfterTheConfiguredProfiles() {
    var expected = new ArrayList<>(properties.profiles());
    expected.add(PlacementRules.PROFILE);

    assertThat(properties.profiles()).containsExactly("tc-rich-forms@1", "tc-schema-core@1");
    assertThat(catalog.manifest().profiles()).containsExactlyElementsOf(expected);
    assertThat(Collections.frequency(catalog.manifest().profiles(), PlacementRules.PROFILE))
        .isEqualTo(1);
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class Fixture {
    @Bean
    PlacedOperation placedOperation() {
      return new PlacedOperation();
    }
  }

  @GauntletOperation(
      id = "applications.placed",
      featureId = "applications",
      label = "Placed operation",
      input = FinalizeInput.class,
      idempotency = Idempotency.OPTIONAL,
      globalPlacement = true,
      subjectPlacements =
          @SubjectPlacement(
              subjectType = "application",
              bindings = @PlacementBinding(pointer = "/applicationId", key = "applicationId")))
  static final class PlacedOperation implements TypedOperationHandler<FinalizeInput> {
    @Override
    public OperationResult execute(FinalizeInput input, RunContext context) {
      return OperationResult.succeeded(null, JsonOwnership.object(Map.of()), List.of(), List.of());
    }
  }
}
