package dev.eightlines.gauntlet.consumer;

import dev.eightlines.gauntlet.core.model.ProtocolId;
import dev.eightlines.gauntlet.spring.GauntletAutoConfiguration;
import dev.eightlines.gauntlet.spring.GauntletProperties;
import java.time.ZoneOffset;
import java.util.List;

public final class PublishedConsumer {
  private PublishedConsumer() {}

  public static void main(String[] args) {
    GauntletProperties properties = new GauntletProperties(false, null, List.of());
    if (properties.enabled()
        || !properties.profiles().equals(List.of(GauntletProperties.CORE_PROFILE))) {
      throw new IllegalStateException("published starter properties contract is broken");
    }
    if (!ProtocolId.of("published-consumer").value().equals("published-consumer")) {
      throw new IllegalStateException("published Core model contract is broken");
    }
    GauntletAutoConfiguration autoConfiguration = new GauntletAutoConfiguration();
    if (!autoConfiguration.gauntletClock().getZone().equals(ZoneOffset.UTC)) {
      throw new IllegalStateException("published Spring auto-configuration contract is broken");
    }
    System.out.println("PUBLISHED_JAVA_CONSUMER_OK");
  }
}
