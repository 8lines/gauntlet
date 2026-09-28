package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.ValidationError;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/** Emits only canonical RFC 9457 fields from the closed adapter problem vocabulary. */
public final class ProblemResponseFactory {
  public static final MediaType PROBLEM_JSON = MediaType.parseMediaType("application/problem+json");

  public ResponseEntity<byte[]> response(Problem problem) {
    Problem safe;
    try {
      safe = sanitize(problem);
    } catch (RuntimeException exception) {
      safe = internalProblem();
    }
    return ResponseEntity.status(safe.status())
        .contentType(PROBLEM_JSON)
        .body(CanonicalJson.encode(safe.toProtocolMap()));
  }

  public ResponseEntity<byte[]> internal() {
    return response(internalProblem());
  }

  public void write(HttpServletResponse response, Problem problem) throws IOException {
    Problem safe;
    try {
      safe = sanitize(problem);
    } catch (RuntimeException exception) {
      safe = internalProblem();
    }
    byte[] body = CanonicalJson.encode(safe.toProtocolMap());
    response.reset();
    response.setStatus(safe.status());
    response.setContentType(PROBLEM_JSON.toString());
    response.setContentLength(body.length);
    response.getOutputStream().write(body);
  }

  public static Problem problem(String slug, String title, int status) {
    return new Problem("urn:gauntlet:problem:" + slug, title, status);
  }

  public static Problem unsupported(String capability) {
    return new Problem(
        "urn:gauntlet:problem:unsupported-capability",
        "Unsupported capability",
        501,
        "The adapter does not advertise or implement this capability.",
        null,
        null,
        List.of(),
        capability,
        empty());
  }

  public static Problem validation(List<ValidationError> errors) {
    return new Problem(
        "urn:gauntlet:problem:validation-failed",
        "Validation failed",
        422,
        null,
        null,
        null,
        List.copyOf(errors),
        null,
        empty());
  }

  Problem sanitizeEmbedded(Problem problem) {
    return sanitize(problem);
  }

  private static Problem sanitize(Problem problem) {
    if (problem == null) throw new IllegalArgumentException("missing problem");
    return switch (problem.type()) {
      case "urn:gauntlet:problem:adapter-disabled" -> fixed(problem, "Adapter disabled", 503);
      case "urn:gauntlet:problem:unsupported-capability" -> {
        if (problem.status() != 501 || problem.capability() == null) throw invalid();
        yield unsupported(problem.capability());
      }
      case "urn:gauntlet:problem:operation-not-found" -> fixed(problem, "Operation not found", 404);
      case "urn:gauntlet:problem:run-not-found" -> fixed(problem, "Run not found", 404);
      case "urn:gauntlet:problem:data-source-not-found" ->
          fixed(problem, "Data source not found", 404);
      case "urn:gauntlet:problem:route-not-found" -> fixed(problem, "Route not found", 404);
      case "urn:gauntlet:problem:method-not-allowed" -> fixed(problem, "Method not allowed", 405);
      case "urn:gauntlet:problem:invalid-json" -> fixed(problem, "Invalid JSON", 400);
      case "urn:gauntlet:problem:unsupported-media-type" ->
          fixed(problem, "Unsupported media type", 415);
      case "urn:gauntlet:problem:request-too-large" -> fixed(problem, "Request too large", 413);
      case "urn:gauntlet:problem:invalid-path" -> fixed(problem, "Invalid path", 400);
      case "urn:gauntlet:problem:validation-failed" -> sanitizeValidation(problem);
      case "urn:gauntlet:problem:stale-operation-revision" ->
          fixed(problem, "Operation revision is stale", 409);
      case "urn:gauntlet:problem:operation-busy" -> fixed(problem, "Operation busy", 409);
      case "urn:gauntlet:problem:run-not-cancellable" ->
          fixed(problem, "Run is not cancellable", 409);
      case "urn:gauntlet:problem:run-cancelled" -> fixed(problem, "Run cancelled", 409);
      case "urn:gauntlet:problem:run-timed-out" -> fixed(problem, "Run timed out", 504);
      case "urn:gauntlet:problem:handler-failed" -> fixed(problem, "Operation failed", 500);
      case "urn:gauntlet:problem:adapter-invalid-response" ->
          fixed(problem, "Invalid adapter response", 502);
      case "urn:gauntlet:problem:adapter-unavailable" -> {
        if (problem.status() != 503) throw invalid();
        yield new Problem(
            problem.type(),
            "Operation unavailable",
            503,
            "The operation requirements are not available in this adapter.",
            null,
            null,
            List.of(),
            null,
            empty());
      }
      case "urn:gauntlet:problem:adapter-internal-error" -> internalProblem();
      default -> throw invalid();
    };
  }

  private static Problem sanitizeValidation(Problem problem) {
    if (problem.status() != 422 || problem.errors().size() > 100) throw invalid();
    List<ValidationError> errors =
        problem.errors().stream()
            .map(
                error ->
                    new ValidationError(
                        pointer(error.instancePath(), ""),
                        pointer(error.schemaPath(), "#"),
                        keyword(error.keyword()),
                        "value does not satisfy schema",
                        empty()))
            .toList();
    return validation(errors);
  }

  private static String pointer(String value, String fallback) {
    if (value == null
        || value.length() > 512
        || value.chars().anyMatch(character -> character < 0x20 || character == 0x7f)) {
      return fallback;
    }
    if (fallback.isEmpty()) return value.isEmpty() || value.startsWith("/") ? value : fallback;
    return value.equals("#") || value.startsWith("#/") ? value : fallback;
  }

  private static String keyword(String value) {
    return value != null && value.matches("^[A-Za-z0-9._:-]{1,64}$") ? value : "validation";
  }

  private static Problem fixed(Problem problem, String title, int status) {
    if (problem.status() != status) throw invalid();
    return new Problem(problem.type(), title, status);
  }

  private static Problem internalProblem() {
    return new Problem(
        "urn:gauntlet:problem:adapter-internal-error",
        "Adapter internal error",
        500,
        null,
        null,
        "tc-" + UUID.randomUUID(),
        List.of(),
        null,
        empty());
  }

  private static IllegalArgumentException invalid() {
    return new IllegalArgumentException("unsafe adapter problem");
  }

  private static JsonObject empty() {
    return JsonOwnership.object(Map.of());
  }
}
