import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export interface PasswordHash {
  /** The configuration string, also the input of the credential version fingerprint. */
  readonly encoded: string;
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DECIMAL = /^[1-9][0-9]{0,7}$/;

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, KEY_BYTES, options, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

export async function hashPassword(password: string, salt: Buffer = randomBytes(SALT_BYTES)): Promise<string> {
  const key = await derive(password, salt, DEFAULT_N, DEFAULT_R, DEFAULT_P);
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function parsePasswordHash(encoded: string): PasswordHash | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts as [string, string, string, string, string, string];
  if (![rawN, rawR, rawP].every((value) => DECIMAL.test(value))) return undefined;
  if (!BASE64URL.test(rawSalt) || !BASE64URL.test(rawKey)) return undefined;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0) return undefined;
  if (r < 1 || r > 32 || p < 1 || p > 16) return undefined;
  const salt = Buffer.from(rawSalt, "base64url");
  const key = Buffer.from(rawKey, "base64url");
  if (salt.byteLength < SALT_BYTES || key.byteLength !== KEY_BYTES) return undefined;
  return Object.freeze({ encoded, N, r, p, salt, key });
}

export async function verifyPassword(password: string, hash: PasswordHash): Promise<boolean> {
  const key = await derive(password, hash.salt, hash.N, hash.r, hash.p);
  return timingSafeEqual(key, hash.key) && hash !== DUMMY_PASSWORD_HASH;
}

/** Verified against for unknown usernames, so they cost as much as a wrong password. */
export const DUMMY_PASSWORD_HASH: PasswordHash = parsePasswordHash(
  `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${randomBytes(SALT_BYTES).toString("base64url")}$${randomBytes(KEY_BYTES).toString("base64url")}`,
)!;
