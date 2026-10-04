import { isProtocolId, type Problem } from "@8lines/gauntlet-protocol";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { safeProblem } from "./safe-problem.js";

export const INVALID_PATH_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:invalid-path",
  title: "Invalid path",
  status: 400,
});
export const INVALID_JSON_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:invalid-json",
  title: "Invalid JSON",
  status: 400,
});
export const INVALID_REQUEST_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:invalid-request",
  title: "Invalid request",
  status: 400,
});
export const PAYLOAD_TOO_LARGE_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:payload-too-large",
  title: "Payload too large",
  status: 413,
});
export const UNSUPPORTED_MEDIA_TYPE_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:unsupported-media-type",
  title: "Unsupported media type",
  status: 415,
});
export const ROUTE_NOT_FOUND_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:route-not-found",
  title: "Route not found",
  status: 404,
});
export const METHOD_NOT_ALLOWED_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:method-not-allowed",
  title: "Method not allowed",
  status: 405,
});
export const UNAUTHENTICATED_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:unauthenticated",
  title: "Authentication required",
  status: 401,
});
export const INVALID_CREDENTIALS_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:invalid-credentials",
  title: "Invalid credentials",
  status: 401,
});
export const RATE_LIMITED_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:rate-limited",
  title: "Too many attempts",
  status: 429,
});
export const CROSS_SITE_REQUEST_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:cross-site-request",
  title: "Cross-site request rejected",
  status: 403,
});
export const INTERNAL_ERROR_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:internal-error",
  title: "Internal server error",
  status: 500,
});

const knownRoutes: ReadonlyArray<{ readonly pattern: RegExp; readonly methods: ReadonlySet<string> }> = [
  { pattern: /^\/health$/, methods: new Set(["GET"]) },
  { pattern: /^\/ready$/, methods: new Set(["GET"]) },
  { pattern: /^\/api\/v1\/targets$/, methods: new Set(["GET"]) },
  { pattern: /^\/api\/v1\/targets\/([^/]+)\/operations\/([^/]+)$/, methods: new Set(["GET"]) },
  { pattern: /^\/api\/v1\/targets\/([^/]+)\/operations\/([^/]+)\/runs$/, methods: new Set(["POST"]) },
  { pattern: /^\/api\/v1\/targets\/([^/]+)\/uploads$/, methods: new Set(["POST"]) },
  { pattern: /^\/api\/v1\/targets\/([^/]+)\/runs\/([^/]+)$/, methods: new Set(["GET"]) },
  { pattern: /^\/api\/v1\/targets\/([^/]+)\/runs\/([^/]+)\/cancel$/, methods: new Set(["POST"]) },
  { pattern: /^\/api\/v1\/targets\/([^/]+)\/runs\/([^/]+)\/events$/, methods: new Set(["GET"]) },
  { pattern: /^\/api\/v1\/targets\/([^/]+)\/data-sources\/([^/]+)\/(?:query|resolve)$/, methods: new Set(["POST"]) },
  { pattern: /^\/api\/v1\/targets\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)\/launch$/, methods: new Set(["POST"]) },
];

function rawPathname(request: FastifyRequest): string {
  return (request.raw.url ?? "").split("?", 1)[0] ?? "";
}

export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  const document = safeProblem(problem);
  return reply.code(document.status).type("application/problem+json").send(document);
}

export function sendBadUrlProblem(response: ServerResponse): void {
  const document = JSON.stringify(safeProblem(INVALID_PATH_PROBLEM));
  response.writeHead(400, {
    "content-type": "application/problem+json; charset=utf-8",
    "content-length": Buffer.byteLength(document),
  });
  response.end(document);
}

export function sendClientErrorProblem(socket: Socket): void {
  if (!socket.writable || socket.destroyed) {
    return;
  }
  const document = JSON.stringify(safeProblem(INVALID_REQUEST_PROBLEM));
  socket.end([
    "HTTP/1.1 400 Bad Request",
    "content-type: application/problem+json; charset=utf-8",
    `content-length: ${Buffer.byteLength(document)}`,
    "connection: close",
    "",
    document,
  ].join("\r\n"));
}

export interface ProblemResponseOptions {
  /**
   * Invoked for unmatched GET requests outside the reserved API and probe routes.
   * Lets the dashboard, which routes client-side in the browser, take over
   * without changing API behavior (identifier validation, 405 with an `allow` header).
   */
  readonly spaFallback?: (request: FastifyRequest, reply: FastifyReply) => unknown;
}

function isReservedPath(pathname: string): boolean {
  return pathname === "/mcp"
    || pathname.startsWith("/mcp/")
    || pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/health"
    || pathname.startsWith("/health/")
    || pathname === "/ready"
    || pathname.startsWith("/ready/")
    || pathname === "/assets"
    || pathname.startsWith("/assets/")
    || pathname === "/widget"
    || pathname.startsWith("/widget/");
}

const HTTP_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_RANGE = new RegExp(`^(${HTTP_TOKEN})/(${HTTP_TOKEN})$`);
const ACCEPT_PARAMETER = new RegExp(`^(${HTTP_TOKEN})\\s*=\\s*(${HTTP_TOKEN}|\"(?:[^\"\\\\]|\\\\.)*\")$`);
const QUALITY = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;

function splitHeader(value: string, delimiter: "," | ";"): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === "\"") {
      quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return undefined;
  parts.push(value.slice(start));
  return parts;
}

function acceptsHtml(accept: string | undefined): boolean {
  if (accept === undefined || accept.trim().length === 0) return false;
  const entries = splitHeader(accept, ",");
  if (entries === undefined) return false;
  let accepted = false;

  for (const rawEntry of entries) {
    const rawSegments = splitHeader(rawEntry, ";");
    if (rawSegments === undefined) return false;
    const segments = rawSegments.map((segment) => segment.trim());
    const media = MEDIA_RANGE.exec(segments.shift() ?? "");
    if (media === null) return false;

    let quality = 1;
    let hasQuality = false;
    for (const segment of segments) {
      const parameter = ACCEPT_PARAMETER.exec(segment);
      if (parameter === null) return false;
      if (parameter[1]!.toLowerCase() !== "q") continue;
      if (hasQuality || !QUALITY.test(parameter[2]!)) return false;
      hasQuality = true;
      quality = Number(parameter[2]);
    }

    if (media[1]!.toLowerCase() === "text"
      && media[2]!.toLowerCase() === "html"
      && quality > 0) {
      accepted = true;
    }
  }
  return accepted;
}

export function isSpaNavigation(request: FastifyRequest): boolean {
  const pathname = rawPathname(request);
  return request.method === "GET"
    && !pathname.includes("%")
    && !isReservedPath(pathname)
    && acceptsHtml(request.headers.accept);
}

export function configureProblemResponses(app: FastifyInstance, options: ProblemResponseOptions = {}): void {
  app.addHook("onRequest", async (request, reply) => {
    if (rawPathname(request).includes("%")) {
      return sendProblem(reply, INVALID_PATH_PROBLEM);
    }
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
      || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return sendProblem(reply, INVALID_JSON_PROBLEM);
    }
    if (error.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH") {
      return sendProblem(reply, INVALID_REQUEST_PROBLEM);
    }
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendProblem(reply, PAYLOAD_TOO_LARGE_PROBLEM);
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return sendProblem(reply, UNSUPPORTED_MEDIA_TYPE_PROBLEM);
    }
    if (error.statusCode === 400 && error instanceof SyntaxError) {
      return sendProblem(reply, INVALID_JSON_PROBLEM);
    }
    return sendProblem(reply, INTERNAL_ERROR_PROBLEM);
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = rawPathname(request);

    if (options.spaFallback !== undefined && isSpaNavigation(request)) {
      return options.spaFallback(request, reply);
    }

    const route = knownRoutes
      .map((candidate) => ({ candidate, match: candidate.pattern.exec(pathname) }))
      .find(({ match }) => match !== null);
    if (route !== undefined && route.match!.slice(1).some((id) => !isProtocolId(id))) {
      return sendProblem(reply, INVALID_PATH_PROBLEM);
    }
    if (route !== undefined && !route.candidate.methods.has(request.method)) {
      reply.header("allow", [...route.candidate.methods].join(", "));
      return sendProblem(reply, METHOD_NOT_ALLOWED_PROBLEM);
    }
    return sendProblem(reply, ROUTE_NOT_FOUND_PROBLEM);
  });
}
