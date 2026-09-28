package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.ProtocolId;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunEvent;
import dev.eightlines.gauntlet.core.model.SessionLaunchResponse;
import dev.eightlines.gauntlet.core.model.ValidationError;
import dev.eightlines.gauntlet.core.run.RuntimeGuard;
import dev.eightlines.gauntlet.spring.capability.RunEventsEndpoint;
import dev.eightlines.gauntlet.spring.capability.SpringCapabilityRegistry;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

/** Owns each optional canonical path exactly once, independent of installed SPI combinations. */
@RestController
@RequestMapping("/_gauntlet/v1")
public final class CapabilityController {
  private static final Duration MAX_SESSION_TTL = Duration.ofMinutes(15);
  private static final int MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

  private final SpringCapabilityRegistry capabilities;
  private final ProblemResponseFactory problems;
  private final CapabilityRunValidator runValidator;
  private final Clock clock;

  public CapabilityController(
      SpringCapabilityRegistry capabilities,
      ProblemResponseFactory problems,
      CapabilityRunValidator runValidator,
      Clock clock) {
    this.capabilities = capabilities;
    this.problems = problems;
    this.runValidator = runValidator;
    this.clock = clock;
  }

  @PostMapping("/runs/{runId}/cancel")
  public ResponseEntity<byte[]> cancel(@PathVariable(name = "runId") String runId)
      throws Exception {
    var endpoint = capabilities.cancellation();
    if (endpoint.isEmpty())
      return problems.response(capabilities.unavailable(SpringCapabilityRegistry.CANCELLATION));
    Run run =
        runValidator.validate(
            endpoint.orElseThrow().cancel(runId),
            runId,
            null,
            CapabilityRunValidator.Origin.CAPABILITY);
    return json(run.toProtocolMap(), 202);
  }

  @GetMapping(value = "/runs/{runId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public ResponseEntity<StreamingResponseBody> events(
      @PathVariable(name = "runId") String runId,
      @RequestHeader(name = "Last-Event-ID", required = false) String lastEventId)
      throws Exception {
    var endpoint = capabilities.events();
    if (endpoint.isEmpty()) {
      throw new SpringAdapterException(capabilities.unavailable(SpringCapabilityRegistry.EVENTS));
    }
    validateResumeId(lastEventId);
    RunEventsEndpoint provider = endpoint.orElseThrow();
    StreamingResponseBody body = output -> streamEvents(provider, runId, lastEventId, output);
    return ResponseEntity.ok()
        .contentType(MediaType.TEXT_EVENT_STREAM)
        .header(HttpHeaders.CACHE_CONTROL, "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(body);
  }

  @PostMapping(value = "/uploads", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  public ResponseEntity<byte[]> upload(@RequestPart(name = "file") MultipartFile file)
      throws Exception {
    var endpoint = capabilities.uploads();
    if (endpoint.isEmpty())
      return problems.response(capabilities.unavailable(SpringCapabilityRegistry.UPLOADS));
    var response = endpoint.orElseThrow().create(file);
    if (response == null) throw invalidResponse();
    return json(response.toProtocolMap(), 201);
  }

  @PostMapping("/runs/{runId}/artifacts/{artifactId}/launch")
  public ResponseEntity<byte[]> launch(
      @PathVariable(name = "runId") String runId,
      @PathVariable(name = "artifactId") String artifactId)
      throws Exception {
    var endpoint = capabilities.sessionLaunch();
    if (endpoint.isEmpty()) {
      return problems.response(capabilities.unavailable(SpringCapabilityRegistry.SESSION_LAUNCH));
    }
    SessionLaunchResponse response = endpoint.orElseThrow().launch(runId, artifactId);
    validateSession(response);
    return json(response.toProtocolMap(), 201);
  }

  private void validateSession(SessionLaunchResponse response) {
    if (response == null) throw invalidResponse();
    new SessionLaunchResponse(
        response.url(), response.expiresAt(), response.singleUse(), response.extensions(), clock);
    Duration ttl =
        Duration.between(clock.instant(), OffsetDateTime.parse(response.expiresAt()).toInstant());
    if (ttl.isNegative() || ttl.isZero() || ttl.compareTo(MAX_SESSION_TTL) > 0) {
      throw invalidResponse();
    }
  }

  private static ResponseEntity<byte[]> json(JsonObject value, int status) {
    return ResponseEntity.status(status)
        .contentType(MediaType.APPLICATION_JSON)
        .body(CanonicalJson.encode(value));
  }

  private void streamEvents(
      RunEventsEndpoint provider, String runId, String lastEventId, java.io.OutputStream output)
      throws IOException {
    Iterable<RunEvent> supplied = null;
    Iterator<RunEvent> iterator = null;
    Run previous = null;
    try {
      supplied = provider.events(runId, lastEventId);
      if (supplied == null) throw invalidResponse();
      iterator = supplied.iterator();
      if (iterator == null) throw invalidResponse();
      while (iterator.hasNext()) {
        RunEvent event = iterator.next();
        Run run = validateEvent(event, runId, previous);
        byte[] prefix =
            ("id: " + event.id() + "\nevent: " + event.type() + "\ndata: ")
                .getBytes(StandardCharsets.UTF_8);
        long jsonBudget = MAX_SSE_EVENT_BYTES - (long) prefix.length - 2;
        RunEvent safeEvent =
            new RunEvent(
                event.id(),
                event.sequence(),
                event.occurredAt(),
                event.type(),
                run,
                event.extensions());
        JsonObject wire = safeEvent.toProtocolMap();
        if (jsonBudget < 0 || !canonicalJsonFits(wire, jsonBudget)) {
          throw invalidResponse();
        }
        byte[] json = CanonicalJson.encode(wire);
        if (json.length > jsonBudget) throw invalidResponse();
        output.write(prefix);
        output.write(json);
        output.write('\n');
        output.write('\n');
        output.flush();
        previous = run;
      }
    } catch (IOException exception) {
      throw exception;
    } catch (SpringAdapterException exception) {
      throw exception;
    } catch (Exception exception) {
      throw invalidResponse();
    } finally {
      close(iterator);
      if (supplied != iterator) close(supplied);
    }
  }

  private Run validateEvent(RunEvent event, String runId, Run previous) {
    Run run =
        event == null
            ? null
            : runValidator.validate(
                event.run(), runId, null, CapabilityRunValidator.Origin.CAPABILITY);
    if (event == null
        || event.sequence() != run.sequence()
        || !event.occurredAt().equals(run.updatedAt())
        || previous != null && !RuntimeGuard.runTransitionIsValid(previous, run)) {
      throw invalidResponse();
    }
    return run;
  }

  private static void validateResumeId(String lastEventId) {
    if (lastEventId == null) return;
    try {
      ProtocolId.require(lastEventId);
    } catch (RuntimeException exception) {
      throw new RequestProblemException(
          ProblemResponseFactory.validation(
              List.of(
                  new ValidationError(
                      "/headers/Last-Event-ID",
                      "#/$defs/portableId/pattern",
                      "pattern",
                      "value does not satisfy schema",
                      JsonOwnership.object(Map.of())))));
    }
  }

  private static boolean canonicalJsonFits(JsonValue root, long limit) {
    long size = 0;
    JsonValue current = root;
    var iterators = new ArrayDeque<Iterator<JsonValue>>();
    while (current != null) {
      if (current instanceof JsonObject object) {
        size += 2L + Math.max(0, object.values().size() - 1L);
        for (String key : object.values().keySet()) {
          size += encodedStringUpperBound(key, limit - size) + 1;
          if (size > limit) return false;
        }
        Iterator<JsonValue> children = object.values().values().iterator();
        if (children.hasNext()) {
          iterators.push(children);
          current = children.next();
          continue;
        }
      } else if (current instanceof JsonList list) {
        size += 2L + Math.max(0, list.values().size() - 1L);
        if (size > limit) return false;
        Iterator<JsonValue> children = list.values().iterator();
        if (children.hasNext()) {
          iterators.push(children);
          current = children.next();
          continue;
        }
      } else {
        Object scalar = ((JsonValue.Scalar) current).value();
        size +=
            scalar instanceof String string
                ? encodedStringUpperBound(string, limit - size)
                : scalar == null ? 4 : scalar instanceof Boolean bool ? (bool ? 4 : 5) : 32;
        if (size > limit) return false;
      }

      current = null;
      while (!iterators.isEmpty()) {
        Iterator<JsonValue> siblings = iterators.peek();
        if (siblings.hasNext()) {
          current = siblings.next();
          break;
        }
        iterators.pop();
      }
    }
    return size <= limit;
  }

  private static long encodedStringUpperBound(String value, long limit) {
    long size = 2;
    for (int offset = 0; offset < value.length(); ) {
      int codePoint = value.codePointAt(offset);
      offset += Character.charCount(codePoint);
      if (codePoint <= 0x1f) size += 6;
      else if (codePoint == '"' || codePoint == '\\') size += 2;
      else if (codePoint <= 0x7f) size++;
      else if (codePoint <= 0x7ff) size += 2;
      else if (codePoint <= 0xffff) size += 3;
      else size += 4;
      if (size > limit) return size;
    }
    return size;
  }

  private static void close(Object candidate) {
    if (!(candidate instanceof AutoCloseable closeable)) return;
    try {
      closeable.close();
    } catch (Exception ignored) {
      // Provider cleanup must not replace the fixed public stream failure.
    }
  }

  private static SpringAdapterException invalidResponse() {
    return new SpringAdapterException(
        new dev.eightlines.gauntlet.core.model.Problem(
            "urn:gauntlet:problem:adapter-invalid-response",
            "Invalid adapter response",
            502,
            null,
            null,
            null,
            List.of(),
            null,
            JsonOwnership.object(Map.of())));
  }
}
