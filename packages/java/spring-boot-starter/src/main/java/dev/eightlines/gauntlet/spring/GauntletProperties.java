package dev.eightlines.gauntlet.spring;

import dev.eightlines.gauntlet.core.model.ProtocolRequirements;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.NestedConfigurationProperty;

@ConfigurationProperties("gauntlet")
public record GauntletProperties(
    boolean enabled,
    @NestedConfigurationProperty GauntletApplicationProperties application,
    List<String> profiles) {
  public static final String CORE_PROFILE = "tc-schema-core@1";

  public GauntletProperties {
    var configured = profiles == null ? List.<String>of() : List.copyOf(profiles);
    var ordered = new LinkedHashSet<String>();
    ordered.add(CORE_PROFILE);
    ordered.addAll(configured);
    var normalized = new ArrayList<>(ordered);
    normalized.sort(String::compareTo);
    profiles = new ProtocolRequirements(normalized, List.of()).profiles();
    if (enabled) {
      if (application == null) {
        throw new IllegalArgumentException("enabled adapter requires application metadata");
      }
      application.toMetadata();
    }
  }
}
