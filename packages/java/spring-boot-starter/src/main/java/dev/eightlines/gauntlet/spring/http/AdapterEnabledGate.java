package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.spring.GauntletProperties;
import java.util.Objects;

public final class AdapterEnabledGate {
  private final GauntletProperties properties;

  public AdapterEnabledGate(GauntletProperties properties) {
    this.properties = Objects.requireNonNull(properties, "properties");
  }

  public boolean isEnabled() {
    return properties.enabled();
  }
}
