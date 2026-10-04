import type { FastifyInstance } from "fastify";
import type { AuthConfiguration } from "./config.js";
import { createAuthenticator, type Authenticator } from "./authenticator.js";
import { registerAuthGuard } from "./guard.js";

export interface RegisterAuthOptions {
  readonly configuration: AuthConfiguration;
  readonly secret?: Buffer;
  readonly clock: () => Date;
}

/** Registers the request guard; returns the authenticator, or undefined when authentication is off. */
export function registerAuth(app: FastifyInstance, options: RegisterAuthOptions): Authenticator | undefined {
  if (options.configuration.mode === "none") return undefined;
  if (options.secret === undefined) throw new TypeError("Authentication requires GAUNTLET_AUTH_SECRET");
  const authenticator = createAuthenticator(options.configuration, options.secret);
  registerAuthGuard(app, authenticator, options.clock);
  return authenticator;
}
