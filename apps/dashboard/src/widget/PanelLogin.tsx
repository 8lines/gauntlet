import type { AuthSession, LoginResult } from "../auth.ts";
import { LoginForm } from "../app/LoginForm.tsx";

/** Sign-in inside the panel; nothing about it crosses the channel to the host page. */
export function PanelLogin({ session, onSignedIn }: {
  session: AuthSession;
  onSignedIn: (result: LoginResult, session: AuthSession) => Promise<void>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base/6 font-semibold">Sign in to Gauntlet</h2>
        <p className="text-sm/5 text-muted-foreground">
          {session.loginFields.includes("username")
            ? "Use your Gauntlet username and password."
            : "Enter the password for this Gauntlet."}
        </p>
      </div>
      <LoginForm fields={session.loginFields} surface="widget" onSignedIn={(result) => onSignedIn(result, session)} />
    </div>
  );
}
