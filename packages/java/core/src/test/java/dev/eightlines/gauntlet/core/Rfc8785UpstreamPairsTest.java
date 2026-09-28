package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class Rfc8785UpstreamPairsTest {
  private static final List<String> NAMES =
      List.of("arrays", "french", "structures", "unicode", "values", "weird");
  private static final Map<String, List<String>> RECEIPTS =
      Map.of(
          "arrays",
              List.of(
                  "e503b6d71d1afa595b1c74b1016445c944cd89f90418066b23de1aeda7d17563",
                  "099601b171cafed97c333f8878d68e7f8c8f795412adb34b2fdcf0e7c7beac42"),
          "french",
              List.of(
                  "03676a951cd8753ac62589f72eb2105cc782c33425418cfe1d517c111f6e5d5a",
                  "d99d0ebdcb0033cb858cfa830ae46bc0fb3309413b271f1da828c89901a27ed5"),
          "structures",
              List.of(
                  "d66893805be1784116af50af3110d08766c70a6b4aad93374723f72346e7aaa6",
                  "605f65004ec2db7692522a0852c22f1c989e036d547e88963d1a3143cf3195d5"),
          "unicode",
              List.of(
                  "4621864e014d4a805a563f55b9ea20aba4a2d2dc09c7394f625496998c00702c",
                  "0d99aad92a125196ff887876643fd3206786a84ddce2cee52ba4ad256d2381d3"),
          "values",
              List.of(
                  "c4a041b503d6bc236036ef44db4dac499272f60fc22c40dc3b7a54870ba6f1c3",
                  "2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb"),
          "weird",
              List.of(
                  "a3a905266bd4a49a969274ea69baa14ee0c4af0ead926d6fa2b7612b4af75387",
                  "6af595a9aa80110b964b4de3f82a05fa6ae7423005019bacfa2620dddc4e94d1"));
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void pinnedUpstreamInputsAndOutputsCanonicalizeByteForByte() throws Exception {
    for (String name : NAMES) {
      byte[] input = bytes("jcs/input/" + name + ".json");
      byte[] expected = bytes("jcs/output/" + name + ".json");
      assertEquals(RECEIPTS.get(name).get(0), sha256(input), name + " input receipt");
      assertEquals(RECEIPTS.get(name).get(1), sha256(expected), name + " output receipt");
      assertEquals(
          new String(expected, StandardCharsets.UTF_8),
          new String(
              CanonicalJson.encode(mapper.readValue(input, Object.class)), StandardCharsets.UTF_8),
          name);
    }
  }

  private byte[] bytes(String name) throws Exception {
    try (InputStream stream = getClass().getClassLoader().getResourceAsStream(name)) {
      assertNotNull(stream, name);
      return stream.readAllBytes();
    }
  }

  private static String sha256(byte[] bytes) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }
}
