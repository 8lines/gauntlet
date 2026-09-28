package dev.eightlines.gauntlet.core.run;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class IdempotencyFingerprint {
  private static final byte[] DOMAIN = "tc-idempotency:v1\0".getBytes(StandardCharsets.UTF_8);

  private IdempotencyFingerprint() {}

  public static String create(String operationId, String rawKey, byte[] secret) {
    if (secret == null || secret.length < 32)
      throw new IllegalArgumentException("idempotency secret must contain at least 32 bytes");
    try {
      Mac hmac = Mac.getInstance("HmacSHA256");
      hmac.init(new SecretKeySpec(secret.clone(), "HmacSHA256"));
      hmac.update(DOMAIN);
      hmac.update(operationId.getBytes(StandardCharsets.UTF_8));
      hmac.update((byte) 0);
      hmac.update(rawKey.getBytes(StandardCharsets.UTF_8));
      return "tc-idempotency:v1:" + HexFormat.of().formatHex(hmac.doFinal());
    } catch (GeneralSecurityException exception) {
      throw new IllegalStateException("HMAC-SHA256 unavailable", exception);
    }
  }
}
