import { useCallback } from "react";
import { api, type Result } from "../api.ts";
import { authTokenStore, type AuthSession, type LoginResult, type TokenStore } from "../auth.ts";
import { useAuthSession, type AuthSessionControls } from "../app/useAuthSession.ts";

/**
 * After a widget sign-in: the panel is a cross-site iframe, so the browser may refuse the
 * session cookie (plain HTTP, Safari). Ask with the cookie alone; if Gauntlet does not
 * recognise the session, keep the token from the sign-in and send it as a bearer credential.
 */
export async function completeWidgetLogin(
  result: LoginResult,
  session: AuthSession,
  store: TokenStore,
  probe: () => Promise<Result<AuthSession>> = () => api.session({ cookieOnly: true }),
): Promise<AuthSession> {
  const answer = await probe();
  if (answer.ok && answer.data.principal?.id === result.principal.id) {
    store.clear();
    return answer.data;
  }
  store.write(result.token);
  return { ...session, principal: result.principal, expiresAt: result.expiresAt };
}

export interface PanelAuthControls extends AuthSessionControls {
  readonly widgetSignedIn: (result: LoginResult, session: AuthSession) => Promise<void>;
}

export function usePanelAuth(): PanelAuthControls {
  const controls = useAuthSession();
  const { signedIn } = controls;
  const widgetSignedIn = useCallback(async (result: LoginResult, session: AuthSession) => {
    signedIn(await completeWidgetLogin(result, session, authTokenStore()));
  }, [signedIn]);
  return { ...controls, widgetSignedIn };
}
