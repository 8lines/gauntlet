package dev.eightlines.gauntlet.core.json;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;

public final class CanonicalJson {
  private static final Rfc8785Canonicalizer CANONICALIZER = new Rfc8785Canonicalizer();

  private CanonicalJson() {}

  public static byte[] encode(Object value) {
    return CANONICALIZER.canonicalize(JsonOwnership.ownRevision(value));
  }

  public static String revision(Map<String, ?> document, String revisionField) {
    return revision(JsonOwnership.revisionObject(document), revisionField);
  }

  public static String revision(JsonObject document, String revisionField) {
    Map<String, JsonValue> projection = new LinkedHashMap<>(document.values());
    projection.remove(revisionField);
    byte[] bytes = CANONICALIZER.canonicalize(new JsonObject(projection));
    try {
      return "sha256:"
          + java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException(exception);
    }
  }

  public static String encodeString(Object value) {
    return new String(encode(value), StandardCharsets.UTF_8);
  }
}
