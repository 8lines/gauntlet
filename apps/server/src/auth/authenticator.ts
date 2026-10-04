import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { hashApiToken, isApiToken } from "./api-tokens.js";
import type { PasswordAuthConfiguration } from "./config.js";
import { DUMMY_PASSWORD_HASH, verifyPassword, type PasswordHash } from "./passwords.js";
import type { AuthenticatedPrincipal } from "./principal.js";
import { deriveTokenKeys, type TokenKeys } from "./secret.js";
import { signToken, verifyToken, type TokenPayload } from "./tokens.js";

export const SESSION_COOKIE = "gauntlet_session";

const SHARED_PRINCIPAL: AuthenticatedPrincipal = Object.freeze({
  kind: "shared",
  id: "shared",
  displayName: "Shared password",
});

export interface Authentication {
  readonly principal: AuthenticatedPrincipal;
  /** How the credential arrived; cookie credentials are subject to the cross-site check. */
  readonly via: "bearer" | "cookie";
  /** Absent for static API tokens, which do not expire. */
  readonly expiresAt?: Date;
}

export interface IssuedSession {
  readonly principal: AuthenticatedPrincipal;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface Authenticator {
  readonly configuration: PasswordAuthConfiguration;
  authenticate(headers: Pick<IncomingHttpHeaders, "authorization" | "cookie">, now: Date): Authentication | undefined;
  login(username: string | undefined, password: string, now: Date): Promise<IssuedSession | undefined>;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function createAuthenticator(configuration: PasswordAuthConfiguration, secret: Buffer): Authenticator {
  const keys: TokenKeys = deriveTokenKeys(secret);
  const sessionTtlMs = configuration.sessionTtlSeconds * 1000;

  /** The hash a principal currently signs in with, or undefined when it no longer exists. */
  function currentHash(principal: AuthenticatedPrincipal): PasswordHash | undefined {
    const password = configuration.password;
    if (principal.kind === "shared") return password.kind === "shared" ? password.hash : undefined;
    if (principal.kind === "user" && password.kind === "users") return password.users.get(principal.id.slice("user:".length));
    return undefined;
  }

  /** Credential version: changes when the principal's password hash changes. */
  function credentialVersion(principal: AuthenticatedPrincipal, hash: PasswordHash): string {
    return createHmac("sha256", keys.s).update(`pv:${principal.id}:${hash.encoded}`).digest("base64url").slice(0, 16);
  }

  function principalFor(subject: string): AuthenticatedPrincipal | undefined {
    if (subject === "shared") return SHARED_PRINCIPAL;
    if (subject.startsWith("user:")) {
      const username = subject.slice("user:".length);
      return Object.freeze({ kind: "user", id: `user:${username}`, displayName: username });
    }
    return undefined;
  }

  function sessionPrincipal(payload: TokenPayload): AuthenticatedPrincipal | undefined {
    const principal = principalFor(payload.sub);
    if (principal === undefined) return undefined;
    const hash = currentHash(principal);
    if (hash === undefined || payload.pv !== credentialVersion(principal, hash)) return undefined;
    return principal;
  }

  function verifySession(token: string, via: Authentication["via"], now: Date): Authentication | undefined {
    const payload = verifyToken(keys, "s", token, now);
    const principal = payload === undefined ? undefined : sessionPrincipal(payload);
    return principal === undefined ? undefined : { principal, via, expiresAt: new Date(payload!.exp * 1000) };
  }

  function verifyBearer(token: string, now: Date): Authentication | undefined {
    if (isApiToken(token)) {
      const name = configuration.tokens.get(hashApiToken(token));
      return name === undefined
        ? undefined
        : { principal: Object.freeze({ kind: "token", id: `token:${name}`, displayName: name }), via: "bearer" };
    }
    return verifySession(token, "bearer", now);
  }

  return {
    configuration,

    authenticate(headers, now) {
      const authorization = headers.authorization;
      if (authorization !== undefined) {
        const match = /^Bearer ([!-~]+)$/.exec(authorization);
        return match === null ? undefined : verifyBearer(match[1]!, now);
      }
      const cookie = cookieValue(headers.cookie, SESSION_COOKIE);
      return cookie === undefined ? undefined : verifySession(cookie, "cookie", now);
    },

    async login(username, password, now) {
      const passwords = configuration.password;
      let principal: AuthenticatedPrincipal | undefined;
      let hash: PasswordHash | undefined;
      if (passwords.kind === "shared") {
        if (username === undefined) {
          principal = SHARED_PRINCIPAL;
          hash = passwords.hash;
        }
      } else if (username !== undefined) {
        hash = passwords.users.get(username);
        principal = hash === undefined ? undefined : principalFor(`user:${username}`);
      }
      // Unknown usernames cost as much as a wrong password.
      const verified = await verifyPassword(password, hash ?? DUMMY_PASSWORD_HASH);
      if (!verified || principal === undefined || hash === undefined) return undefined;
      const issuedAt = Math.floor(now.getTime() / 1000);
      const expiresAtSeconds = Math.floor((now.getTime() + sessionTtlMs) / 1000);
      const token = signToken(keys, "s", {
        sub: principal.id,
        iat: issuedAt,
        exp: expiresAtSeconds,
        pv: credentialVersion(principal, hash),
      });
      return { principal, token, expiresAt: new Date(expiresAtSeconds * 1000) };
    },
  };
}
