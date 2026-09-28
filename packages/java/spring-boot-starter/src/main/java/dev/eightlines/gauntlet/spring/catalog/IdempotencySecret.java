package dev.eightlines.gauntlet.spring.catalog;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;

/** Opaque idempotency fingerprint secret that never renders its value. */
public final class IdempotencySecret {
  private final byte[] value;

  private IdempotencySecret(byte[] value) {
    if (value.length < 32) {
      throw new IllegalArgumentException(
          "gauntlet.idempotency-secret must contain at least 32 UTF-8 bytes");
    }
    this.value = value.clone();
  }

  public static IdempotencySecret configured(String value) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("gauntlet.idempotency-secret is required");
    }
    return new IdempotencySecret(value.getBytes(StandardCharsets.UTF_8));
  }

  /** Only disabled adapters may use a process-local secret because they cannot accept requests. */
  public static IdempotencySecret disabledEphemeral() {
    byte[] value = new byte[32];
    new SecureRandom().nextBytes(value);
    return new IdempotencySecret(value);
  }

  public byte[] copyForRuntime() {
    return value.clone();
  }

  @Override
  public String toString() {
    return "IdempotencySecret[REDACTED]";
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof IdempotencySecret secret && Arrays.equals(value, secret.value);
  }

  @Override
  public int hashCode() {
    return Arrays.hashCode(value);
  }
}
