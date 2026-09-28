package dev.eightlines.gauntlet.spring.http;

import static org.assertj.core.api.Assertions.assertThat;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.Problem;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class ProblemResponseFactoryTest {
  private final ObjectMapper mapper = new ObjectMapper();
  private final ProblemResponseFactory factory = new ProblemResponseFactory();

  @Test
  void unavailableProblemsAreRebuiltFromTheClosedSafeVocabulary() throws Exception {
    var hostile =
        new Problem(
            "urn:gauntlet:problem:adapter-unavailable",
            "secret-sentinel title",
            503,
            "secret-sentinel detail",
            "https://secret-sentinel.example.test",
            "secret-sentinel-correlation",
            List.of(),
            null,
            JsonOwnership.object(Map.of("urn:test:secret", "secret-sentinel")));

    byte[] body = factory.response(hostile).getBody();
    var parsed = mapper.readTree(body);

    assertThat(parsed.required("title").stringValue()).isEqualTo("Operation unavailable");
    assertThat(parsed.required("status").asInt()).isEqualTo(503);
    assertThat(parsed.required("detail").stringValue())
        .isEqualTo("The operation requirements are not available in this adapter.");
    assertThat(new String(body, java.nio.charset.StandardCharsets.UTF_8))
        .doesNotContain("secret-sentinel");
  }

  @Test
  void executionPolicyProblemsUseOnlyTheirExactSafeTitlesAndStatuses() throws Exception {
    var expected =
        Map.of(
            "urn:gauntlet:problem:operation-busy", Map.entry("Operation busy", 409),
            "urn:gauntlet:problem:run-not-cancellable", Map.entry("Run is not cancellable", 409),
            "urn:gauntlet:problem:run-cancelled", Map.entry("Run cancelled", 409),
            "urn:gauntlet:problem:run-timed-out", Map.entry("Run timed out", 504));

    for (var entry : expected.entrySet()) {
      var hostile =
          new Problem(
              entry.getKey(),
              "secret-sentinel title",
              entry.getValue().getValue(),
              "secret-sentinel detail",
              null,
              null,
              List.of(),
              null,
              JsonOwnership.object(Map.of()));

      byte[] body = factory.response(hostile).getBody();
      var parsed = mapper.readTree(body);

      assertThat(parsed.required("title").stringValue()).isEqualTo(entry.getValue().getKey());
      assertThat(parsed.required("status").asInt()).isEqualTo(entry.getValue().getValue());
      assertThat(new String(body, java.nio.charset.StandardCharsets.UTF_8))
          .doesNotContain("secret-sentinel");
    }
  }

  @Test
  void executionPolicyProblemWithTheWrongStatusFailsClosed() throws Exception {
    var hostile =
        new Problem(
            "urn:gauntlet:problem:run-timed-out",
            "Run timed out",
            409,
            "secret-sentinel",
            null,
            null,
            List.of(),
            null,
            JsonOwnership.object(Map.of()));

    byte[] body = factory.response(hostile).getBody();
    var parsed = mapper.readTree(body);

    assertThat(parsed.required("type").stringValue())
        .isEqualTo("urn:gauntlet:problem:adapter-internal-error");
    assertThat(parsed.required("status").asInt()).isEqualTo(500);
    assertThat(new String(body, java.nio.charset.StandardCharsets.UTF_8))
        .doesNotContain("secret-sentinel");
  }
}
