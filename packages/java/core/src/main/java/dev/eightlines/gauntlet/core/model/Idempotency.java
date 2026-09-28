package dev.eightlines.gauntlet.core.model;

public enum Idempotency {
  NONE("none"),
  OPTIONAL("optional"),
  REQUIRED("required");
  private final String wire;

  Idempotency(String wire) {
    this.wire = wire;
  }

  public String wireValue() {
    return wire;
  }

  public static Idempotency fromWireValue(String value) {
    for (Idempotency policy : values()) if (policy.wire.equals(value)) return policy;
    throw new IllegalArgumentException("unsupported idempotency policy");
  }
}
