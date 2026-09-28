package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.ValidationError;
import dev.eightlines.gauntlet.core.schema.NetworkntSchemaValidator;
import dev.eightlines.gauntlet.core.schema.SchemaValidator;
import dev.eightlines.gauntlet.core.spi.FileReferenceValidator;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.core.spi.RunStoreCreateResult;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.fixture.FinalizeInput;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(
    classes = {FixtureApplication.class, UnavailableOperationPreflightHttpTest.Fixture.class},
    properties = {
      "gauntlet.enabled=true",
      "gauntlet.application.id=fixture-app",
      "gauntlet.application.label=Fixture application",
      "gauntlet.application.environment.name=fixture-test",
      "gauntlet.application.environment.kind=test",
      "gauntlet.idempotency-secret=fixture-idempotency-secret-32-bytes-long"
    })
@AutoConfigureMockMvc
class UnavailableOperationPreflightHttpTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper mapper;
  @Autowired SpringAdapterCatalog catalog;
  @Autowired CountingSchemaValidator validator;
  @Autowired CountingRunStore store;
  @Autowired CountingFileValidator files;
  @Autowired MissingProfileOperation profileHandler;
  @Autowired MissingCapabilityOperation capabilityHandler;

  @Test
  void unavailableSummaryProblemWinsBeforeEveryRequestProcessingBoundary() throws Exception {
    for (String id : List.of("applications.missing-profile", "applications.missing-capability")) {
      var expected = catalog.operationSummary(id).orElseThrow().unavailableProblem();
      var response =
          mvc.perform(
                  post("/_gauntlet/v1/operations/{id}/runs", id)
                      .contentType(MediaType.APPLICATION_JSON)
                      .content("{malformed-secret-sentinel"))
              .andExpect(status().isServiceUnavailable())
              .andExpect(
                  content()
                      .string(
                          org.hamcrest.Matchers.not(
                              org.hamcrest.Matchers.containsString("malformed-secret-sentinel"))))
              .andReturn()
              .getResponse();
      assertThat(mapper.readTree(response.getContentAsByteArray()))
          .isEqualTo(mapper.readTree(expected.toProtocolMap().toString()));
    }

    assertThat(validator.invocations()).isZero();
    assertThat(store.invocations()).isZero();
    assertThat(files.invocations()).isZero();
    assertThat(profileHandler.invocations()).isZero();
    assertThat(capabilityHandler.invocations()).isZero();
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class Fixture {
    @Bean
    MissingProfileOperation missingProfileOperation() {
      return new MissingProfileOperation();
    }

    @Bean
    MissingCapabilityOperation missingCapabilityOperation() {
      return new MissingCapabilityOperation();
    }

    @Bean
    CountingSchemaValidator countingSchemaValidator() {
      return new CountingSchemaValidator();
    }

    @Bean
    CountingRunStore countingRunStore() {
      return new CountingRunStore();
    }

    @Bean
    CountingFileValidator countingFileValidator() {
      return new CountingFileValidator();
    }
  }

  @GauntletOperation(
      id = "applications.missing-profile",
      featureId = "applications",
      label = "Missing profile",
      input = FinalizeInput.class,
      idempotency = Idempotency.OPTIONAL,
      requiredProfiles = {"tc-schema-core@1", "tc-rich-forms@1"})
  static final class MissingProfileOperation implements TypedOperationHandler<FinalizeInput> {
    private final AtomicInteger invocations = new AtomicInteger();

    @Override
    public OperationResult execute(FinalizeInput input, RunContext context) {
      invocations.incrementAndGet();
      return OperationResult.succeeded(JsonOwnership.object(java.util.Map.of()));
    }

    int invocations() {
      return invocations.get();
    }
  }

  @GauntletOperation(
      id = "applications.missing-capability",
      featureId = "applications",
      label = "Missing capability",
      input = FinalizeInput.class,
      idempotency = Idempotency.OPTIONAL,
      requiredCapabilities = "tc-uploads@1")
  static final class MissingCapabilityOperation implements TypedOperationHandler<FinalizeInput> {
    private final AtomicInteger invocations = new AtomicInteger();

    @Override
    public OperationResult execute(FinalizeInput input, RunContext context) {
      invocations.incrementAndGet();
      return OperationResult.succeeded(JsonOwnership.object(java.util.Map.of()));
    }

    int invocations() {
      return invocations.get();
    }
  }

  static final class CountingSchemaValidator implements SchemaValidator {
    private final AtomicInteger invocations = new AtomicInteger();
    private final NetworkntSchemaValidator delegate = new NetworkntSchemaValidator();

    @Override
    public List<ValidationError> validate(
        dev.eightlines.gauntlet.core.json.JsonObject schema, JsonValue instance) {
      invocations.incrementAndGet();
      return delegate.validate(schema, instance);
    }

    int invocations() {
      return invocations.get();
    }
  }

  static final class CountingFileValidator implements FileReferenceValidator {
    private final AtomicInteger invocations = new AtomicInteger();

    @Override
    public List<ValidationError> validate(ValidationRequest request) {
      invocations.incrementAndGet();
      return List.of();
    }

    int invocations() {
      return invocations.get();
    }
  }

  static final class CountingRunStore implements RunStore {
    private final AtomicInteger invocations = new AtomicInteger();

    @Override
    public RunStoreCreateResult createQueued(Run run, Optional<String> idempotencyFingerprint) {
      invocations.incrementAndGet();
      return RunStoreCreateResult.created(run);
    }

    @Override
    public Optional<Run> get(String runId) {
      invocations.incrementAndGet();
      return Optional.empty();
    }

    @Override
    public Optional<Run> findByIdempotencyFingerprint(String operationId, String fingerprint) {
      invocations.incrementAndGet();
      return Optional.empty();
    }

    @Override
    public boolean updateExactSequence(Run run, long expectedPreviousSequence) {
      invocations.incrementAndGet();
      return false;
    }

    int invocations() {
      return invocations.get();
    }
  }
}
