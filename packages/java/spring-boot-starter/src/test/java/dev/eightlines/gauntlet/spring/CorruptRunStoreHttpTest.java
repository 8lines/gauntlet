package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.FollowUpAction;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.core.spi.RunStoreCreateResult;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import dev.eightlines.gauntlet.spring.http.RawAdapterPrefixFilter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class CorruptRunStoreHttpTest {
  private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");

  @Test
  void pollAndIdempotencyReplayFailClosedBeforeSerializingCorruptStoreRuns() {
    new WebApplicationContextRunner()
        .withUserConfiguration(FixtureApplication.class, CorruptStoreConfiguration.class)
        .withPropertyValues(
            "gauntlet.enabled=true",
            "gauntlet.application.id=fixture-app",
            "gauntlet.application.label=Fixture application",
            "gauntlet.application.environment.name=fixture-test",
            "gauntlet.application.environment.kind=test",
            "gauntlet.idempotency-secret=fixture-idempotency-secret-32-bytes-long")
        .run(
            context -> {
              assertThat(context).hasNotFailed();
              FilterRegistrationBean<?> registration =
                  context.getBean("gauntletRawPrefixFilter", FilterRegistrationBean.class);
              MockMvc mvc =
                  MockMvcBuilders.webAppContextSetup(context)
                      .addFilters((RawAdapterPrefixFilter) registration.getFilter())
                      .build();

              for (String runId :
                  List.of(
                      "unknown-operation",
                      "wrong-revision",
                      "invalid-output",
                      "invalid-action",
                      "hostile-problem")) {
                try {
                  mvc.perform(get("/_gauntlet/v1/runs/" + runId))
                      .andExpect(status().isInternalServerError())
                      .andExpect(
                          jsonPath("$.type").value("urn:gauntlet:problem:adapter-internal-error"))
                      .andExpect(
                          content()
                              .string(
                                  org.hamcrest.Matchers.not(
                                      org.hamcrest.Matchers.containsString(
                                          "store-secret-sentinel"))));
                } catch (Exception exception) {
                  throw new AssertionError(exception);
                }
              }

              SpringAdapterCatalog catalog = context.getBean(SpringAdapterCatalog.class);
              String revision = catalog.operation("applications.finalize").orElseThrow().revision();
              String request =
                  "{\"operationRevision\":\""
                      + revision
                      + "\",\"input\":{\"applicationId\":\"01234567-89ab-cdef-0123-456789abcdef\"},"
                      + "\"idempotencyKey\":\"replay-key\"}";
              try {
                mvc.perform(
                        post("/_gauntlet/v1/operations/applications.finalize/runs")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(request.getBytes(StandardCharsets.UTF_8)))
                    .andExpect(status().isInternalServerError())
                    .andExpect(
                        jsonPath("$.type").value("urn:gauntlet:problem:adapter-internal-error"));
              } catch (Exception exception) {
                throw new AssertionError(exception);
              }
              assertThat(context.getBean(CorruptRunStore.class).creates()).isZero();
            });
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class CorruptStoreConfiguration {
    @Bean
    CorruptRunStore corruptRunStore(ObjectProvider<SpringAdapterCatalog> catalogs) {
      return new CorruptRunStore(catalogs);
    }
  }

  static final class CorruptRunStore implements RunStore {
    private final ObjectProvider<SpringAdapterCatalog> catalogs;
    private final AtomicInteger creates = new AtomicInteger();

    private CorruptRunStore(ObjectProvider<SpringAdapterCatalog> catalogs) {
      this.catalogs = catalogs;
    }

    @Override
    public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
      creates.incrementAndGet();
      return RunStoreCreateResult.created(run);
    }

    @Override
    public Optional<Run> get(String runId) {
      return Optional.of(candidate(runId));
    }

    @Override
    public Optional<Run> findByIdempotencyFingerprint(String operationId, String fingerprint) {
      return Optional.of(candidate("invalid-output"));
    }

    @Override
    public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
      return false;
    }

    int creates() {
      return creates.get();
    }

    private Run candidate(String runId) {
      OperationDefinition definition =
          catalogs.getObject().operation("applications.finalize").orElseThrow();
      Run running = Run.queued(runId, definition, NOW).running(NOW.plusSeconds(1));
      return switch (runId) {
        case "unknown-operation" ->
            copyIdentity(running, "applications.missing", running.operationRevision());
        case "wrong-revision" ->
            copyIdentity(running, running.operationId(), "sha256:" + "0".repeat(64));
        case "invalid-output" ->
            running.terminal(
                OperationResult.succeeded(new JsonValue.Scalar("wrong-type")), NOW.plusSeconds(2));
        case "invalid-action" ->
            running.terminal(
                OperationResult.succeeded(
                    null,
                    null,
                    List.of(),
                    List.of(
                        FollowUpAction.invokeOperation(
                            "Unknown operation",
                            "applications.missing",
                            JsonOwnership.object(java.util.Map.of())))),
                NOW.plusSeconds(2));
        case "hostile-problem" ->
            running.failed(
                new Problem(
                    "urn:gauntlet:problem:hostile",
                    "store-secret-sentinel",
                    500,
                    "store-secret-sentinel",
                    null,
                    null,
                    List.of(),
                    null,
                    JsonOwnership.object(java.util.Map.of())),
                NOW.plusSeconds(2));
        default -> throw new IllegalArgumentException("unknown corrupt run");
      };
    }

    private static Run copyIdentity(Run run, String operationId, String revision) {
      return new Run(
          run.id(),
          operationId,
          revision,
          run.sequence(),
          run.state(),
          run.createdAt(),
          run.updatedAt(),
          run.startedAt(),
          run.completedAt(),
          run.progress(),
          run.summary(),
          run.output(),
          run.artifacts(),
          run.actions(),
          run.problem(),
          run.extensions());
    }
  }
}
