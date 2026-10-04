import { isProtocolId } from "@8lines/gauntlet-protocol";
import { isApiTokenHash } from "./api-tokens.js";
import { parsePasswordHash, type PasswordHash } from "./passwords.js";

export type PasswordConfiguration =
  | { readonly kind: "shared"; readonly hash: PasswordHash }
  | { readonly kind: "users"; readonly users: ReadonlyMap<string, PasswordHash> };

export interface PasswordAuthConfiguration {
  readonly mode: "password";
  /** Origin only: the expected `Origin` of browser requests and the base of every public URL. */
  readonly publicUrl: URL;
  readonly sessionTtlSeconds: number;
  readonly password: PasswordConfiguration;
  /** API token hash to token name. */
  readonly tokens: ReadonlyMap<string, string>;
}

export type AuthConfiguration = { readonly mode: "none" } | PasswordAuthConfiguration;

export const AUTH_DISABLED: AuthConfiguration = Object.freeze({ mode: "none" });

const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 5 * 60;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const UNIT_SECONDS: Readonly<Record<string, number>> = { m: 60, h: 60 * 60, d: 24 * 60 * 60 };

function invalid(): TypeError {
  return new TypeError("Invalid authentication configuration");
}

function plainRecord(value: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw invalid();
    record[key] = descriptor.value;
  }
  return record;
}

function publicUrl(value: unknown): URL {
  if (typeof value !== "string") throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || value.includes("?")
    || value.includes("#")) {
    throw invalid();
  }
  return new URL(url.origin);
}

function sessionTtl(value: unknown): number {
  if (value === undefined) return DEFAULT_SESSION_TTL_SECONDS;
  const match = typeof value === "string" ? /^([1-9][0-9]{0,5})([mhd])$/.exec(value) : null;
  if (match === null) throw invalid();
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2]!]!;
  if (seconds < MIN_SESSION_TTL_SECONDS || seconds > MAX_SESSION_TTL_SECONDS) throw invalid();
  return seconds;
}

function passwordHash(value: unknown): PasswordHash {
  const hash = typeof value === "string" ? parsePasswordHash(value) : undefined;
  if (hash === undefined) throw invalid();
  return hash;
}

function passwordConfiguration(value: unknown): PasswordConfiguration {
  const record = plainRecord(value, ["shared", "users"]);
  const hasShared = Object.hasOwn(record, "shared");
  if (hasShared === Object.hasOwn(record, "users")) throw invalid();
  if (hasShared) {
    return Object.freeze({ kind: "shared", hash: passwordHash(plainRecord(record.shared, ["hash"]).hash) });
  }
  if (!Array.isArray(record.users) || record.users.length === 0) throw invalid();
  const users = new Map<string, PasswordHash>();
  for (const entry of record.users as unknown[]) {
    const user = plainRecord(entry, ["username", "hash"]);
    if (!isProtocolId(user.username) || users.has(user.username)) throw invalid();
    users.set(user.username, passwordHash(user.hash));
  }
  return Object.freeze({ kind: "users", users });
}

function apiTokens(value: unknown): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  if (value === undefined) return tokens;
  if (!Array.isArray(value)) throw invalid();
  const names = new Set<string>();
  for (const entry of value as unknown[]) {
    const token = plainRecord(entry, ["name", "hash"]);
    if (!isProtocolId(token.name) || names.has(token.name)) throw invalid();
    if (typeof token.hash !== "string" || !isApiTokenHash(token.hash) || tokens.has(token.hash)) throw invalid();
    names.add(token.name);
    tokens.set(token.hash, token.name);
  }
  return tokens;
}

/** Validates the optional `auth` section; an omitted section disables authentication. */
export function authConfiguration(value: unknown): AuthConfiguration {
  if (value === undefined) return AUTH_DISABLED;
  const record = plainRecord(value, ["mode", "publicUrl", "sessionTtl", "password", "tokens"]);
  if (record.mode === "none") {
    if (Object.keys(record).length !== 1) throw invalid();
    return AUTH_DISABLED;
  }
  if (record.mode !== "password") throw invalid();
  return Object.freeze({
    mode: "password",
    publicUrl: publicUrl(record.publicUrl),
    sessionTtlSeconds: sessionTtl(record.sessionTtl),
    password: passwordConfiguration(record.password),
    tokens: apiTokens(record.tokens),
  });
}
