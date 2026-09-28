package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.spring.capability.SpringCapabilityRegistry;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;

/** Enforces disabled/raw-path/method/capability precedence after the container accepts a target. */
public final class RawAdapterPrefixFilter extends OncePerRequestFilter {
  public static final String PREFIX = RawAdapterTargetPolicy.PREFIX;

  private final AdapterEnabledGate enabled;
  private final SpringCapabilityRegistry capabilities;
  private final ProblemResponseFactory problems;

  public RawAdapterPrefixFilter(
      AdapterEnabledGate enabled,
      SpringCapabilityRegistry capabilities,
      ProblemResponseFactory problems) {
    this.enabled = enabled;
    this.capabilities = capabilities;
    this.problems = problems;
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return !targetsAdapter(request);
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
    if (!enabled.isEnabled()) {
      problems.write(
          response, ProblemResponseFactory.problem("adapter-disabled", "Adapter disabled", 503));
      return;
    }

    String rawPath = request.getRequestURI();
    String rawTarget =
        request.getQueryString() == null ? rawPath : rawPath + "?" + request.getQueryString();
    Problem routeProblem = RawAdapterTargetPolicy.inspect(rawTarget, request.getMethod());
    if (routeProblem != null) {
      problems.write(response, routeProblem);
      return;
    }
    String capability = optionalCapability(rawPath);
    if (capability != null && !capabilities.supports(capability)) {
      problems.write(response, capabilities.unavailable(capability));
      return;
    }
    if (request.getContentLengthLong() > RequestEnvelopeValidator.MAX_JSON_BYTES) {
      problems.write(
          response, ProblemResponseFactory.problem("request-too-large", "Request too large", 413));
      return;
    }
    filterChain.doFilter(request, response);
    if (rawPath.endsWith("/events")) disableAsyncTimeout(request);
  }

  private static void disableAsyncTimeout(HttpServletRequest request) {
    try {
      request.getAsyncContext().setTimeout(0L);
    } catch (IllegalStateException ignored) {
      // A fast or empty stream may complete while control returns through this filter.
    }
  }

  private static boolean targetsAdapter(HttpServletRequest request) {
    String raw = request.getRequestURI();
    String normalized = request.getServletPath();
    return RawAdapterTargetPolicy.targets(raw) || RawAdapterTargetPolicy.targets(normalized);
  }

  private static String optionalCapability(String path) {
    String[] segments = path.substring(PREFIX.length() + 1).split("/", -1);
    if (segments.length == 1 && segments[0].equals("uploads")) {
      return SpringCapabilityRegistry.UPLOADS;
    }
    if (segments.length == 3 && segments[0].equals("runs") && segments[2].equals("cancel")) {
      return SpringCapabilityRegistry.CANCELLATION;
    }
    if (segments.length == 3 && segments[0].equals("runs") && segments[2].equals("events")) {
      return SpringCapabilityRegistry.EVENTS;
    }
    if (segments.length == 5 && segments[0].equals("runs") && segments[2].equals("artifacts")) {
      return SpringCapabilityRegistry.SESSION_LAUNCH;
    }
    return null;
  }
}
