package dev.eightlines.gauntlet.core.model;

public enum RunState {
  QUEUED("queued", false),
  RUNNING("running", false),
  SUCCEEDED("succeeded", true),
  FAILED("failed", true),
  PARTIAL("partial", true),
  CANCELLED("cancelled", true),
  TIMED_OUT("timed_out", true),
  EXPIRED("expired", true);

  private final String wireValue;
  private final boolean terminal;

  RunState(String wireValue, boolean terminal) {
    this.wireValue = wireValue;
    this.terminal = terminal;
  }

  public String wireValue() {
    return wireValue;
  }

  public boolean terminal() {
    return terminal;
  }

  public static RunState fromWireValue(String value) {
    for (var state : values()) if (state.wireValue.equals(value)) return state;
    throw new IllegalArgumentException("unsupported run state");
  }
}
