package dev.eightlines.gauntlet.spring.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import org.junit.jupiter.api.Test;

/**
 * Pins the Spring example's {@code agency-applications.fail} resource to the canonical wire shape.
 *
 * <p>The classpath resource here is a byte-for-byte copy of {@code
 * packages/java/spring-example/src/main/resources/gauntlet/agency-applications.fail.json} (kept in
 * sync manually, matching {@link ProtocolDocumentMapperAgencyApplicationsFinalizeTest}). Its pinned
 * {@code revision} must equal the revision of the file content exactly as written (the TS {@code
 * computeRevision} contract), so the resource may not carry non-canonical members such as an empty
 * {@code requirements.capabilities} list.
 */
class ProtocolDocumentMapperAgencyApplicationsFailTest {
  @Test
  void theRealAgencyApplicationsFailResourceIsCanonicalAndAccepted() {
    JsonObject resource =
        new ClasspathDocumentLoader()
            .load(
                ProtocolDocumentMapperAgencyApplicationsFailTest.class,
                "gauntlet/agency-applications.fail.json");
    String pinned = (String) resource.get("revision").unwrap();

    assertThat(CanonicalJson.revision(resource, "revision")).isEqualTo(pinned);
    var definition = new ProtocolDocumentMapper().operation(resource);
    assertThat(definition.id()).isEqualTo("agency-applications.fail");
    assertThat(definition.revision()).isEqualTo(pinned);
  }
}
