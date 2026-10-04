import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Problem } from "@8lines/gauntlet-protocol";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "../api.ts";
import type { LoginField, LoginResult } from "../auth.ts";
import { loginProblemMessage } from "../copy.ts";

/** The sign-in fields Gauntlet asked for; shared by the dashboard screen and the widget panel. */
export function LoginForm({ fields, surface, onSignedIn }: {
  fields: readonly LoginField[];
  surface: "dashboard" | "widget";
  onSignedIn: (result: LoginResult) => void | Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const usernameId = useId();
  const passwordId = useId();
  const errorId = useId();
  const firstField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const askUsername = fields.includes("username");

  useEffect(() => firstField.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setProblem(undefined);
    const result = await api.login({ ...(askUsername ? { username } : {}), password, surface });
    if (result.ok) {
      await onSignedIn(result.data);
      return;
    }
    setPending(false);
    setProblem(result.problem);
    setPassword("");
    passwordField.current?.focus();
  };

  const describedBy = problem === undefined ? undefined : errorId;
  return (
    <form className="flex w-full flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
      {problem !== undefined && (
        <Alert variant="destructive" role="alert" id={errorId}>
          <AlertDescription>{loginProblemMessage(problem, fields)}</AlertDescription>
        </Alert>
      )}
      {askUsername && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={usernameId}>Username</Label>
          <Input
            ref={firstField}
            id={usernameId}
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            aria-describedby={describedBy}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor={passwordId}>Password</Label>
        <Input
          ref={(node) => {
            passwordField.current = node;
            if (!askUsername) firstField.current = node;
          }}
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          aria-describedby={describedBy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={pending || password.length === 0 || (askUsername && username.length === 0)}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
