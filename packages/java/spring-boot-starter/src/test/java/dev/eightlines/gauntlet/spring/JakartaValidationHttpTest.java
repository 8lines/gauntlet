package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.core.spi.RunStoreCreateResult;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import dev.eightlines.gauntlet.spring.http.RawAdapterPrefixFilter;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import jakarta.validation.constraints.Size;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class JakartaValidationHttpTest {
  @Test
  void schemaValidButJakartaInvalidRecordIsRejectedBeforeRunReservationAndHandler() {
    new WebApplicationContextRunner()
        .withUserConfiguration(FixtureApplication.class, ValidationFixture.class)
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
              var catalog = context.getBean(SpringAdapterCatalog.class);
              String revision =
                  catalog.operation("applications.whitespace").orElseThrow().revision();
              var registration =
                  context.getBean("gauntletRawPrefixFilter", FilterRegistrationBean.class);
              var mvc =
                  MockMvcBuilders.webAppContextSetup(context)
                      .addFilters((RawAdapterPrefixFilter) registration.getFilter())
                      .build();

              var envelope =
                  JsonOwnership.object(
                      Map.of("operationRevision", revision, "input", Map.of("value", "x")));
              try {
                mvc.perform(
                        post("/_gauntlet/v1/operations/applications.whitespace/runs")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(CanonicalJson.encode(envelope)))
                    .andExpect(status().is(422))
                    .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:validation-failed"));
              } catch (Exception exception) {
                throw new AssertionError(exception);
              }

              assertThat(context.getBean(WhitespaceOperation.class).calls()).isZero();
              assertThat(context.getBean(CountingRunStore.class).creates()).isZero();
            });
  }

  record WhitespaceInput(@Size(min = 2) String value) {}

  @GauntletOperation(
      id = "applications.whitespace",
      featureId = "applications",
      label = "Whitespace validation",
      input = WhitespaceInput.class,
      inputSchemaResource = "gauntlet/whitespace-input.json")
  static final class WhitespaceOperation implements TypedOperationHandler<WhitespaceInput> {
    private final AtomicInteger calls = new AtomicInteger();

    @Override
    public OperationResult execute(WhitespaceInput input, RunContext context) {
      calls.incrementAndGet();
      return OperationResult.succeeded(JsonOwnership.object(Map.of()));
    }

    int calls() {
      return calls.get();
    }
  }

  static final class CountingRunStore implements RunStore {
    private final dev.eightlines.gauntlet.core.run.InMemoryRunStore delegate =
        new dev.eightlines.gauntlet.core.run.InMemoryRunStore();
    private final AtomicInteger creates = new AtomicInteger();

    @Override
    public RunStoreCreateResult createQueued(Run run, Optional<String> fingerprint) {
      creates.incrementAndGet();
      return delegate.createQueued(run, fingerprint);
    }

    @Override
    public Optional<Run> get(String runId) {
      return delegate.get(runId);
    }

    @Override
    public Optional<Run> findByIdempotencyFingerprint(String operationId, String fingerprint) {
      return delegate.findByIdempotencyFingerprint(operationId, fingerprint);
    }

    @Override
    public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
      return delegate.updateExactSequence(run, expectedPreviousSequence);
    }

    int creates() {
      return creates.get();
    }
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class ValidationFixture {
    @Bean
    WhitespaceOperation whitespaceOperation() {
      return new WhitespaceOperation();
    }

    @Bean
    CountingRunStore countingRunStore() {
      return new CountingRunStore();
    }
  }
}
