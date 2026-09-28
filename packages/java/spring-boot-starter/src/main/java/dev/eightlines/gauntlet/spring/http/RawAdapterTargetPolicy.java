package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.model.Problem;
import java.util.Locale;
import java.util.Set;

/** Classifies original request targets that reached the servlet boundary. */
final class RawAdapterTargetPolicy {
  static final String PREFIX = "/_gauntlet/v1";
  private static final Set<String> KNOWN_ROOTS =
      Set.of("health", "manifest", "uploads", "operations", "runs", "data-sources");

  private RawAdapterTargetPolicy() {}

  static boolean targets(String target) {
    String path = decodedForRouting(pathFromTarget(target));
    return isAdapterPath(path);
  }

  static Problem inspect(String target, String method) {
    if (target == null || !targets(target)) return null;
    if (!target.startsWith("/")) return invalidPath();
    String path = target.split("[?#]", 2)[0];
    if (!isAdapterPath(path)
        || target.contains("?")
        || target.contains("#")
        || target.contains("%")
        || target.contains("\\")
        || target.contains("//")
        || target.endsWith("/")
        || target.chars().anyMatch(Character::isWhitespace)
        || target.contains("/./")
        || target.contains("/../")
        || target.endsWith("/.")
        || target.endsWith("/..")) {
      return invalidPath();
    }
    if (target.equals(PREFIX)) return routeNotFound();

    String[] segments = target.substring(PREFIX.length() + 1).split("/", -1);
    String expected = expectedMethod(segments);
    if (expected == null) {
      return KNOWN_ROOTS.contains(segments[0]) ? invalidPath() : routeNotFound();
    }
    return expected.equals(method.toUpperCase(Locale.ROOT))
        ? null
        : ProblemResponseFactory.problem("method-not-allowed", "Method not allowed", 405);
  }

  private static String expectedMethod(String[] segments) {
    if (segments.length == 1 && (segments[0].equals("health") || segments[0].equals("manifest"))) {
      return "GET";
    }
    if (segments.length == 1 && segments[0].equals("uploads")) return "POST";
    if (segments.length == 2 && segments[0].equals("operations") && safeId(segments[1])) {
      return "GET";
    }
    if (segments.length == 2 && segments[0].equals("runs") && safeId(segments[1])) {
      return "GET";
    }
    if (segments.length == 3
        && segments[0].equals("operations")
        && safeId(segments[1])
        && segments[2].equals("runs")) return "POST";
    if (segments.length == 3
        && segments[0].equals("data-sources")
        && safeId(segments[1])
        && (segments[2].equals("query") || segments[2].equals("resolve"))) return "POST";
    if (segments.length == 3
        && segments[0].equals("runs")
        && safeId(segments[1])
        && segments[2].equals("cancel")) return "POST";
    if (segments.length == 3
        && segments[0].equals("runs")
        && safeId(segments[1])
        && segments[2].equals("events")) return "GET";
    if (segments.length == 5
        && segments[0].equals("runs")
        && safeId(segments[1])
        && segments[2].equals("artifacts")
        && safeId(segments[3])
        && segments[4].equals("launch")) return "POST";
    return null;
  }

  private static boolean safeId(String value) {
    return value.matches("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
  }

  private static boolean isAdapterPath(String path) {
    return path != null && (path.equals(PREFIX) || path.startsWith(PREFIX + "/"));
  }

  private static String pathFromTarget(String target) {
    if (target == null) return null;
    if (target.startsWith("/")) return target.split("[?#]", 2)[0];
    int scheme = target.indexOf("://");
    if (scheme < 1) return target.split("[?#]", 2)[0];
    int slash = target.indexOf('/', scheme + 3);
    return slash < 0 ? "/" : target.substring(slash).split("[?#]", 2)[0];
  }

  private static String decodedForRouting(String value) {
    if (value == null || !value.contains("%")) return value;
    var decoded = new StringBuilder(value.length());
    for (int index = 0; index < value.length(); index++) {
      char current = value.charAt(index);
      if (current == '%' && index + 2 < value.length()) {
        int high = Character.digit(value.charAt(index + 1), 16);
        int low = Character.digit(value.charAt(index + 2), 16);
        if (high >= 0 && low >= 0) {
          decoded.append((char) (high * 16 + low));
          index += 2;
          continue;
        }
      }
      decoded.append(current);
    }
    return decoded.toString();
  }

  private static Problem invalidPath() {
    return ProblemResponseFactory.problem("invalid-path", "Invalid path", 400);
  }

  private static Problem routeNotFound() {
    return ProblemResponseFactory.problem("route-not-found", "Route not found", 404);
  }
}
