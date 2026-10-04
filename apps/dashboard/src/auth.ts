/** Shapes of `/api/v1/auth/*` (see apps/server/src/auth/routes.ts). */
export interface AuthPrincipal {
  readonly kind: "shared" | "user" | "token";
  readonly id: string;
  readonly displayName: string;
}

export type LoginField = "username" | "password";

export interface AuthSession {
  readonly mode: "none" | "password";
  readonly loginFields: readonly LoginField[];
  readonly principal: AuthPrincipal | null;
  readonly expiresAt: string | null;
}

export interface LoginResult {
  readonly principal: AuthPrincipal;
  readonly token: string;
  readonly expiresAt: string;
}

/** Where a bearer session token is kept when the browser will not keep the session cookie. */
export interface TokenStore {
  read(): string | undefined;
  write(token: string): void;
  clear(): void;
}

export function memoryTokenStore(): TokenStore {
  let token: string | undefined;
  return {
    read: () => token,
    write: (value) => { token = value; },
    clear: () => { token = undefined; },
  };
}

/** Storage that throws (blocked, full, sandboxed) behaves as empty. */
export function localTokenStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key = "gauntlet.session.v1",
): TokenStore {
  return {
    read: () => {
      try {
        return storage.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    write: (value) => {
      try {
        storage.setItem(key, value);
      } catch {
        // The session then lasts until the panel reloads.
      }
    },
    clear: () => {
      try {
        storage.removeItem(key);
      } catch {
        // Nothing stored that could be removed.
      }
    },
  };
}

let store: TokenStore = memoryTokenStore();
const listeners = new Set<() => void>();

export function configureAuthTransport(next: TokenStore): void {
  store = next;
}

export function authTokenStore(): TokenStore {
  return store;
}

/** Called when Gauntlet answers that the session is missing or no longer valid. */
export function onUnauthenticated(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyUnauthenticated(): void {
  for (const listener of [...listeners]) listener();
}
