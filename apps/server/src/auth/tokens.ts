import { createHmac, timingSafeEqual } from "node:crypto";
import type { TokenKeys, TokenKind } from "./secret.js";

export const MAX_TOKEN_LENGTH = 4096;

/** Times are seconds since the epoch. */
export interface TokenPayload {
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly pv?: string;
  readonly [key: string]: unknown;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function signature(key: Buffer, signed: string): Buffer {
  return createHmac("sha256", key).update(signed).digest();
}

export function signToken(keys: TokenKeys, kind: TokenKind, payload: TokenPayload): string {
  const signed = `g1.${kind}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${signed}.${signature(keys[kind], signed).toString("base64url")}`;
}

export function verifyToken(
  keys: TokenKeys,
  kind: TokenKind,
  token: string,
  now: Date,
): TokenPayload | undefined {
  if (token.length > MAX_TOKEN_LENGTH) return undefined;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "g1" || parts[1] !== kind) return undefined;
  const [, , body, encodedSignature] = parts as [string, string, string, string];
  if (!BASE64URL.test(body) || !BASE64URL.test(encodedSignature)) return undefined;
  const expected = signature(keys[kind], `g1.${kind}.${body}`);
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const candidate = payload as Partial<TokenPayload>;
  if (typeof candidate.sub !== "string"
    || !Number.isSafeInteger(candidate.iat)
    || !Number.isSafeInteger(candidate.exp)
    || (candidate.pv !== undefined && typeof candidate.pv !== "string")) {
    return undefined;
  }
  if (candidate.exp! * 1000 <= now.getTime()) return undefined;
  return candidate as TokenPayload;
}
