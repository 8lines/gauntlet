package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.OperationOutput;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunEvent;
import dev.eightlines.gauntlet.core.model.RunState;
import dev.eightlines.gauntlet.spring.capability.RunEventsEndpoint;
import dev.eightlines.gauntlet.spring.capability.SpringCapabilityRegistry;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterException;
import dev.eightlines.gauntlet.spring.http.CapabilityController;
import dev.eightlines.gauntlet.spring.http.ProblemResponseFactory;
import dev.eightlines.gauntlet.spring.http.RequestProblemException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

class CapabilitySseStreamingTest {
  private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");

  @Test
  void responseConstructionIsLazyAndDisconnectClosesTheProviderIterator() throws Exception {
    Run queued = Run.queued("run-1", definition(), NOW);
    var supplied =
        new CloseableEvents(
            List.of(
                event("event-1", queued), event("event-2", queued.running(NOW.plusSeconds(1)))));
    var providerCalls = new AtomicInteger();
    var controller =
        controller(
            (runId, lastEventId) -> {
              providerCalls.incrementAndGet();
              return supplied;
            });

    var response = controller.events("run-1", null);

    assertThat(providerCalls).hasValue(0);
    assertThat(supplied.pulls()).isZero();
    assertThat(response.getBody()).isInstanceOf(StreamingResponseBody.class);
    var body = streamBody(response);
    assertThatThrownBy(() -> body.writeTo(new DisconnectingOutputStream()))
        .isInstanceOf(IOException.class)
        .hasMessageNotContaining("provider-secret");
    assertThat(providerCalls).hasValue(1);
    assertThat(supplied.pulls()).isEqualTo(1);
    assertThat(supplied.closed()).isTrue();
  }

  @Test
  void invalidResumeIdFailsBeforeProviderDispatch() {
    var calls = new AtomicInteger();
    var controller =
        controller(
            (runId, lastEventId) -> {
              calls.incrementAndGet();
              return List.of();
            });

    assertThatThrownBy(() -> controller.events("run-1", "unsafe\nevent"))
        .isInstanceOf(RequestProblemException.class);
    assertThat(calls).hasValue(0);
  }

  @Test
  void regressingRunTransitionAbortsBeforeTheInvalidEventAndClosesProvider() throws Exception {
    Run running = Run.queued("run-1", definition(), NOW).running(NOW.plusSeconds(1));
    Run regressed =
        new Run(
            running.id(),
            running.operationId(),
            running.operationRevision(),
            2,
            RunState.QUEUED,
            running.createdAt(),
            NOW.plusSeconds(2).toString(),
            running.startedAt(),
            null,
            null,
            null,
            null,
            List.of(),
            List.of(),
            null,
            empty());
    var supplied =
        new CloseableEvents(List.of(event("event-1", running), event("event-2", regressed)));
    var body = streamBody(controller((runId, lastEventId) -> supplied).events("run-1", null));
    var output = new ByteArrayOutputStream();

    assertThatThrownBy(() -> body.writeTo(output)).isInstanceOf(SpringAdapterException.class);
    assertThat(output.toString(java.nio.charset.StandardCharsets.UTF_8))
        .contains("id: event-1")
        .doesNotContain("id: event-2");
    assertThat(supplied.closed()).isTrue();
  }

  @Test
  void anOversizedSingleEventIsRejectedBeforeWritingIt() throws Exception {
    Run run = Run.queued("run-1", definition(), NOW);
    var huge =
        new RunEvent(
            "event-1",
            run.sequence(),
            run.updatedAt(),
            "run.updated",
            run,
            JsonOwnership.object(Map.of("urn:test:blob", "x".repeat(4 * 1024 * 1024))));
    var supplied = new CloseableEvents(List.of(huge));
    var body = streamBody(controller((runId, lastEventId) -> supplied).events("run-1", null));
    var output = new ByteArrayOutputStream();

    assertThatThrownBy(() -> body.writeTo(output)).isInstanceOf(SpringAdapterException.class);
    assertThat(output.size()).isZero();
    assertThat(supplied.closed()).isTrue();
  }

  @Test
  void streamSerializesTheValidatedRunSnapshotInsteadOfTheProviderProblem() throws Exception {
    Run failed =
        Run.queued("run-1", definition(), NOW)
            .running(NOW.plusSeconds(1))
            .failed(
                new Problem("urn:gauntlet:problem:handler-failed", "provider-secret-sentinel", 500),
                NOW.plusSeconds(2));
    Problem safeProblem =
        new Problem("urn:gauntlet:problem:handler-failed", "Operation failed", 500);
    Run safe = copyWithProblem(failed, safeProblem);
    var capabilities =
        new SpringCapabilityRegistry(
            List.of(),
            List.of((RunEventsEndpoint) (runId, lastEventId) -> List.of(event("event-1", failed))),
            List.of(),
            List.of(),
            List.of());
    var controller =
        new CapabilityController(
            capabilities,
            new ProblemResponseFactory(),
            (run, expectedRunId, expectedOperationId, origin) -> safe,
            Clock.fixed(NOW, ZoneOffset.UTC));
    var output = new ByteArrayOutputStream();

    streamBody(controller.events("run-1", null)).writeTo(output);

    assertThat(output.toString(java.nio.charset.StandardCharsets.UTF_8))
        .contains("Operation failed")
        .doesNotContain("provider-secret-sentinel");
  }

  private static CapabilityController controller(RunEventsEndpoint events) {
    var capabilities =
        new SpringCapabilityRegistry(List.of(), List.of(events), List.of(), List.of(), List.of());
    return new CapabilityController(
        capabilities,
        new ProblemResponseFactory(),
        (run, expectedRunId, expectedOperationId, origin) -> run,
        Clock.fixed(NOW, ZoneOffset.UTC));
  }

  private static RunEvent event(String id, Run run) {
    return new RunEvent(
        id, run.sequence(), run.updatedAt(), "run.updated", run, JsonOwnership.object(Map.of()));
  }

  private static Run copyWithProblem(Run run, Problem problem) {
    return new Run(
        run.id(),
        run.operationId(),
        run.operationRevision(),
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
        problem,
        run.extensions());
  }

  private static StreamingResponseBody streamBody(
      org.springframework.http.ResponseEntity<?> response) {
    return (StreamingResponseBody) response.getBody();
  }

  private static OperationDefinition definition() {
    var schema =
        JsonOwnership.object(
            Map.of("$schema", "https://json-schema.org/draft/2020-12/schema", "type", "object"));
    return new OperationDefinition(
        "applications.finalize",
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

  private static final class CloseableEvents implements Iterable<RunEvent>, AutoCloseable {
    private final List<RunEvent> events;
    private final AtomicInteger pulls = new AtomicInteger();
    private boolean closed;

    private CloseableEvents(List<RunEvent> events) {
      this.events = List.copyOf(events);
    }

    @Override
    public Iterator<RunEvent> iterator() {
      Iterator<RunEvent> delegate = events.iterator();
      return new Iterator<>() {
        @Override
        public boolean hasNext() {
          return delegate.hasNext();
        }

        @Override
        public RunEvent next() {
          pulls.incrementAndGet();
          return delegate.next();
        }
      };
    }

    @Override
    public void close() {
      closed = true;
    }

    int pulls() {
      return pulls.get();
    }

    boolean closed() {
      return closed;
    }
  }

  private static final class DisconnectingOutputStream extends OutputStream {
    @Override
    public void write(int value) throws IOException {
      throw new IOException("client disconnected");
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      throw new IOException("client disconnected");
    }
  }
}
