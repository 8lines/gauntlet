package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class ConfigurationMetadataTest {
  @Test
  void generatedMetadataDescribesEveryRequiredEnabledPropertyAndTheSecretContract()
      throws Exception {
    try (var input =
        GauntletProperties.class
            .getClassLoader()
            .getResourceAsStream("META-INF/spring-configuration-metadata.json")) {
      assertThat(input).isNotNull();
      String metadata = new String(input.readAllBytes(), StandardCharsets.UTF_8);

      assertThat(metadata)
          .contains("gauntlet.enabled")
          .contains("gauntlet.application.id")
          .contains("gauntlet.application.label")
          .contains("gauntlet.application.environment.name")
          .contains("gauntlet.application.environment.kind")
          .contains("development, test, qa, staging, uat, preview, or sandbox")
          .contains("gauntlet.profiles")
          .contains("gauntlet.idempotency-secret")
          .contains("at least 32 UTF-8 bytes");
    }
  }
}
