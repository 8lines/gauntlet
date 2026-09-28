package dev.eightlines.gauntlet.core.model;

import java.util.regex.Pattern;

public record ProtocolId(String value) {
  private static final Pattern SAFE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");

  public ProtocolId {
    if (value == null || !SAFE.matcher(value).matches())
      throw new IllegalArgumentException("invalid protocol id");
  }

  public static ProtocolId of(String value) {
    return new ProtocolId(value);
  }

  public static boolean isValid(String value) {
    return value != null && SAFE.matcher(value).matches();
  }

  public static String require(String value) {
    if (!isValid(value)) throw new IllegalArgumentException("invalid protocol id");
    return value;
  }
}
