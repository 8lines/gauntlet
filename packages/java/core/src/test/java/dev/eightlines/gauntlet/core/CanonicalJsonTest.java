package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CanonicalJsonTest {
  @Test
  void revisionIsStableAndDoesNotHashItsOwnRevisionField() {
    var first = CoreTestFixtures.fixtureDefinition("applications.finalize");
    var second = CoreTestFixtures.fixtureDefinition("applications.finalize");
    assertEquals(first.revision(), second.revision());
    assertTrue(first.revision().matches("sha256:[0-9a-f]{64}"));
    assertEquals(
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        CanonicalJson.revision(JsonOwnership.object(Map.of()), "revision"));
    assertThrows(
        IllegalArgumentException.class,
        () -> CanonicalJson.encode(JsonOwnership.object(Map.of("unsafe", 9_007_199_254_740_992L))));
  }

  @Test
  void canonicalizationMatchesTheRfc8785NumberAndStringVector() {
    var vector = new LinkedHashMap<String, Object>();
    vector.put("numbers", List.of(333333333.33333329d, 1e30d, 4.5d, 2e-3d, 1e-27d));
    vector.put("string", "€$\u000f\nA'B\"\\\\\"/");
    vector.put("literals", Arrays.asList(null, true, false));
    assertEquals(
        "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
        CanonicalJson.encodeString(vector));
  }

  @Test
  void runtimeAndRevisionOwnershipHaveDifferentNegativeZeroRules() {
    assertThrows(IllegalArgumentException.class, () -> JsonOwnership.ownRuntime(-0.0d));
    assertEquals("0", CanonicalJson.encodeString(JsonOwnership.ownRevision(-0.0d)));
    assertThrows(
        IllegalArgumentException.class, () -> JsonOwnership.ownRuntime(Float.valueOf(1.0f)));
    assertThrows(
        IllegalArgumentException.class,
        () -> JsonOwnership.ownRuntime(new BigDecimal("0.1000000000000000000000000001")));
  }

  @Test
  void ownershipRejectsCyclesAndLoneSurrogatesButPreservesAliasesAndProto() {
    var cyclic = new ArrayList<Object>();
    cyclic.add(cyclic);
    assertThrows(IllegalArgumentException.class, () -> JsonOwnership.ownRuntime(cyclic));
    assertThrows(
        IllegalArgumentException.class, () -> JsonOwnership.ownRuntime(Map.of("\ud800", "bad")));

    var shared = new LinkedHashMap<String, Object>();
    shared.put("value", "owned");
    var root = new LinkedHashMap<String, Object>();
    root.put("left", shared);
    root.put("right", shared);
    root.put("__proto__", Map.of("polluted", true));
    JsonObject owned = (JsonObject) JsonOwnership.ownRuntime(root);
    shared.put("value", "mutated");
    assertEquals(
        "{\"__proto__\":{\"polluted\":true},\"left\":{\"value\":\"owned\"},\"right\":{\"value\":\"owned\"}}",
        CanonicalJson.encodeString(owned));
  }

  @Test
  void ownershipAndSerializationAreIterativeAt4097Levels() {
    Object current = "leaf";
    for (int index = 0; index < 4_097; index++) current = List.of(current);
    var owned = JsonOwnership.ownRuntime(current);
    byte[] canonical =
        new dev.eightlines.gauntlet.core.json.Rfc8785Canonicalizer().canonicalize(owned);
    assertEquals((4_097 * 2) + 6, canonical.length);
    assertEquals('[', canonical[0]);
    assertEquals(']', canonical[canonical.length - 1]);
  }

  @Test
  void strictParserRejectsDuplicateNamesAndOwnsBinary64Numbers() {
    assertThrows(
        IllegalArgumentException.class,
        () -> JsonOwnership.parseRevision("{\"a\":1,\"a\":2}".getBytes(StandardCharsets.UTF_8)));
    JsonObject parsed =
        (JsonObject)
            JsonOwnership.parseRevision(
                "{\"n\":1e-7,\"zero\":-0}".getBytes(StandardCharsets.UTF_8));
    assertEquals("{\"n\":1e-7,\"zero\":0}", CanonicalJson.encodeString(parsed));
  }

  @Test
  void runtimeParserAndDirectScalarsCannotSmuggleNegativeZeroOrUnsafeIntegers() {
    for (String source : List.of("-0", "-0.0", "-0e2", "[-0]", "{\"n\":-0.000}")) {
      assertThrows(
          IllegalArgumentException.class,
          () -> JsonOwnership.parseRuntime(source.getBytes(StandardCharsets.UTF_8)),
          source);
    }
    assertEquals(
        "\"-0\"",
        CanonicalJson.encodeString(
            JsonOwnership.parseRuntime("\"-0\"".getBytes(StandardCharsets.UTF_8))));
    assertThrows(IllegalArgumentException.class, () -> new JsonValue.Scalar(-0.0d));
    assertThrows(
        IllegalArgumentException.class, () -> new JsonValue.Scalar(9_007_199_254_740_992L));
  }

  @Test
  void ownershipRejectsArbitraryIterableImplementations() {
    Iterable<String> hostile = () -> List.of("unexpected").iterator();
    assertThrows(IllegalArgumentException.class, () -> JsonOwnership.ownRuntime(hostile));
    assertThrows(
        IllegalArgumentException.class,
        () -> JsonOwnership.ownRuntime(java.util.Set.of("unordered")));
  }
}
