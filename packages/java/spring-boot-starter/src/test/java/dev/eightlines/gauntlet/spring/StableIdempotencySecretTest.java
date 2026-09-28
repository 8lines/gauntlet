package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.run.InMemoryRunStore;
import dev.eightlines.gauntlet.spring.catalog.IdempotencySecret;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.ConfigurableApplicationContext;

class StableIdempotencySecretTest {
  private static final String SECRET = "stable-test-secret-is-at-least-32-bytes";

  @Test
  void enabledAdaptersRequireANonRenderedSecretWithAtLeast32Utf8Bytes() {
    assertThatThrownBy(() -> IdempotencySecret.configured("short"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(IdempotencySecret.configured(SECRET).toString()).doesNotContain(SECRET);

    new ApplicationContextRunner()
        .withUserConfiguration(FixtureApplication.class)
        .withPropertyValues(
            "gauntlet.enabled=true",
            "gauntlet.application.id=fixture-app",
            "gauntlet.application.label=Fixture application",
            "gauntlet.application.environment.name=fixture-test",
            "gauntlet.application.environment.kind=test")
        .run(context -> assertThat(context).hasFailed());
  }

  @Test
  void twoCatalogsReplayOneRunThroughASharedStoreWhenConfiguredSecretIsStable() {
    var store = new InMemoryRunStore();
    try (ConfigurableApplicationContext first = start(store);
        ConfigurableApplicationContext second = start(store)) {
      SpringAdapterCatalog firstCatalog = first.getBean(SpringAdapterCatalog.class);
      SpringAdapterCatalog secondCatalog = second.getBean(SpringAdapterCatalog.class);
      String revision = firstCatalog.operation("applications.finalize").orElseThrow().revision();
      var request =
          new CreateRunRequest(
              revision,
              JsonOwnership.object(
                  Map.of(
                      "applicationId", "11111111-1111-4111-8111-111111111111",
                      "reason", "complete")),
              null,
              false,
              "shared-replay-key",
              JsonOwnership.object(Map.of()));

      var created = firstCatalog.createRun("applications.finalize", request);
      var replay = secondCatalog.createRun("applications.finalize", request);

      assertThat(created.isSuccess()).isTrue();
      assertThat(replay.isSuccess()).isTrue();
      assertThat(replay.run().id()).isEqualTo(created.run().id());
      assertThat(store.all()).hasSize(1);
      assertThat(store.fingerprintCount()).isEqualTo(1);
      assertThat(store.containsText("shared-replay-key")).isFalse();
    }
  }

  private static ConfigurableApplicationContext start(InMemoryRunStore store) {
    var application = new SpringApplication(FixtureApplication.class);
    application.setWebApplicationType(WebApplicationType.NONE);
    application.setDefaultProperties(
        Map.of(
            "spring.main.banner-mode", "off",
            "gauntlet.enabled", "true",
            "gauntlet.application.id", "fixture-app",
            "gauntlet.application.label", "Fixture application",
            "gauntlet.application.environment.name", "fixture-test",
            "gauntlet.application.environment.kind", "test",
            "gauntlet.idempotency-secret", SECRET));
    application.addInitializers(
        context -> context.getBeanFactory().registerSingleton("sharedRunStore", store));
    return application.run();
  }
}
