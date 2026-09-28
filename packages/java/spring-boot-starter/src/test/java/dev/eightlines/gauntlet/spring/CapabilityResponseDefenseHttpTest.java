package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.FollowUpAction;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.OperationOutput;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunEvent;
import dev.eightlines.gauntlet.core.model.SessionLaunchResponse;
import dev.eightlines.gauntlet.spring.capability.CancelRunEndpoint;
import dev.eightlines.gauntlet.spring.capability.RunEventsEndpoint;
import dev.eightlines.gauntlet.spring.capability.SessionLaunchEndpoint;
import dev.eightlines.gauntlet.spring.capability.UploadEndpoint;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import dev.eightlines.gauntlet.spring.http.CapabilityRunValidator;
import dev.eightlines.gauntlet.spring.http.RawAdapterPrefixFilter;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class CapabilityResponseDefenseHttpTest {
  private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");

  @Test
  void invalidSpiResponsesFailClosedAndProviderExceptionsNeverLeak() {
    new WebApplicationContextRunner()
        .withUserConfiguration(FixtureApplication.class, HostileCapabilities.class)
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

              expectInvalid(mvc, post("/_gauntlet/v1/runs/run-1/cancel"));
              expectInvalidStream(mvc, "run-1");
              assertThat(
                      HostileCapabilities.hostileRun(
                              "unknown-operation", context.getBean(SpringAdapterCatalog.class))
                          .operationId())
                  .isEqualTo("applications.missing");
              for (String hostileRunId :
                  List.of("unknown-operation", "invalid-output", "invalid-action")) {
                expectInvalid(mvc, post("/_gauntlet/v1/runs/" + hostileRunId + "/cancel"));
                expectInvalidStream(mvc, hostileRunId);
              }
              Run validNoOutput =
                  HostileCapabilities.hostileRun(
                      "valid-no-output", context.getBean(SpringAdapterCatalog.class));
              assertThat(
                      context
                          .getBean(CapabilityRunValidator.class)
                          .validate(
                              validNoOutput,
                              "valid-no-output",
                              null,
                              CapabilityRunValidator.Origin.CAPABILITY))
                  .isEqualTo(validNoOutput);
              expectValidNoOutput(mvc);
              expectInvalid(
                  mvc,
                  multipart("/_gauntlet/v1/uploads")
                      .file(
                          new MockMultipartFile(
                              "file", "fixture.txt", "text/plain", new byte[] {1})));
              expectInvalid(mvc, post("/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch"));

              try {
                mvc.perform(post("/_gauntlet/v1/runs/throw-secret/cancel"))
                    .andExpect(status().isInternalServerError())
                    .andExpect(
                        content()
                            .string(
                                org.hamcrest.Matchers.not(
                                    org.hamcrest.Matchers.containsString(
                                        "provider-secret-sentinel"))));
              } catch (Exception exception) {
                throw new AssertionError(exception);
              }
            });
  }

  private static void expectInvalid(
      MockMvc mvc, org.springframework.test.web.servlet.RequestBuilder request) {
    try {
      mvc.perform(request)
          .andExpect(status().isBadGateway())
          .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:adapter-invalid-response"));
    } catch (Exception exception) {
      throw new AssertionError(exception);
    }
  }

  private static void expectInvalidStream(MockMvc mvc, String runId) {
    try {
      var initial =
          mvc.perform(get("/_gauntlet/v1/runs/" + runId + "/events"))
              .andExpect(request().asyncStarted())
              .andExpect(status().isOk())
              .andReturn();
      initial.getAsyncResult(5_000);
      mvc.perform(asyncDispatch(initial))
          .andExpect(status().isBadGateway())
          .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:adapter-invalid-response"))
          .andExpect(
              content()
                  .string(
                      org.hamcrest.Matchers.not(
                          org.hamcrest.Matchers.containsString("provider-secret-sentinel"))));
    } catch (Exception exception) {
      throw new AssertionError(exception);
    }
  }

  private static void expectValidNoOutput(MockMvc mvc) {
    try {
      mvc.perform(post("/_gauntlet/v1/runs/valid-no-output/cancel"))
          .andExpect(status().isAccepted())
          .andExpect(jsonPath("$.state").value("succeeded"))
          .andExpect(jsonPath("$.output").doesNotExist());
      var initial =
          mvc.perform(get("/_gauntlet/v1/runs/valid-no-output/events"))
              .andExpect(request().asyncStarted())
              .andExpect(status().isOk())
              .andReturn();
      initial.getAsyncResult(5_000);
      mvc.perform(asyncDispatch(initial))
          .andExpect(status().isOk())
          .andExpect(
              content().string(org.hamcrest.Matchers.containsString("\"state\":\"succeeded\"")))
          .andExpect(
              content()
                  .string(
                      org.hamcrest.Matchers.not(
                          org.hamcrest.Matchers.containsString("\"output\""))));
    } catch (Exception exception) {
      throw new AssertionError(exception);
    }
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class HostileCapabilities {
    @Bean
    Clock hostileClock() {
      return Clock.fixed(NOW, ZoneOffset.UTC);
    }

    @Bean
    CancelRunEndpoint hostileCancellation(ObjectProvider<SpringAdapterCatalog> catalogs) {
      return runId -> {
        if (runId.equals("throw-secret")) {
          throw new IllegalStateException("provider-secret-sentinel");
        }
        if (!runId.equals("run-1")) return hostileRun(runId, catalogs.getObject());
        return Run.queued("different-run", definition(), NOW);
      };
    }

    @Bean
    RunEventsEndpoint hostileEvents(ObjectProvider<SpringAdapterCatalog> catalogs) {
      return (runId, lastEventId) -> {
        Run other =
            runId.equals("run-1")
                ? Run.queued("different-run", definition(), NOW)
                : hostileRun(runId, catalogs.getObject());
        return List.of(
            new RunEvent(
                "event-1", other.sequence(), other.updatedAt(), "run.updated", other, empty()));
      };
    }

    private static Run hostileRun(String runId, SpringAdapterCatalog catalog) {
      if (runId.equals("unknown-operation")) {
        return Run.queued(runId, definition("applications.missing"), NOW);
      }
      OperationDefinition known = catalog.operation("applications.finalize").orElseThrow();
      Run running = Run.queued(runId, known, NOW).running(NOW.plusSeconds(1));
      if (runId.equals("valid-no-output")) {
        return running.terminal(OperationResult.succeeded(null), NOW.plusSeconds(2));
      }
      if (runId.equals("invalid-output")) {
        return running.terminal(
            OperationResult.succeeded(
                new dev.eightlines.gauntlet.core.json.JsonValue.Scalar("bad")),
            NOW.plusSeconds(2));
      }
      return running.terminal(
          OperationResult.succeeded(
              null,
              empty(),
              List.of(),
              List.of(
                  FollowUpAction.invokeOperation(
                      "Unknown operation", "applications.missing", empty()))),
          NOW.plusSeconds(2));
    }

    @Bean
    UploadEndpoint hostileUpload() {
      return file -> null;
    }

    @Bean
    SessionLaunchEndpoint hostileSession() {
      return (runId, artifactId) ->
          new SessionLaunchResponse(
              "https://portal.example.test/session",
              NOW.plusSeconds(16 * 60).toString(),
              true,
              empty(),
              Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static OperationDefinition definition() {
      return definition("applications.finalize");
    }

    private static OperationDefinition definition(String operationId) {
      var schema =
          JsonOwnership.object(
              Map.of(
                  "$schema", "https://json-schema.org/draft/2020-12/schema",
                  "type", "object"));
      return new OperationDefinition(
          operationId,
          "applications",
          "Finalize application",
          null,
          schema,
          null,
          null,
          null,
          List.of(),
          List.of(),
          new ExecutionPolicy(
              OperationImpact.WRITE,
              false,
              false,
              Idempotency.OPTIONAL,
              false,
              null,
              "allow",
              empty()),
          new OperationOutput(schema, null, empty()),
          null,
          0,
          List.of(),
          null,
          empty());
    }

    private static dev.eightlines.gauntlet.core.json.JsonObject empty() {
      return JsonOwnership.object(Map.of());
    }
  }
}
