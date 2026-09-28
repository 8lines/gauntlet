package dev.eightlines.gauntlet.core.model;

public enum OperationImpact {
  READ("read"),
  WRITE("write"),
  DESTRUCTIVE("destructive");
  private final String wireValue;

  OperationImpact(String wireValue) {
    this.wireValue = wireValue;
  }

  public String wireValue() {
    return wireValue;
  }

  public static OperationImpact fromWireValue(String value) {
    for (var candidate : values()) if (candidate.wireValue.equals(value)) return candidate;
    throw new IllegalArgumentException("unsupported operation impact");
  }
}
