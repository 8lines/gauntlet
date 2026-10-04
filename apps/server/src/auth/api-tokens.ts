import { createHash, randomBytes } from "node:crypto";

const API_TOKEN = /^gat_[A-Za-z0-9_-]{43}$/;
const API_TOKEN_HASH = /^sha256\$[A-Za-z0-9_-]{43}$/;

export function hashApiToken(token: string): string {
  return `sha256$${createHash("sha256").update(token).digest("base64url")}`;
}

export function isApiToken(value: string): boolean {
  return API_TOKEN.test(value);
}

export function isApiTokenHash(value: string): boolean {
  return API_TOKEN_HASH.test(value);
}

/** A static API token is 32 random bytes, so a fast hash is enough to store it. */
export function createApiToken(): { readonly token: string; readonly hash: string } {
  const token = `gat_${randomBytes(32).toString("base64url")}`;
  return Object.freeze({ token, hash: hashApiToken(token) });
}
