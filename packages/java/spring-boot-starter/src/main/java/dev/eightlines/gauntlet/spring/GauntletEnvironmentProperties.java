package dev.eightlines.gauntlet.spring;

import dev.eightlines.gauntlet.core.model.EnvironmentDescriptor;
import dev.eightlines.gauntlet.core.model.EnvironmentKind;

public record GauntletEnvironmentProperties(String name, String kind) {
  public EnvironmentDescriptor toDescriptor() {
    return new EnvironmentDescriptor(name, EnvironmentKind.fromWireValue(kind));
  }
}
