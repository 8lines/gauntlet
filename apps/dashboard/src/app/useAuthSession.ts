import { useCallback, useEffect, useState } from "react";
import type { Problem } from "@8lines/gauntlet-protocol";
import { api } from "../api.ts";
import { authTokenStore, onUnauthenticated, type AuthSession } from "../auth.ts";
import { browserStorage } from "../browser-storage.ts";
import { clearCatalogCache } from "../catalog-cache.ts";

export type AuthState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly problem: Problem }
  | { readonly status: "ready"; readonly session: AuthSession };

export interface AuthSessionControls {
  readonly state: AuthState;
  readonly retry: () => void;
  readonly signedIn: (session: AuthSession) => void;
  /** Resolves to the problem when Gauntlet refused or never got the log out; the session then stays. */
  readonly signOut: () => Promise<Problem | undefined>;
}

/** Whether the app must show the sign-in form instead of its content. */
export function needsSignIn(session: AuthSession): boolean {
  return session.mode !== "none" && session.principal === null;
}

/**
 * Loads `/api/v1/auth/session` once and again whenever an API call answers that the session is
 * gone, so an expired session (or a server that turned authentication on) lands on sign-in.
 */
export function useAuthSession(): AuthSessionControls {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const load = useCallback(async () => {
    const result = await api.session();
    setState(result.ok ? { status: "ready", session: result.data } : { status: "failed", problem: result.problem });
  }, []);

  useEffect(() => {
    void load();
    return onUnauthenticated(() => void load());
  }, [load]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  const signedIn = useCallback((session: AuthSession) => setState({ status: "ready", session }), []);

  const signOut = useCallback(async () => {
    const result = await api.logout();
    // A refused log out leaves the HttpOnly cookie in place: showing sign-in would only pretend.
    if (!result.ok) return result.problem;
    authTokenStore().clear();
    clearCatalogCache(browserStorage);
    setState((current) => current.status === "ready"
      ? { status: "ready", session: { ...current.session, principal: null, expiresAt: null } }
      : current);
    return undefined;
  }, []);

  return { state, retry, signedIn, signOut };
}
