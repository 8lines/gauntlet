package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.net.URI;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Objects;
import java.util.regex.Pattern;

final class ProtocolValidation {
  static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
  private static final Pattern RFC_3339 =
      Pattern.compile(
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
              + "(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$");
  private static final Pattern EXTENSION_KEY =
      Pattern.compile("^urn:[A-Za-z0-9][A-Za-z0-9:._/-]*$");

  private ProtocolValidation() {}

  static URI requireHttpUrl(String value, String name) {
    Objects.requireNonNull(value, name);
    URI uri;
    try {
      uri = URI.create(value);
    } catch (IllegalArgumentException exception) {
      throw new IllegalArgumentException(name + " must be an absolute HTTP(S) URL");
    }
    if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
        || !uri.isAbsolute()
        || uri.getRawAuthority() == null
        || uri.getHost() == null
        || uri.getHost().isBlank()) {
      throw new IllegalArgumentException(name + " must be an absolute HTTP(S) URL");
    }
    return uri;
  }

  static OffsetDateTime requireTimestamp(String value, String name) {
    Objects.requireNonNull(value, name);
    if (!RFC_3339.matcher(value).matches()) {
      throw new IllegalArgumentException(name + " must be an RFC 3339 timestamp");
    }
    try {
      return OffsetDateTime.parse(value);
    } catch (DateTimeParseException exception) {
      throw new IllegalArgumentException(name + " must be an RFC 3339 timestamp");
    }
  }

  static JsonObject requireExtensions(JsonObject extensions) {
    Objects.requireNonNull(extensions, "extensions");
    for (String key : extensions.values().keySet()) {
      if (!EXTENSION_KEY.matcher(key).matches()) {
        throw new IllegalArgumentException("extension keys must be namespaced URNs");
      }
    }
    return extensions;
  }
}
