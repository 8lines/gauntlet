import type { FastifyInstance } from "fastify";
import type { AuthConfiguration } from "./config.js";
import { createAuthenticator, type Authenticator } from "./authenticator.js";
import { registerAuthGuard } from "./guard.js";
import { registerAuthRoutes } from "./routes.js";

export interface RegisterAuthOptions {
  readonly configuration: AuthConfiguration;
  readonly secret?: Buffer;
  readonly clock: () => Date;
}

/** Registers the request guard and `/api/v1/auth/*`; with authentication off only the session route exists. */
export function registerAuth(app: FastifyInstance, options: RegisterAuthOptions): Authenticator | undefined {
  if (options.configuration.mode === "none") {
    registerAuthRoutes(app, undefined, options.clock);
    return undefined;
  }
  if (options.secret === undefined) throw new TypeError("Authentication requires GAUNTLET_AUTH_SECRET");
  const authenticator = createAuthenticator(options.configuration, options.secret);
  registerAuthGuard(app, authenticator, options.clock);
  registerAuthRoutes(app, authenticator, options.clock);
  return authenticator;
}
