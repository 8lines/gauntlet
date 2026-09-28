package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import dev.eightlines.gauntlet.core.json.internal.jcs.NumberToJSON;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

/** Offline, fail-closed streaming gate for the separately acquired 100M-row corpus. */
class Rfc8785NumberCorpusTest {
  private static final String SOURCE_COMMIT = "19d51d7fe467d4706a3ff08adf8a748f29fc21e0";
  private static final String SOURCE_URL =
      "https://github.com/cyberphone/json-canonicalization/releases/download/"
          + "es6testfile/es6testfile100m.txt.gz";
  private static final long COMPRESSED_SIZE = 2_081_240_993L;
  private static final String COMPRESSED_SHA256 =
      "545455ec9e74b68042c22a2607fb9d4a5f5fdb3c79f883ce864c75189a70705f";
  private static final long UNCOMPRESSED_SIZE = 4_036_326_174L;
  private static final String UNCOMPRESSED_SHA256 =
      "0f7dda6b0837dde083c5d6b896f7d62340c8a2415b0c7121d83145e08a755272";
  private static final long ROWS = 100_000_000L;

  @Test
  void everyPinnedCorpusRowMatchesTheUnchangedNumberSerializer() throws Exception {
    assertMetadataReceipt();
    Path corpus = checkedCorpusPath();

    MessageDigest compressedHash = MessageDigest.getInstance("SHA-256");
    MessageDigest uncompressedHash = MessageDigest.getInstance("SHA-256");
    long uncompressedBytes = 0;
    long rows = 0;
    byte[] readBuffer = new byte[1024 * 1024];
    byte[] lineBuffer = new byte[128];
    int lineLength = 0;

    try (CountingInputStream compressedCounter =
            new CountingInputStream(Files.newInputStream(corpus));
        DigestInputStream compressed = new DigestInputStream(compressedCounter, compressedHash);
        GZIPInputStream gzip = new GZIPInputStream(compressed, 1024 * 1024);
        DigestInputStream uncompressed = new DigestInputStream(gzip, uncompressedHash)) {
      int length;
      while ((length = uncompressed.read(readBuffer)) != -1) {
        uncompressedBytes += length;
        if (uncompressedBytes > UNCOMPRESSED_SIZE) {
          fail("corpus expands beyond the pinned byte count");
        }
        for (int index = 0; index < length; index++) {
          int value = readBuffer[index] & 0xff;
          if (value == '\n') {
            verifyRow(lineBuffer, lineLength, rows + 1);
            rows++;
            if (rows > ROWS) {
              fail("corpus contains more than the pinned row count");
            }
            lineLength = 0;
          } else {
            if (value == '\r' || value > 0x7f || lineLength == lineBuffer.length) {
              fail("corpus contains a malformed row at " + (rows + 1));
            }
            lineBuffer[lineLength++] = (byte) value;
          }
        }
      }
      assertEquals(0, lineLength, "corpus must end at a row boundary");
      assertEquals(COMPRESSED_SIZE, compressedCounter.count(), "streamed compressed byte count");
    }

    assertEquals(UNCOMPRESSED_SIZE, uncompressedBytes, "uncompressed size receipt");
    assertEquals(ROWS, rows, "corpus row receipt");
    assertEquals(
        COMPRESSED_SHA256,
        HexFormat.of().formatHex(compressedHash.digest()),
        "compressed SHA-256 receipt");
    assertEquals(
        UNCOMPRESSED_SHA256,
        HexFormat.of().formatHex(uncompressedHash.digest()),
        "uncompressed SHA-256 receipt");
  }

  private static Path checkedCorpusPath() throws IOException {
    String configured = System.getProperty("jcsCorpus");
    assertNotNull(configured, "-PjcsCorpus must provide the local read-only gzip");
    Path corpus = Path.of(configured);
    assertTrue(corpus.isAbsolute(), "corpus path must be absolute");
    assertTrue(
        corpus.getFileName().toString().endsWith(".gz"), "corpus path must name a gzip file");
    assertFalse(Files.isSymbolicLink(corpus), "corpus must not be a symlink");
    assertTrue(
        Files.isRegularFile(corpus, LinkOption.NOFOLLOW_LINKS), "corpus must be a regular file");
    assertTrue(Files.isReadable(corpus), "corpus must be readable");
    assertEquals(COMPRESSED_SIZE, Files.size(corpus), "compressed size receipt");
    try (InputStream source = Files.newInputStream(corpus)) {
      assertEquals(0x1f, source.read(), "gzip magic byte 1");
      assertEquals(0x8b, source.read(), "gzip magic byte 2");
    }
    return corpus;
  }

  @SuppressWarnings("unchecked")
  private static void assertMetadataReceipt() throws IOException {
    try (InputStream source =
        Rfc8785NumberCorpusTest.class
            .getClassLoader()
            .getResourceAsStream("jcs/corpus-metadata.json")) {
      assertNotNull(source, "corpus metadata resource");
      Map<String, Object> metadata = new ObjectMapper().readValue(source, Map.class);
      assertEquals(SOURCE_COMMIT, metadata.get("sourceCommit"));
      assertEquals(SOURCE_URL, metadata.get("url"));
      assertEquals(COMPRESSED_SIZE, ((Number) metadata.get("compressedSize")).longValue());
      assertEquals(COMPRESSED_SHA256, metadata.get("compressedSha256"));
      assertEquals(UNCOMPRESSED_SIZE, ((Number) metadata.get("uncompressedSize")).longValue());
      assertEquals(UNCOMPRESSED_SHA256, metadata.get("uncompressedSha256"));
      assertEquals(ROWS, ((Number) metadata.get("rows")).longValue());
      assertEquals(7, metadata.size(), "metadata has no unreviewed fields");
    }
  }

  private static void verifyRow(byte[] line, int length, long row) throws IOException {
    if (length < 3) {
      fail("corpus row is too short at " + row);
    }
    int comma = -1;
    for (int index = 0; index < length; index++) {
      if (line[index] == ',') {
        if (comma != -1) {
          fail("corpus row has multiple delimiters at " + row);
        }
        comma = index;
      }
    }
    if (comma < 1 || comma > 16 || comma == length - 1) {
      fail("corpus row has an invalid shape at " + row);
    }
    long bits = 0;
    for (int index = 0; index < comma; index++) {
      int character = line[index] & 0xff;
      int digit;
      if (character >= '0' && character <= '9') {
        digit = character - '0';
      } else if (character >= 'a' && character <= 'f') {
        digit = character - 'a' + 10;
      } else if (character >= 'A' && character <= 'F') {
        digit = character - 'A' + 10;
      } else {
        fail("corpus row has invalid IEEE-754 bits at " + row);
        return;
      }
      bits = (bits << 4) | digit;
    }
    String expected =
        new String(line, comma + 1, length - comma - 1, java.nio.charset.StandardCharsets.US_ASCII);
    double value = Double.longBitsToDouble(bits);
    try {
      String actual = NumberToJSON.serializeNumber(value);
      if ("null".equals(expected)
          || !expected.equals(actual)
          || value != Double.parseDouble(expected)) {
        fail("number serializer mismatch at corpus row " + row);
      }
    } catch (IOException exception) {
      if (!"null".equals(expected) || Double.isFinite(value)) {
        fail("unexpected number rejection at corpus row " + row);
      }
    }
  }

  private static final class CountingInputStream extends FilterInputStream {
    private long count;

    private CountingInputStream(InputStream input) {
      super(input);
    }

    @Override
    public int read() throws IOException {
      int value = super.read();
      if (value != -1) {
        count++;
      }
      return value;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      int countRead = super.read(buffer, offset, length);
      if (countRead > 0) {
        count += countRead;
      }
      return countRead;
    }

    private long count() {
      return count;
    }
  }
}
