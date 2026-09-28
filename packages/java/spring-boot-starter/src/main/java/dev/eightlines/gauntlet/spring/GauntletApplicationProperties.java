package dev.eightlines.gauntlet.spring;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.ApplicationMetadata;
import java.util.Map;
import org.springframework.boot.context.properties.NestedConfigurationProperty;

public record GauntletApplicationProperties(
    String id,
    String label,
    @NestedConfigurationProperty GauntletEnvironmentProperties environment) {
  public ApplicationMetadata toMetadata() {
    if (environment == null) {
      throw new IllegalArgumentException("enabled adapter requires application environment");
    }
    return new ApplicationMetadata(
        id, label, environment.toDescriptor(), JsonOwnership.object(Map.of()));
  }
}
