package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.fixture.FinalizeInput;
import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
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
    classes = {FixtureApplication.class, AdapterV1HttpTest.ConfirmationFixture.class},
    properties = {
      "gauntlet.enabled=true",
      "gauntlet.application.id=fixture-app",
      "gauntlet.application.label=Fixture application",
      "gauntlet.application.environment.name=fixture-test",
      "gauntlet.application.environment.kind=test",
      "gauntlet.idempotency-secret=fixture-idempotency-secret-32-bytes-long"
    })
@AutoConfigureMockMvc
class AdapterV1HttpTest {
  private static final AtomicInteger CONFIRMED_MUTATIONS = new AtomicInteger();

  @Autowired MockMvc mvc;
  @Autowired ObjectMapper objectMapper;

  @BeforeEach
  void resetConfirmedMutations() {
    CONFIRMED_MUTATIONS.set(0);
  }

  @Test
  void healthAndConditionalDocumentsUseCanonicalShapesAndStrongEtags() throws Exception {
    mvc.perform(get("/_gauntlet/v1/health"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("ok"))
        .andExpect(jsonPath("$.protocolVersion").value("1.0"));

    var first =
        mvc.perform(get("/_gauntlet/v1/manifest"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.features[0].id").value("applications"))
            .andExpect(jsonPath("$.operations[0].id").value("applications.confirmed"))
            .andExpect(jsonPath("$.operations[1].id").value("applications.finalize"))
            .andExpect(jsonPath("$.dataSources[0].id").value("applications"))
            .andReturn();
    String etag = first.getResponse().getHeader("ETag");
    assertThat(etag).matches("\"sha256:[0-9a-f]{64}\"");

    mvc.perform(get("/_gauntlet/v1/manifest").header("If-None-Match", etag))
        .andExpect(status().isNotModified())
        .andExpect(header().string("ETag", etag))
        .andExpect(header().doesNotExist("Content-Type"))
        .andExpect(content().string(""));

    var operation =
        mvc.perform(get("/_gauntlet/v1/operations/applications.finalize"))
            .andExpect(status().isOk())
            .andReturn();
    String operationEtag = operation.getResponse().getHeader("ETag");
    mvc.perform(
            get("/_gauntlet/v1/operations/applications.finalize")
                .header("If-None-Match", operationEtag))
        .andExpect(status().isNotModified())
        .andExpect(header().doesNotExist("Content-Type"))
        .andExpect(content().string(""));
  }

  @Test
  void createValidatesRevisionAndInputThenCompletesAndReplaysOneTerminalRun() throws Exception {
    String revision = fixtureRevision();
    String stale = "sha256:" + "f".repeat(64);
    mvc.perform(
            post("/_gauntlet/v1/operations/applications.finalize/runs")
                .contentType(MediaType.APPLICATION_JSON)
                .content(createBody(stale, "request-stale", "key-stale")))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:stale-operation-revision"));

    mvc.perform(
            post("/_gauntlet/v1/operations/applications.finalize/runs")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {"operationRevision":"%s","input":{},"context":{"requestId":"request-invalid"},"dryRun":false,"idempotencyKey":"key-invalid"}
                    """
                        .formatted(revision)))
        .andExpect(status().isUnprocessableContent())
        .andExpect(jsonPath("$.errors[0].instancePath").value("/applicationId"));

    var created =
        mvc.perform(
                post("/_gauntlet/v1/operations/applications.finalize/runs")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(createBody(revision, "request-valid", "replay-key")))
            .andExpect(status().isAccepted())
            .andExpect(jsonPath("$.state").value("queued"))
            .andExpect(jsonPath("$.sequence").value(0))
            .andReturn();
    String runId =
        objectMapper
            .readTree(created.getResponse().getContentAsByteArray())
            .required("id")
            .stringValue();

    byte[] terminal = awaitRunState(runId, "succeeded");
    assertThat(objectMapper.readTree(terminal).required("sequence").asInt()).isEqualTo(2);
    mvc.perform(
            post("/_gauntlet/v1/operations/applications.finalize/runs")
                .contentType(MediaType.APPLICATION_JSON)
                .content(createBody(revision, "request-valid", "replay-key")))
        .andExpect(status().isCreated())
        .andExpect(jsonPath("$.id").value(runId));
  }

  @Test
  void confirmationEnvelopeIsClosedAndPrecedesDryRunAndOperationExecution() throws Exception {
    String revision = fixtureRevision("applications.confirmed");
    String stale = "sha256:" + "e".repeat(64);
    String endpoint = "/_gauntlet/v1/operations/applications.confirmed/runs";

    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content(confirmedBody(stale, null, true, "stale-key")))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:stale-operation-revision"));

    Map<String, byte[]> invalid =
        Map.of(
            "/confirmation",
            confirmedBody(revision, null, true, "missing-key"),
            "/confirmation/operationId",
            confirmedBody(
                revision,
                confirmation("applications.other", revision, "write", null),
                false,
                "operation-key"),
            "/confirmation/operationRevision",
            confirmedBody(
                revision,
                confirmation("applications.confirmed", "sha256:" + "f".repeat(64), "write", null),
                false,
                "revision-key"),
            "/confirmation/impact",
            confirmedBody(
                revision,
                confirmation("applications.confirmed", revision, "read", null),
                false,
                "impact-key"));
    for (var entry : invalid.entrySet()) {
      mvc.perform(post(endpoint).contentType(MediaType.APPLICATION_JSON).content(entry.getValue()))
          .andExpect(status().isUnprocessableContent())
          .andExpect(jsonPath("$.errors[0].instancePath").value(entry.getKey()));
      assertThat(CONFIRMED_MUTATIONS.get()).isZero();
    }

    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    confirmedBody(
                        revision,
                        confirmation(
                            "applications.confirmed", revision, "write", "\"unexpected\":true"),
                        false,
                        "extra-key")))
        .andExpect(status().isUnprocessableContent())
        .andExpect(jsonPath("$.errors[0].instancePath").value("/confirmation/unexpected"));
    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    confirmedBody(
                        revision,
                        confirmation(
                            "applications.confirmed",
                            revision,
                            "write",
                            "\"extensions\":{\"not-a-urn\":true}"),
                        false,
                        "extension-key")))
        .andExpect(status().isUnprocessableContent())
        .andExpect(
            jsonPath("$.errors[0].instancePath").value("/confirmation/extensions/not-a-urn"));
    assertThat(CONFIRMED_MUTATIONS.get()).isZero();

    var accepted =
        mvc.perform(
                post(endpoint)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        confirmedBody(
                            revision,
                            confirmation(
                                "applications.confirmed",
                                revision,
                                "write",
                                "\"extensions\":{\"urn:fixture:confirmation\":{\"accepted\":true}}"),
                            false,
                            "accepted-key")))
            .andExpect(status().isAccepted())
            .andReturn();
    String runId =
        objectMapper
            .readTree(accepted.getResponse().getContentAsByteArray())
            .required("id")
            .stringValue();
    awaitRunState(runId, "succeeded");
    assertThat(CONFIRMED_MUTATIONS.get()).isEqualTo(1);
  }

  @Test
  void dataSourcesPreserveResolveOrderAndOptionalRoutesFailBeforeBodyParsing() throws Exception {
    mvc.perform(
            post("/_gauntlet/v1/data-sources/applications/query")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"search\":\"App\",\"limit\":2}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.items").isArray());

    mvc.perform(
            post("/_gauntlet/v1/data-sources/applications/resolve")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"values\":[\"app-1\",\"missing\"]}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.results.length()").value(2))
        .andExpect(jsonPath("$.results[0].value").value("app-1"))
        .andExpect(jsonPath("$.results[1].value").value("missing"))
        .andExpect(jsonPath("$.results[1].item").value((Object) null));

    mvc.perform(post("/_gauntlet/v1/runs/run-1/cancel"))
        .andExpect(status().isNotFound())
        .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:run-not-found"));
    mvc.perform(get("/_gauntlet/v1/runs/run-1/events"))
        .andExpect(status().isNotImplemented())
        .andExpect(jsonPath("$.capability").value("tc-run-sse@1"));
    mvc.perform(post("/_gauntlet/v1/uploads").content("not multipart"))
        .andExpect(status().isNotImplemented())
        .andExpect(jsonPath("$.capability").value("tc-uploads@1"));
    mvc.perform(post("/_gauntlet/v1/runs/run-1/artifacts/launch-1/launch"))
        .andExpect(status().isNotImplemented())
        .andExpect(jsonPath("$.capability").value("tc-session-launch@1"));
  }

  @Test
  void safeMissingResourcesAndHandlerFailureUseSanitizedProblems() throws Exception {
    mvc.perform(get("/_gauntlet/v1/operations/missing-operation"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:operation-not-found"));
    mvc.perform(get("/_gauntlet/v1/runs/missing-run"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:run-not-found"));
    mvc.perform(
            post("/_gauntlet/v1/data-sources/missing-source/query")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:data-source-not-found"));

    String revision = fixtureRevision();
    byte[] created =
        mvc.perform(
                post("/_gauntlet/v1/operations/applications.finalize/runs")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(createBody(revision, "request-failure", "failure-key", "throw")))
            .andExpect(status().isAccepted())
            .andExpect(jsonPath("$.state").value("queued"))
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
    String runId = objectMapper.readTree(created).required("id").stringValue();
    byte[] failed = awaitRunState(runId, "failed");
    assertThat(objectMapper.readTree(failed).required("problem").required("type").stringValue())
        .isEqualTo("urn:gauntlet:problem:handler-failed");
    assertThat(new String(failed, StandardCharsets.UTF_8)).doesNotContain("fixture boom");
  }

  private byte[] awaitRunState(String runId, String expectedState) throws Exception {
    long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2);
    do {
      byte[] body =
          mvc.perform(get("/_gauntlet/v1/runs/{id}", runId))
              .andExpect(status().isOk())
              .andReturn()
              .getResponse()
              .getContentAsByteArray();
      String state = objectMapper.readTree(body).required("state").stringValue();
      if (expectedState.equals(state)) return body;
      if (!"queued".equals(state) && !"running".equals(state)) {
        throw new AssertionError("run reached unexpected terminal state " + state);
      }
      Thread.sleep(10);
    } while (System.nanoTime() < deadline);
    throw new AssertionError("run did not reach state " + expectedState);
  }

  @Test
  void rawAndJsonRequestBoundariesFailClosedWithTypedValueFreeProblems() throws Exception {
    mvc.perform(get("/_gauntlet/v1/operations/unsafe!id"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:invalid-path"));
    mvc.perform(post("/_gauntlet/v1/manifest"))
        .andExpect(status().isMethodNotAllowed())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:method-not-allowed"));
    mvc.perform(get("/_gauntlet/v1/manifest").queryParam("forbidden", "1"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:invalid-path"));

    String endpoint = "/_gauntlet/v1/data-sources/applications/query";
    mvc.perform(post(endpoint).contentType(MediaType.TEXT_PLAIN).content("{}"))
        .andExpect(status().isUnsupportedMediaType())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:unsupported-media-type"));
    mvc.perform(post(endpoint).contentType(MediaType.APPLICATION_JSON).content("{not-json"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:invalid-json"));
    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"search\":\"a\",\"search\":\"b\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:invalid-json"));
    mvc.perform(post(endpoint).contentType(MediaType.APPLICATION_JSON).content("[]"))
        .andExpect(status().isUnprocessableContent())
        .andExpect(jsonPath("$.errors[0].instancePath").value(""));
    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"unknown\":\"sentinel-value\"}"))
        .andExpect(status().isUnprocessableContent())
        .andExpect(
            content()
                .string(
                    org.hamcrest.Matchers.not(
                        org.hamcrest.Matchers.containsString("sentinel-value"))));
    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"extensions\":{\"not-a-urn\":true}}"))
        .andExpect(status().isUnprocessableContent())
        .andExpect(jsonPath("$.errors[0].instancePath").value("/extensions/not-a-urn"));
    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"padding\":\"" + "x".repeat(4 * 1024 * 1024) + "\"}"))
        .andExpect(status().isContentTooLarge())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:request-too-large"));
  }

  @Test
  void nestedEnvelopeErrorsRetainTheirCompleteJsonPointer() throws Exception {
    String revision = fixtureRevision();
    String endpoint = "/_gauntlet/v1/operations/applications.finalize/runs";

    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {"operationRevision":"%s","input":{},"context":{"requestId":"request-locale","locale":false}}
                    """
                        .formatted(revision)))
        .andExpect(status().isUnprocessableContent())
        .andExpect(jsonPath("$.errors[0].instancePath").value("/context/locale"));

    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {"operationRevision":"%s","input":{},"context":{"requestId":"request-actor","actor":{"id":"actor-1","displayName":false}}}
                    """
                        .formatted(revision)))
        .andExpect(status().isUnprocessableContent())
        .andExpect(jsonPath("$.errors[0].instancePath").value("/context/actor/displayName"));

    mvc.perform(
            post(endpoint)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {"operationRevision":"%s","input":{},"context":{"requestId":"request-extension","extensions":{"not-a-urn":"secret-sentinel"}}}
                    """
                        .formatted(revision)))
        .andExpect(status().isUnprocessableContent())
        .andExpect(jsonPath("$.errors[0].instancePath").value("/context/extensions/not-a-urn"))
        .andExpect(
            content()
                .string(
                    org.hamcrest.Matchers.not(
                        org.hamcrest.Matchers.containsString("secret-sentinel"))));
  }

  private String fixtureRevision() throws Exception {
    return fixtureRevision("applications.finalize");
  }

  private String fixtureRevision(String operationId) throws Exception {
    byte[] body =
        mvc.perform(get("/_gauntlet/v1/operations/{operationId}", operationId))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
    return objectMapper.readTree(body).required("revision").stringValue();
  }

  private static byte[] createBody(String revision, String requestId, String key) {
    return createBody(revision, requestId, key, "complete");
  }

  private static byte[] createBody(String revision, String requestId, String key, String reason) {
    return """
        {"operationRevision":"%s","input":{"applicationId":"11111111-1111-4111-8111-111111111111","reason":"%s"},"context":{"requestId":"%s"},"dryRun":false,"idempotencyKey":"%s"}
        """
        .formatted(revision, reason, requestId, key)
        .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] confirmedBody(
      String revision, String confirmation, boolean dryRun, String key) {
    return """
        {"operationRevision":"%s","input":{"applicationId":"11111111-1111-4111-8111-111111111111","reason":"complete"},"dryRun":%s,"idempotencyKey":"%s"%s}
        """
        .formatted(
            revision, dryRun, key, confirmation == null ? "" : ",\"confirmation\":" + confirmation)
        .getBytes(StandardCharsets.UTF_8);
  }

  private static String confirmation(
      String operationId, String revision, String impact, String extraMember) {
    return """
        {"operationId":"%s","operationRevision":"%s","impact":"%s"%s}
        """
        .formatted(operationId, revision, impact, extraMember == null ? "" : "," + extraMember)
        .strip();
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class ConfirmationFixture {
    @Bean
    ConfirmedOperation confirmedOperation() {
      return new ConfirmedOperation();
    }
  }

  @GauntletOperation(
      id = "applications.confirmed",
      featureId = "applications",
      label = "Confirmed operation",
      input = FinalizeInput.class,
      impact = OperationImpact.WRITE,
      confirmationRequired = true,
      idempotency = Idempotency.REQUIRED)
  static final class ConfirmedOperation implements TypedOperationHandler<FinalizeInput> {
    @Override
    public OperationResult execute(FinalizeInput input, RunContext context) {
      CONFIRMED_MUTATIONS.incrementAndGet();
      return OperationResult.succeeded(
          dev.eightlines.gauntlet.core.json.JsonOwnership.object(Map.of()));
    }
  }
}
