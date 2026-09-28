package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.net.URI;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Objects;

/** A credential-free, single-use browser session launch that has not expired. */
public final class SessionLaunchResponse {
  private final String url;
  private final String expiresAt;
  private final boolean singleUse;
  private final JsonObject extensions;

  public SessionLaunchResponse(
      String url, String expiresAt, boolean singleUse, JsonObject extensions) {
    this(url, expiresAt, singleUse, extensions, Clock.systemUTC());
  }

  public SessionLaunchResponse(
      String url, String expiresAt, boolean singleUse, JsonObject extensions, Clock clock) {
    URI uri = ProtocolValidation.requireHttpUrl(url, "session URL");
    if (uri.getRawUserInfo() != null) {
      throw new IllegalArgumentException("session URL must not contain credentials");
    }
    OffsetDateTime expiry = ProtocolValidation.requireTimestamp(expiresAt, "expiresAt");
    if (!expiry.toInstant().isAfter(Objects.requireNonNull(clock, "clock").instant())) {
      throw new IllegalArgumentException("session expiry must be in the future");
    }
    if (!singleUse) {
      throw new IllegalArgumentException("session launch must be single-use");
    }
    this.url = url;
    this.expiresAt = expiresAt;
    this.singleUse = true;
    this.extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public String url() {
    return url;
  }

  public String expiresAt() {
    return expiresAt;
  }

  public boolean singleUse() {
    return singleUse;
  }

  public JsonObject extensions() {
    return extensions;
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("url", url);
          values.put("expiresAt", expiresAt);
          values.put("singleUse", true);
          if (!extensions.values().isEmpty()) {
            values.put("extensions", extensions);
          }
        });
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof SessionLaunchResponse response
        && toProtocolMap().equals(response.toProtocolMap());
  }

  @Override
  public int hashCode() {
    return toProtocolMap().hashCode();
  }
}
