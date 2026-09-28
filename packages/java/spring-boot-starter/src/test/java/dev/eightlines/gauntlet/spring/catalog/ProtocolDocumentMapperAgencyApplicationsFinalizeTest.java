package dev.eightlines.gauntlet.spring.catalog;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/**
 * Reproduces the exact loading path {@code SpringAdapterCatalog.scanOperations} uses for a {@code
 * definitionResource}-backed {@code @GauntletOperation} (as the Spring example's {@code
 * FinalizeOperation} declares), bypassing the catalog's blanket {@code catch (RuntimeException)} so
 * a real failure surfaces with its actual message instead of being downgraded to an opaque {@code
 * invalid-operation-binding} diagnostic and a dropped operation.
 *
 * <p>The classpath resource here is a byte-for-byte copy of {@code
 * packages/java/spring-example/src/main/resources/gauntlet/agency-applications.finalize.json} (kept
 * in sync manually, matching the existing {@code whitespace-input.json} fixture pattern in this
 * test sourceset).
 */
class ProtocolDocumentMapperAgencyApplicationsFinalizeTest {
  @Test
  void theRealAgencyApplicationsFinalizeResourceIsAcceptedWithItsPlacement() {
    var loader = new ClasspathDocumentLoader();
    var mapper = new ProtocolDocumentMapper();
    JsonObject resource =
        loader.load(
            ProtocolDocumentMapperAgencyApplicationsFinalizeTest.class,
            "gauntlet/agency-applications.finalize.json");

    var definition = mapper.operation(resource);

    assertThat(definition.id()).isEqualTo("agency-applications.finalize");
    assertThat(definition.placements()).hasSize(1);
    assertThat(definition.placements().getFirst().kind()).isEqualTo("subject");
    assertThat(definition.placements().getFirst().subjectType()).isEqualTo("agency-application");
  }

  @Test
  void anEmptyBindingsObjectIsRejectedInsteadOfBeingSilentlyDropped() throws IOException {
    String text;
    try (InputStream input =
        ProtocolDocumentMapperAgencyApplicationsFinalizeTest.class
            .getClassLoader()
            .getResourceAsStream("gauntlet/agency-applications.finalize.json")) {
      text = new String(input.readAllBytes(), StandardCharsets.UTF_8);
    }
    String bound = "\"bindings\": {\"/applicationId\": \"applicationId\"}";
    assertThat(text).contains(bound);
    var resource =
        (JsonObject)
            JsonOwnership.parseRuntime(
                text.replace(bound, "\"bindings\": {}").getBytes(StandardCharsets.UTF_8));

    assertThatThrownBy(() -> new ProtocolDocumentMapper().operation(resource))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("placement bindings must be omitted when empty");
  }
}
