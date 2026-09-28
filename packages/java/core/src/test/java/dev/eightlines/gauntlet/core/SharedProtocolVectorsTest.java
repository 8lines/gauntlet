package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

/** The mounted protocol resource is the authority; no vector is copied into this module. */
class SharedProtocolVectorsTest {
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  @SuppressWarnings("unchecked")
  void everyCheckedInJcsVectorMatchesBytesRevisionOrRejection() throws Exception {
    try (InputStream source =
        getClass().getClassLoader().getResourceAsStream("jcs-revision-vectors.json")) {
      assertNotNull(source, "mounted protocol fixture is required");
      Map<String, Object> document = mapper.readValue(source, Map.class);
      assertEquals("RFC8785+SHA-256", document.get("algorithm"));
      List<Map<String, Object>> vectors = (List<Map<String, Object>>) document.get("vectors");
      assertEquals(16, vectors.size());
      for (Map<String, Object> vector : vectors) {
        String input = (String) vector.get("inputJson");
        if (vector.containsKey("expectedError")) {
          assertThrows(
              IllegalArgumentException.class,
              () -> CanonicalJson.encode(mapper.readValue(input, Object.class)),
              (String) vector.get("name"));
        } else {
          Map<String, Object> value = mapper.readValue(input, Map.class);
          String field = (String) vector.get("revisionField");
          value.remove(field);
          assertEquals(
              vector.get("expectedCanonicalJson"),
              new String(CanonicalJson.encode(value), StandardCharsets.UTF_8),
              (String) vector.get("name"));
          assertEquals(
              vector.get("expectedRevision"),
              CanonicalJson.revision(mapper.readValue(input, Map.class), field),
              (String) vector.get("name"));
        }
      }
    }
  }
}
