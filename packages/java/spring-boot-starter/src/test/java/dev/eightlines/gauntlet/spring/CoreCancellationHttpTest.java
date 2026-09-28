package dev.eightlines.gauntlet.spring;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.Artifact;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
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
    classes = {FixtureApplication.class, CoreCancellationHttpTest.CancellationFixture.class},
    properties = {
      "gauntlet.enabled=true",
      "gauntlet.application.id=fixture-app",
      "gauntlet.application.label=Fixture application",
      "gauntlet.application.environment.name=fixture-test",
      "gauntlet.application.environment.kind=test",
      "gauntlet.idempotency-secret=fixture-idempotency-secret-32-bytes-long"
    })
@AutoConfigureMockMvc
class CoreCancellationHttpTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper mapper;
  @Autowired BlockingOperation operation;
  @Autowired NonCancellableOperation nonCancellableOperation;

  @BeforeEach
  void resetHandlers() {
    operation.reset();
    nonCancellableOperation.reset();
  }

  @AfterEach
  void releaseHandler() {
    operation.release.countDown();
    nonCancellableOperation.release.countDown();
  }

  @Test
  void builtInCancellationCapabilityBridgesToTheCoreRunManager() throws Exception {
    String revision =
        mapper
            .readTree(
                mvc.perform(get("/_gauntlet/v1/operations/applications.blocking"))
                    .andExpect(status().isOk())
                    .andReturn()
                    .getResponse()
                    .getContentAsByteArray())
            .required("revision")
            .stringValue();
    byte[] createdBody =
        mvc.perform(
                post("/_gauntlet/v1/operations/applications.blocking/runs")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        """
                        {"operationRevision":"%s","input":{},"dryRun":false,"idempotencyKey":"cancel-key"}
                        """
                            .formatted(revision)))
            .andExpect(status().isAccepted())
            .andExpect(jsonPath("$.state").value("queued"))
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
    String runId = mapper.readTree(createdBody).required("id").stringValue();
    org.junit.jupiter.api.Assertions.assertTrue(operation.started.await(1, TimeUnit.SECONDS));

    mvc.perform(post("/_gauntlet/v1/runs/{runId}/cancel", runId))
        .andExpect(status().isAccepted())
        .andExpect(jsonPath("$.state").value("cancelled"))
        .andExpect(jsonPath("$.problem.type").value("urn:gauntlet:problem:run-cancelled"))
        .andExpect(jsonPath("$.problem.title").value("Run cancelled"))
        .andExpect(jsonPath("$.problem.status").value(409));

    operation.release.countDown();
    org.junit.jupiter.api.Assertions.assertTrue(operation.finished.await(1, TimeUnit.SECONDS));
    mvc.perform(get("/_gauntlet/v1/runs/{runId}", runId))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.state").value("cancelled"))
        .andExpect(jsonPath("$.artifacts").isEmpty());
  }

  @Test
  void builtInCancellationRejectsAnActiveOperationThatDoesNotSupportCancellation()
      throws Exception {
    String revision =
        mapper
            .readTree(
                mvc.perform(get("/_gauntlet/v1/operations/applications.non-cancellable"))
                    .andExpect(status().isOk())
                    .andReturn()
                    .getResponse()
                    .getContentAsByteArray())
            .required("revision")
            .stringValue();
    byte[] createdBody =
        mvc.perform(
                post("/_gauntlet/v1/operations/applications.non-cancellable/runs")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        """
                        {"operationRevision":"%s","input":{},"dryRun":false,"idempotencyKey":"not-cancellable-key"}
                        """
                            .formatted(revision)))
            .andExpect(status().isAccepted())
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
    String runId = mapper.readTree(createdBody).required("id").stringValue();
    org.junit.jupiter.api.Assertions.assertTrue(
        nonCancellableOperation.started.await(1, TimeUnit.SECONDS));

    mvc.perform(post("/_gauntlet/v1/runs/{runId}/cancel", runId))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:run-not-cancellable"))
        .andExpect(jsonPath("$.title").value("Run is not cancellable"))
        .andExpect(jsonPath("$.status").value(409));
    mvc.perform(get("/_gauntlet/v1/runs/{runId}", runId))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.state").value("running"));

    nonCancellableOperation.release.countDown();
    org.junit.jupiter.api.Assertions.assertTrue(
        nonCancellableOperation.finished.await(1, TimeUnit.SECONDS));
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class CancellationFixture {
    @Bean
    BlockingOperation blockingOperation() {
      return new BlockingOperation();
    }

    @Bean
    NonCancellableOperation nonCancellableOperation() {
      return new NonCancellableOperation();
    }
  }

  record EmptyInput() {}

  @GauntletOperation(
      id = "applications.blocking",
      featureId = "applications",
      label = "Blocking operation",
      input = EmptyInput.class,
      idempotency = Idempotency.OPTIONAL,
      cancellationSupported = true,
      concurrency = "forbid")
  static final class BlockingOperation implements TypedOperationHandler<EmptyInput> {
    private CountDownLatch started;
    private CountDownLatch release;
    private CountDownLatch finished;

    void reset() {
      started = new CountDownLatch(1);
      release = new CountDownLatch(1);
      finished = new CountDownLatch(1);
    }

    @Override
    public OperationResult execute(EmptyInput input, RunContext context) {
      started.countDown();
      boolean interrupted = false;
      while (true) {
        try {
          release.await();
          break;
        } catch (InterruptedException exception) {
          interrupted = true;
        }
      }
      context.addArtifact(
          new Artifact(
              "late",
              "notice",
              null,
              JsonOwnership.object(Map.of("level", "info", "message", "late")),
              JsonOwnership.object(Map.of())));
      finished.countDown();
      if (interrupted) Thread.currentThread().interrupt();
      return OperationResult.succeeded(JsonOwnership.object(Map.of()));
    }
  }

  @GauntletOperation(
      id = "applications.non-cancellable",
      featureId = "applications",
      label = "Non-cancellable operation",
      input = EmptyInput.class,
      idempotency = Idempotency.OPTIONAL,
      cancellationSupported = false,
      concurrency = "forbid")
  static final class NonCancellableOperation implements TypedOperationHandler<EmptyInput> {
    private CountDownLatch started;
    private CountDownLatch release;
    private CountDownLatch finished;

    void reset() {
      started = new CountDownLatch(1);
      release = new CountDownLatch(1);
      finished = new CountDownLatch(1);
    }

    @Override
    public OperationResult execute(EmptyInput input, RunContext context) throws Exception {
      started.countDown();
      release.await();
      finished.countDown();
      return OperationResult.succeeded(JsonOwnership.object(Map.of()));
    }
  }
}
