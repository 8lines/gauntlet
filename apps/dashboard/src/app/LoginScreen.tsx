import { GauntletMark } from "@/components/gauntlet/GauntletMark";
import type { AuthSession, LoginResult } from "../auth.ts";
import { LoginForm } from "./LoginForm.tsx";

/** Full-screen sign-in shown before the dashboard loads anything else. */
export function LoginScreen({ session, onSignedIn }: {
  session: AuthSession;
  onSignedIn: (session: AuthSession) => void;
}) {
  const signedIn = (result: LoginResult) => onSignedIn({
    ...session,
    principal: result.principal,
    expiresAt: result.expiresAt,
  });
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex flex-col gap-3">
          <GauntletMark className="size-6 text-foreground" />
          <h1 className="text-2xl/8 font-semibold tracking-tight">Sign in to Gauntlet</h1>
          <p className="text-sm/5 text-muted-foreground">
            {session.loginFields.includes("username")
              ? "Use the username and password your team gave you."
              : "Enter the password for this Gauntlet."}
          </p>
        </div>
        <LoginForm fields={session.loginFields} surface="dashboard" onSignedIn={signedIn} />
      </div>
    </main>
  );
}
