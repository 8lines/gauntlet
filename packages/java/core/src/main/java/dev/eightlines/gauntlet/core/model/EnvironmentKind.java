package dev.eightlines.gauntlet.core.model;

public enum EnvironmentKind {
  DEVELOPMENT("development"),
  TEST("test"),
  QA("qa"),
  STAGING("staging"),
  UAT("uat"),
  PREVIEW("preview"),
  SANDBOX("sandbox");

  private static final String INVALID = "Invalid non-production environment descriptor";

  private final String wireValue;

  EnvironmentKind(String wireValue) {
    this.wireValue = wireValue;
  }

  public String wireValue() {
    return wireValue;
  }

  public static EnvironmentKind fromWireValue(String value) {
    for (var kind : values()) {
      if (kind.wireValue.equals(value)) return kind;
    }
    throw new IllegalArgumentException(INVALID);
  }
}
