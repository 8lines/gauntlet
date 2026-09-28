package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JcsSourceReceiptTest {
  private static final String UPSTREAM_PACKAGE = "package org.webpki.jcs;";
  private static final String RELOCATED_PACKAGE =
      "package dev.eightlines.gauntlet.core.json.internal.jcs;";
  private static final String COMMIT = "19d51d7fe467d4706a3ff08adf8a748f29fc21e0";
  private static final Map<String, String> SOURCE_RECEIPTS =
      Map.of(
          "DoubleCoreSerializer.java",
              "61246c838dbfdf372ca7955768695dffe3ffeabb09a8739dbb1bc2245a7561d7",
          "NumberToJSON.java", "b17555e45aa1c6fdf5924ef02df14b25d8fad1d9c7d81f1e33954e82a4f7a78a");

  @Test
  void vendoredSourcesReconstructThePinnedUpstreamBytesByPackageRelocationOnly() throws Exception {
    Path sourceDirectory = Path.of("src/main/java/dev/eightlines/gauntlet/core/json/internal/jcs");

    for (var receipt : SOURCE_RECEIPTS.entrySet()) {
      String relocated =
          Files.readString(sourceDirectory.resolve(receipt.getKey()), StandardCharsets.UTF_8);
      assertEquals(1, occurrences(relocated, RELOCATED_PACKAGE), receipt.getKey());
      assertEquals(0, occurrences(relocated, UPSTREAM_PACKAGE), receipt.getKey());
      assertTrue(relocated.contains("Copyright 2018 Ulf Adams."), receipt.getKey());
      assertTrue(
          relocated.contains("Modifications for ECMAScript / RFC 8785 by Anders Rundgren"),
          receipt.getKey());
      assertTrue(
          relocated.contains("Licensed under the Apache License, Version 2.0"), receipt.getKey());

      byte[] reconstructed =
          relocated.replace(RELOCATED_PACKAGE, UPSTREAM_PACKAGE).getBytes(StandardCharsets.UTF_8);
      assertEquals(receipt.getValue(), sha256(reconstructed), receipt.getKey());
    }
  }

  @Test
  void noticesAndBuildFilesPinTheSourcesWithoutAJcsDependency() throws Exception {
    String notices = Files.readString(Path.of("THIRD_PARTY_NOTICES.md"));
    assertTrue(notices.contains(COMMIT));
    assertTrue(notices.contains("Copyright 2018 Ulf Adams"));
    assertTrue(notices.contains("Anders Rundgren"));
    assertTrue(notices.contains("DoubleCoreSerializer.java"));
    assertTrue(notices.contains("NumberToJSON.java"));
    assertTrue(notices.contains(SOURCE_RECEIPTS.get("DoubleCoreSerializer.java")));
    assertTrue(notices.contains(SOURCE_RECEIPTS.get("NumberToJSON.java")));
    assertTrue(
        notices.contains(
            "https://raw.githubusercontent.com/cyberphone/json-canonicalization/" + COMMIT));

    Path upstreamLicense = Path.of("THIRD_PARTY_LICENSES", "json-canonicalization-LICENSE");
    assertEquals(
        "6821faaddedf2d78c95bb6d98b127e9e616097afd2f6bcc34389f000d13ab12d",
        sha256(Files.readAllBytes(upstreamLicense)));

    String buildFiles =
        Files.readString(Path.of("build.gradle.kts"))
            + Files.readString(Path.of("..", "build.gradle.kts"))
            + Files.readString(Path.of("..", "gradle", "verification-metadata.xml"));
    assertFalse(buildFiles.toLowerCase().contains("json-canonicalization"));
    assertFalse(buildFiles.toLowerCase().contains("erdtman"));
    assertFalse(buildFiles.toLowerCase().contains("titanium"));
  }

  private static int occurrences(String value, String needle) {
    int count = 0;
    int offset = 0;
    while ((offset = value.indexOf(needle, offset)) >= 0) {
      count++;
      offset += needle.length();
    }
    return count;
  }

  private static String sha256(byte[] value) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
  }
}
