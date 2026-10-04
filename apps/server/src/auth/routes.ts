import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CROSS_SITE_REQUEST_PROBLEM,
  INVALID_CREDENTIALS_PROBLEM,
  INVALID_REQUEST_PROBLEM,
  RATE_LIMITED_PROBLEM,
  sendProblem,
} from "../problem-response.js";
import { SESSION_COOKIE, type Authenticator } from "./authenticator.js";
import type { AuthenticatedPrincipal } from "./principal.js";
import { createLoginRateLimiter } from "./rate-limit.js";

const MAX_FIELD_LENGTH = 256;
const LOGIN_KEYS = ["username", "password", "surface"];

type Surface = "dashboard" | "widget";

interface LoginRequest {
  readonly username?: string;
  readonly password: string;
  readonly surface: Surface;
}

function principalView(principal: AuthenticatedPrincipal) {
  return { kind: principal.kind, id: principal.id, displayName: principal.displayName };
}

function field(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function loginRequest(body: unknown, usernameRequired: boolean): LoginRequest | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !LOGIN_KEYS.includes(key))) return undefined;
  if (!field(record.password) || (record.surface !== "dashboard" && record.surface !== "widget")) return undefined;
  if (usernameRequired !== Object.hasOwn(record, "username")) return undefined;
  if (usernameRequired && !field(record.username)) return undefined;
  return {
    password: record.password,
    surface: record.surface,
    ...(usernameRequired ? { username: record.username as string } : {}),
  };
}

/** Cookie attributes per surface; `undefined` means the browser would refuse the cookie anyway. */
function cookieAttributes(surface: Surface, secure: boolean): string | undefined {
  if (surface === "dashboard") return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  // A cross-site iframe only keeps SameSite=None cookies, which browsers accept only with Secure.
  return secure ? "Path=/; HttpOnly; Secure; SameSite=None; Partitioned" : undefined;
}

function hasSessionCookie(request: FastifyRequest): boolean {
  return (request.headers.cookie ?? "").split(";").some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

export function registerAuthRoutes(app: FastifyInstance, authenticator: Authenticator | undefined, clock: () => Date): void {
  if (authenticator === undefined) {
    app.get("/api/v1/auth/session", async (_request, reply) => reply
      .header("cache-control", "no-store")
      .send({ mode: "none", loginFields: [], principal: null, expiresAt: null }));
    return;
  }

  const configuration = authenticator.configuration;
  const secure = configuration.publicUrl.protocol === "https:";
  const origin = configuration.publicUrl.origin;
  const usernameRequired = configuration.password.kind === "users";
  const loginFields = usernameRequired ? ["username", "password"] : ["password"];
  const limiter = createLoginRateLimiter({ limit: 10, windowMs: 5 * 60 * 1000, maxKeys: 10_000 });

  app.get("/api/v1/auth/session", async (request, reply) => {
    const authentication = authenticator.authenticate(request.headers, clock());
    return reply.header("cache-control", "no-store").send({
      mode: configuration.mode,
      loginFields,
      principal: authentication === undefined ? null : principalView(authentication.principal),
      expiresAt: authentication?.expiresAt?.toISOString() ?? null,
    });
  });

  app.post("/api/v1/auth/login", async (request, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    const body = loginRequest(request.body, usernameRequired);
    if (body === undefined) return sendProblem(reply, INVALID_REQUEST_PROBLEM);
    const now = clock();
    // One key per address and login: a burst of failures blocks that pair only, so the rest of a
    // team keeps signing in. Behind a reverse proxy every address is the proxy's, and the limit
    // then applies per login.
    const key = `${request.ip}|${body.username ?? "shared"}`;
    const keys = [key];
    const retryAfter = limiter.blocked(keys, now);
    if (retryAfter !== undefined) return sendProblem(reply.header("retry-after", String(retryAfter)), RATE_LIMITED_PROBLEM);
    const session = await authenticator.login(body.username, body.password, now);
    if (session === undefined) {
      limiter.fail(keys, now);
      return sendProblem(reply, INVALID_CREDENTIALS_PROBLEM);
    }
    limiter.reset(keys);
    const attributes = cookieAttributes(body.surface, secure);
    if (attributes !== undefined) {
      reply.header("set-cookie", `${SESSION_COOKIE}=${session.token}; Max-Age=${configuration.sessionTtlSeconds}; ${attributes}`);
    }
    return reply.code(200).send({
      principal: principalView(session.principal),
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (hasSessionCookie(request) && request.headers.origin !== origin) {
      return sendProblem(reply, CROSS_SITE_REQUEST_PROBLEM);
    }
    const cleared = [cookieAttributes("dashboard", secure), cookieAttributes("widget", secure)]
      .filter((attributes): attributes is string => attributes !== undefined)
      .map((attributes) => `${SESSION_COOKIE}=; Max-Age=0; ${attributes}`);
    return reply.code(204).header("cache-control", "no-store").header("set-cookie", cleared).send();
  });
}
