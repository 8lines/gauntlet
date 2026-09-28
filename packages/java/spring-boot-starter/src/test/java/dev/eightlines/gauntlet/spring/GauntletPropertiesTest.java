package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

class GauntletPropertiesTest {
  @Test
  void defaultsToDisabledWithOnlyTheCoreProfile() {
    var properties = new GauntletProperties(false, null, null);

    assertThat(properties.enabled()).isFalse();
    assertThat(properties.profiles()).containsExactly("tc-schema-core@1");
  }

  @Test
  void enabledConfigurationRequiresCanonicalApplicationMetadata() {
    assertThatThrownBy(() -> new GauntletProperties(true, null, List.of()))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () ->
                new GauntletProperties(
                    true,
                    new GauntletApplicationProperties(
                        "unsafe!id",
                        "Fixture",
                        new GauntletEnvironmentProperties("fixture-test", "test")),
                    List.of("tc-schema-core@1")))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void enabledBindingRequiresAnExplicitStructuredNonProductionEnvironment() {
    assertThatThrownBy(
            () ->
                bindEnabled(
                    "gauntlet.application.id=fixture", "gauntlet.application.label=Fixture"))
        .hasRootCauseMessage("enabled adapter requires application environment");

    assertThatThrownBy(
            () ->
                bindEnabled(
                    "gauntlet.application.id=fixture",
                    "gauntlet.application.label=Fixture",
                    "gauntlet.application.environment.name=fixture-prod",
                    "gauntlet.application.environment.kind=test"))
        .hasRootCauseMessage("Invalid non-production environment descriptor");

    assertThatThrownBy(
            () ->
                bindEnabled(
                    "gauntlet.application.id=fixture",
                    "gauntlet.application.label=Fixture",
                    "gauntlet.application.environment.name=fixture-test",
                    "gauntlet.application.environment.kind=TEST"))
        .hasRootCauseMessage("Invalid non-production environment descriptor");
  }

  private static GauntletProperties bindEnabled(String... entries) {
    var values = new LinkedHashMap<String, String>();
    values.put("gauntlet.enabled", "true");
    for (String entry : entries) {
      int separator = entry.indexOf('=');
      values.put(entry.substring(0, separator), entry.substring(separator + 1));
    }
    return new Binder(new MapConfigurationPropertySource(values))
        .bind("gauntlet", Bindable.of(GauntletProperties.class))
        .get();
  }
}
