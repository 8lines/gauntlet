package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;

import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(
    classes = FixtureApplication.class,
    properties = {
      "gauntlet.application.id=fixture-app",
      "gauntlet.application.label=Fixture application",
      "gauntlet.application.environment.name=fixture-test",
      "gauntlet.application.environment.kind=test",
      "gauntlet.profiles=tc-schema-core@1,tc-rich-forms@1"
    })
class SpringAdapterCatalogTest {
  @Autowired GauntletProperties properties;
  @Autowired SpringAdapterCatalog catalog;

  @Test
  void adapterIsDisabledByDefaultWhileCatalogInspectionRemainsAvailable() {
    assertThat(properties.enabled()).isFalse();
    assertThat(catalog.manifest().operations().stream().map(operation -> operation.id()))
        .containsExactly("applications.finalize");
    assertThat(catalog.manifest().dataSources().stream().map(source -> source.id()))
        .containsExactly("applications");
    assertThat(catalog.manifest().operations().getFirst().available()).isTrue();
  }

  @Test
  void manifestProfilesAreExactlyTheConfiguredProfilesWithoutPlacements() {
    assertThat(catalog.manifest().operations())
        .allSatisfy(summary -> assertThat(summary.placements()).isEmpty());
    assertThat(properties.profiles()).containsExactly("tc-rich-forms@1", "tc-schema-core@1");
    assertThat(catalog.manifest().profiles()).containsExactlyElementsOf(properties.profiles());
  }

  @Test
  void generatedDefinitionIsStableAndBackedByTheAnnotatedHandler() {
    var definition = catalog.operation("applications.finalize").orElseThrow();

    assertThat(definition.featureId()).isEqualTo("applications");
    assertThat(definition.revision()).startsWith("sha256:");
    assertThat(catalog.operationSummary("applications.finalize").orElseThrow().revision())
        .isEqualTo(definition.revision());
  }
}
