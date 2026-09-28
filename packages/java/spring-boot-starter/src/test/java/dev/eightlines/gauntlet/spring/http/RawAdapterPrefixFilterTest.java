package dev.eightlines.gauntlet.spring.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import dev.eightlines.gauntlet.spring.GauntletApplicationProperties;
import dev.eightlines.gauntlet.spring.GauntletEnvironmentProperties;
import dev.eightlines.gauntlet.spring.GauntletProperties;
import dev.eightlines.gauntlet.spring.capability.SpringCapabilityRegistry;
import jakarta.servlet.AsyncContext;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class RawAdapterPrefixFilterTest {
  @ParameterizedTest(name = "{0}")
  @MethodSource("invalidTargets")
  void ambiguousOrUnsafeAdapterTargetsFailBeforeMvc(
      String name, String method, String rawPath, String servletPath, String query)
      throws Exception {
    FilterResult result = invoke(true, method, rawPath, servletPath, query);

    assertThat(result.response().getStatus()).as(name).isEqualTo(400);
    assertThat(result.response().getContentAsString())
        .contains("urn:gauntlet:problem:invalid-path");
    assertThat(result.chainCalled()).isFalse();
  }

  @Test
  void disabledGateWinsEvenWhenOnlyDecodedRawPathRevealsTheAdapterPrefix() throws Exception {
    FilterResult result =
        invoke(
            false,
            "POST",
            "/_g%61untlet/v1/operations/unsafe%21id/runs",
            "/_g%61untlet/v1/operations/unsafe%21id/runs",
            "forbidden=1");

    assertThat(result.response().getStatus()).isEqualTo(503);
    assertThat(result.response().getContentAsString())
        .contains("urn:gauntlet:problem:adapter-disabled");
    assertThat(result.chainCalled()).isFalse();
  }

  @Test
  void wrongMethodSafeUnknownRouteAndHostRouteRemainDistinct() throws Exception {
    assertThat(
            invoke(true, "POST", path("manifest"), path("manifest"), null).response().getStatus())
        .isEqualTo(405);
    assertThat(invoke(true, "GET", path("unknown"), path("unknown"), null).response().getStatus())
        .isEqualTo(404);

    FilterResult host = invoke(true, "GET", "/host-route", "/host-route", null);
    assertThat(host.chainCalled()).isTrue();
    assertThat(host.response().getStatus()).isEqualTo(200);
  }

  @Test
  void eventStreamsDisableTheServletAsyncTimeoutAfterMvcStartsAsync() throws Exception {
    var properties =
        new GauntletProperties(
            true,
            new GauntletApplicationProperties(
                "fixture", "Fixture", new GauntletEnvironmentProperties("fixture-test", "test")),
            List.of());
    var capabilities =
        new SpringCapabilityRegistry(
            List.of(), List.of((runId, lastEventId) -> List.of()), List.of(), List.of(), List.of());
    var filter =
        new RawAdapterPrefixFilter(
            new AdapterEnabledGate(properties), capabilities, new ProblemResponseFactory());
    var request = new MockHttpServletRequest("GET", path("runs/run-1/events"));
    request.setRequestURI(path("runs/run-1/events"));
    request.setServletPath(path("runs/run-1/events"));
    request.setAsyncSupported(true);

    filter.doFilter(
        request,
        new MockHttpServletResponse(),
        (ignoredRequest, ignoredResponse) -> request.startAsync());

    assertThat(request.getAsyncContext().getTimeout()).isZero();
  }

  @Test
  void completedFastEventStreamCannotRaceAsyncTimeoutConfiguration() {
    var properties =
        new GauntletProperties(
            true,
            new GauntletApplicationProperties(
                "fixture", "Fixture", new GauntletEnvironmentProperties("fixture-test", "test")),
            List.of());
    var capabilities =
        new SpringCapabilityRegistry(
            List.of(), List.of((runId, lastEventId) -> List.of()), List.of(), List.of(), List.of());
    var filter =
        new RawAdapterPrefixFilter(
            new AdapterEnabledGate(properties), capabilities, new ProblemResponseFactory());
    var request = new CompletedAsyncRequest("GET", path("runs/run-1/events"));
    var response = new MockHttpServletResponse();
    var chainCalled = new AtomicBoolean();

    assertThatCode(
            () ->
                filter.doFilter(
                    request,
                    response,
                    (ignoredRequest, ignoredResponse) -> {
                      chainCalled.set(true);
                      response.setStatus(200);
                    }))
        .doesNotThrowAnyException();

    assertThat(chainCalled).isTrue();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(request.contextLookupAttempted).isTrue();
  }

  static Stream<Arguments> invalidTargets() {
    String tooLong = "a".repeat(129);
    return Stream.of(
        arguments("query", "GET", path("manifest"), path("manifest"), "x=1"),
        arguments(
            "encoded prefix", "GET", "/_g%61untlet/v1/manifest", "/_g%61untlet/v1/manifest", null),
        arguments(
            "absolute form",
            "GET",
            "http://example.test/_gauntlet/v1/manifest",
            path("manifest"),
            null),
        arguments(
            "percent", "GET", path("operations/unsafe%2Fid"), path("operations/unsafe/id"), null),
        arguments("space", "GET", path("operations/unsafe id"), path("operations/unsafe id"), null),
        arguments("tab", "GET", path("operations/unsafe\tid"), path("operations/unsafe\tid"), null),
        arguments(
            "backslash", "GET", path("operations/unsafe\\id"), path("operations/unsafe\\id"), null),
        arguments("dot", "GET", path("operations/./runs"), path("operations/./runs"), null),
        arguments("parent", "GET", path("operations/../runs"), path("operations/../runs"), null),
        arguments("trailing slash", "GET", path("manifest/"), path("manifest/"), null),
        arguments("empty segment", "GET", path("/manifest"), path("/manifest"), null),
        arguments(
            "operation definition ID",
            "GET",
            path("operations/unsafe!id"),
            path("operations/unsafe!id"),
            null),
        arguments(
            "operation create ID",
            "POST",
            path("operations/unsafe!id/runs"),
            path("operations/unsafe!id/runs"),
            null),
        arguments("run ID", "GET", path("runs/unsafe!id"), path("runs/unsafe!id"), null),
        arguments(
            "data-source query ID",
            "POST",
            path("data-sources/unsafe!id/query"),
            path("data-sources/unsafe!id/query"),
            null),
        arguments(
            "data-source resolve ID",
            "POST",
            path("data-sources/unsafe!id/resolve"),
            path("data-sources/unsafe!id/resolve"),
            null),
        arguments(
            "cancel run ID",
            "POST",
            path("runs/unsafe!id/cancel"),
            path("runs/unsafe!id/cancel"),
            null),
        arguments(
            "events run ID",
            "GET",
            path("runs/unsafe!id/events"),
            path("runs/unsafe!id/events"),
            null),
        arguments(
            "launch run ID",
            "POST",
            path("runs/unsafe!id/artifacts/artifact-1/launch"),
            path("runs/unsafe!id/artifacts/artifact-1/launch"),
            null),
        arguments(
            "launch artifact ID",
            "POST",
            path("runs/run-1/artifacts/unsafe!id/launch"),
            path("runs/run-1/artifacts/unsafe!id/launch"),
            null),
        arguments(
            "oversized ID",
            "GET",
            path("operations/" + tooLong),
            path("operations/" + tooLong),
            null));
  }

  private static Arguments arguments(
      String name, String method, String rawPath, String servletPath, String query) {
    return Arguments.of(name, method, rawPath, servletPath, query);
  }

  private static String path(String relative) {
    return RawAdapterPrefixFilter.PREFIX + "/" + relative;
  }

  private static FilterResult invoke(
      boolean enabled, String method, String rawPath, String servletPath, String query)
      throws Exception {
    var properties =
        new GauntletProperties(
            enabled,
            enabled
                ? new GauntletApplicationProperties(
                    "fixture", "Fixture", new GauntletEnvironmentProperties("fixture-test", "test"))
                : null,
            List.of());
    var capabilities =
        new SpringCapabilityRegistry(List.of(), List.of(), List.of(), List.of(), List.of());
    var filter =
        new RawAdapterPrefixFilter(
            new AdapterEnabledGate(properties), capabilities, new ProblemResponseFactory());
    var request = new MockHttpServletRequest(method, rawPath);
    request.setRequestURI(rawPath);
    request.setServletPath(servletPath);
    request.setQueryString(query);
    var response = new MockHttpServletResponse();
    var called = new AtomicBoolean();

    filter.doFilter(
        request,
        response,
        (ignoredRequest, ignoredResponse) -> {
          called.set(true);
          ((MockHttpServletResponse) ignoredResponse).setStatus(200);
        });
    return new FilterResult(response, called.get());
  }

  private record FilterResult(MockHttpServletResponse response, boolean chainCalled) {}

  private static final class CompletedAsyncRequest extends MockHttpServletRequest {
    private boolean contextLookupAttempted;

    private CompletedAsyncRequest(String method, String uri) {
      super(method, uri);
      setRequestURI(uri);
      setServletPath(uri);
    }

    @Override
    public boolean isAsyncStarted() {
      return true;
    }

    @Override
    public AsyncContext getAsyncContext() {
      contextLookupAttempted = true;
      throw new IllegalStateException("async request completed after the started probe");
    }
  }
}
