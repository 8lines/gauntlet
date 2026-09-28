package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.FileReference;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunEvent;
import dev.eightlines.gauntlet.core.model.SessionLaunchResponse;
import dev.eightlines.gauntlet.core.model.UploadResponse;
import dev.eightlines.gauntlet.spring.capability.CancelRunEndpoint;
import dev.eightlines.gauntlet.spring.capability.RunEventsEndpoint;
import dev.eightlines.gauntlet.spring.capability.SessionLaunchEndpoint;
import dev.eightlines.gauntlet.spring.capability.SpringCapabilityRegistry;
import dev.eightlines.gauntlet.spring.capability.UploadEndpoint;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import dev.eightlines.gauntlet.spring.http.RawAdapterPrefixFilter;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class CapabilityMatrixHttpTest {
  private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");

  @Test
  void everyInstalledSpiMaskOwnsEachCanonicalRouteExactlyOnce() {
    for (int mask = 0; mask < 16; mask++) {
      int currentMask = mask;
      runner(mask)
          .run(
              context -> {
                assertThat(context).hasNotFailed();
                FilterRegistrationBean<?> registration =
                    context.getBean("gauntletRawPrefixFilter", FilterRegistrationBean.class);
                MockMvc mvc =
                    MockMvcBuilders.webAppContextSetup(context)
                        .addFilters((RawAdapterPrefixFilter) registration.getFilter())
                        .build();
                assertMask(mvc, context.getBean(ObjectMapper.class), currentMask);
              });
    }
  }

  private static WebApplicationContextRunner runner(int mask) {
    var runner =
        new WebApplicationContextRunner()
            .withUserConfiguration(FixtureApplication.class, CapabilityFixture.class)
            .withPropertyValues(
                "gauntlet.enabled=true",
                "gauntlet.application.id=fixture-app",
                "gauntlet.application.label=Fixture application",
                "gauntlet.application.environment.name=fixture-test",
                "gauntlet.application.environment.kind=test",
                "gauntlet.idempotency-secret=fixture-idempotency-secret-32-bytes-long");
    if ((mask & 1) != 0) runner = runner.withPropertyValues("fixture.cancel=true");
    if ((mask & 2) != 0) runner = runner.withPropertyValues("fixture.events=true");
    if ((mask & 4) != 0) runner = runner.withPropertyValues("fixture.upload=true");
    if ((mask & 8) != 0) runner = runner.withPropertyValues("fixture.session=true");
    return runner;
  }

  private static void assertMask(MockMvc mvc, ObjectMapper mapper, int mask) {
    try {
      byte[] manifest =
          mvc.perform(get("/_gauntlet/v1/manifest"))
              .andExpect(status().isOk())
              .andReturn()
              .getResponse()
              .getContentAsByteArray();
      Set<String> capabilities = new HashSet<>();
      mapper
          .readTree(manifest)
          .required("capabilities")
          .forEach(value -> capabilities.add(value.stringValue()));
      assertThat(capabilities).isEqualTo(expectedCapabilities(mask));

      if ((mask & 1) != 0) {
        mvc.perform(post("/_gauntlet/v1/runs/run-1/cancel")).andExpect(status().isAccepted());
      } else {
        mvc.perform(post("/_gauntlet/v1/runs/run-1/cancel"))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:run-not-found"));
      }
      expect(
          mvc.perform(get("/_gauntlet/v1/runs/run-1/events")),
          (mask & 2) != 0,
          SpringCapabilityRegistry.EVENTS,
          200);
      expect(
          mvc.perform(
              multipart("/_gauntlet/v1/uploads")
                  .file(
                      new MockMultipartFile(
                          "file", "fixture.txt", "text/plain", "fixture".getBytes()))),
          (mask & 4) != 0,
          SpringCapabilityRegistry.UPLOADS,
          201);
      expect(
          mvc.perform(post("/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch")),
          (mask & 8) != 0,
          SpringCapabilityRegistry.SESSION_LAUNCH,
          201);
    } catch (Exception exception) {
      throw new AssertionError("capability mask " + mask + " failed", exception);
    }
  }

  private static void expect(
      org.springframework.test.web.servlet.ResultActions action,
      boolean installed,
      String capability,
      int successStatus)
      throws Exception {
    if (installed) {
      action.andExpect(status().is(successStatus));
    } else {
      action
          .andExpect(status().isNotImplemented())
          .andExpect(jsonPath("$.capability").value(capability));
    }
  }

  private static Set<String> expectedCapabilities(int mask) {
    var expected = new HashSet<String>();
    expected.add(SpringCapabilityRegistry.CANCELLATION);
    if ((mask & 2) != 0) expected.add(SpringCapabilityRegistry.EVENTS);
    if ((mask & 4) != 0) expected.add(SpringCapabilityRegistry.UPLOADS);
    if ((mask & 8) != 0) expected.add(SpringCapabilityRegistry.SESSION_LAUNCH);
    return expected;
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class CapabilityFixture {
    @Bean
    Clock fixtureClock() {
      return Clock.fixed(NOW, ZoneOffset.UTC);
    }

    @Bean
    @ConditionalOnProperty(name = "fixture.cancel", havingValue = "true")
    CancelRunEndpoint cancelEndpoint(ObjectProvider<SpringAdapterCatalog> catalogs) {
      return runId ->
          Run.queued(
              runId, catalogs.getObject().operation("applications.finalize").orElseThrow(), NOW);
    }

    @Bean
    @ConditionalOnProperty(name = "fixture.events", havingValue = "true")
    RunEventsEndpoint eventsEndpoint(ObjectProvider<SpringAdapterCatalog> catalogs) {
      return (runId, lastEventId) -> {
        Run run =
            Run.queued(
                runId, catalogs.getObject().operation("applications.finalize").orElseThrow(), NOW);
        return List.of(
            new RunEvent("event-1", run.sequence(), run.updatedAt(), "run.updated", run, empty()));
      };
    }

    @Bean
    @ConditionalOnProperty(name = "fixture.upload", havingValue = "true")
    UploadEndpoint uploadEndpoint() {
      return file ->
          new UploadResponse(
              new FileReference(
                  "upload-1",
                  file.getOriginalFilename() == null ? "fixture.txt" : file.getOriginalFilename(),
                  file.getContentType() == null
                      ? "application/octet-stream"
                      : file.getContentType(),
                  file.getSize(),
                  null,
                  "2030-01-01T00:10:00Z",
                  empty()),
              empty());
    }

    @Bean
    @ConditionalOnProperty(name = "fixture.session", havingValue = "true")
    SessionLaunchEndpoint sessionEndpoint() {
      return (runId, artifactId) ->
          new SessionLaunchResponse(
              "https://portal.example.test/session/" + runId,
              NOW.plusSeconds(300).toString(),
              true,
              empty(),
              Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static dev.eightlines.gauntlet.core.json.JsonObject empty() {
      return JsonOwnership.object(Map.of());
    }
  }
}
