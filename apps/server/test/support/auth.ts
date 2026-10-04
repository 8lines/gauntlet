import { createApiToken } from "../../src/auth/api-tokens.js";
import { createAuthenticator } from "../../src/auth/authenticator.js";
import { authConfiguration, type PasswordAuthConfiguration } from "../../src/auth/config.js";
import { hashPassword } from "../../src/auth/passwords.js";
import { decodeAuthSecret } from "../../src/auth/secret.js";
import type { AuthOptions } from "../../src/app.js";

export const authSecret = decodeAuthSecret("e".repeat(64));
export const apiToken = createApiToken();
export const passwords = { shared: "shared-password", anna: "anna-password" } as const;
const sharedHash = await hashPassword(passwords.shared);
const annaHash = await hashPassword(passwords.anna);

export function passwordAuth(options: {
  readonly variant?: "shared" | "users";
  readonly publicUrl?: string;
} = {}): AuthOptions & { readonly configuration: PasswordAuthConfiguration } {
  const configuration = authConfiguration({
    mode: "password",
    publicUrl: options.publicUrl ?? "http://gauntlet.test",
    password: options.variant === "users"
      ? { users: [{ username: "anna", hash: annaHash }] }
      : { shared: { hash: sharedHash } },
    tokens: [{ name: "ci-nightly", hash: apiToken.hash }],
  }) as PasswordAuthConfiguration;
  return { configuration, secret: authSecret };
}

/** A session token for the given configuration, issued without going through HTTP. */
export async function sessionToken(auth: ReturnType<typeof passwordAuth>, username?: "anna"): Promise<string> {
  const session = await createAuthenticator(auth.configuration, authSecret)
    .login(username, username === undefined ? passwords.shared : passwords[username], new Date());
  if (session === undefined) throw new TypeError("Test session could not be issued");
  return session.token;
}
