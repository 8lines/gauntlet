import { hkdfSync } from "node:crypto";

export const MIN_SECRET_BYTES = 32;

export type TokenKind = "s" | "a" | "r" | "c";
export type TokenKeys = Readonly<Record<TokenKind, Buffer>>;

const TOKEN_KINDS: readonly TokenKind[] = ["s", "a", "r", "c"];

/** Decodes `GAUNTLET_AUTH_SECRET` from hex or base64url; anything shorter than 32 bytes is refused. */
export function decodeAuthSecret(value: string): Buffer {
  const trimmed = value.trim();
  let secret: Buffer | undefined;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(trimmed)) {
    secret = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    secret = Buffer.from(trimmed, "base64url");
  }
  if (secret === undefined || secret.byteLength < MIN_SECRET_BYTES) {
    throw new TypeError("Invalid authentication secret");
  }
  return secret;
}

/** One HKDF-derived key per token kind, so a token of one kind never verifies as another. */
export function deriveTokenKeys(secret: Buffer): TokenKeys {
  const keys = {} as Record<TokenKind, Buffer>;
  for (const kind of TOKEN_KINDS) {
    keys[kind] = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `gauntlet/${kind}/v1`, 32));
  }
  return Object.freeze(keys);
}
