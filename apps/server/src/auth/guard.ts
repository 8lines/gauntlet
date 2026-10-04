import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CROSS_SITE_REQUEST_PROBLEM, sendProblem, UNAUTHENTICATED_PROBLEM } from "../problem-response.js";
import type { Authentication, Authenticator } from "./authenticator.js";
import { setRequestPrincipal } from "./principal.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function rawPathname(request: FastifyRequest): string {
  return (request.raw.url ?? "").split("?", 1)[0] ?? "";
}

/** The API and MCP need credentials; static assets, probes and the auth routes do not. */
export function isProtectedPath(pathname: string): boolean {
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return true;
  if (pathname === "/api" || pathname.startsWith("/api/")) return !pathname.startsWith("/api/v1/auth/");
  return false;
}

/**
 * Cookies reach Gauntlet from any site that frames or links to it, and the widget cookie is
 * `SameSite=None`, so a cookie may only authorize a mutation sent from Gauntlet's own origin.
 */
export function crossSiteMutation(request: FastifyRequest, authentication: Authentication, origin: string): boolean {
  return authentication.via === "cookie"
    && !SAFE_METHODS.has(request.method)
    && request.headers.origin !== origin;
}

function rejectUnauthenticated(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.header("www-authenticate", "Bearer");
  if (rawPathname(request).startsWith("/mcp")) {
    return reply.code(401).header("cache-control", "no-store")
      .send({ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required" } });
  }
  return sendProblem(reply, UNAUTHENTICATED_PROBLEM);
}

export function registerAuthGuard(app: FastifyInstance, authenticator: Authenticator, clock: () => Date): void {
  const origin = authenticator.configuration.publicUrl.origin;
  app.addHook("onRequest", async (request, reply) => {
    if (!isProtectedPath(rawPathname(request))) return;
    const authentication = authenticator.authenticate(request.headers, clock());
    if (authentication === undefined) return rejectUnauthenticated(request, reply);
    if (crossSiteMutation(request, authentication, origin)) return sendProblem(reply, CROSS_SITE_REQUEST_PROBLEM);
    setRequestPrincipal(request, authentication.principal);
  });
}
