import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import { ROUTE_NOT_FOUND_PROBLEM, sendProblem } from "./problem-response.js";

/**
 * The URL path prefix Gauntlet is served under, such as `/tester` behind a shared host's
 * reverse proxy that does not strip the prefix. `""` (the default) serves Gauntlet at the root.
 *
 * A base path is one or more `/segment` parts, each starting with a letter or digit and made of
 * URL-unreserved characters only, so it never needs escaping in a URL, a cookie `Path` or HTML,
 * and it cannot contain a trailing slash, a query, a fragment, `%`-escapes or dot segments.
 */
export const BASE_PATH_PATTERN = /^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)+$/;
export const MAX_BASE_PATH_LENGTH = 256;

export function isBasePath(value: unknown): value is string {
  return typeof value === "string"
    && (value === "" || (value.length <= MAX_BASE_PATH_LENGTH && BASE_PATH_PATTERN.test(value)));
}

/** The validated base path; anything else is a generic error that does not echo the value. */
export function parseBasePath(value: unknown): string {
  if (!isBasePath(value)) throw new TypeError("Invalid base path");
  return value;
}

/** Paths that stay reachable at the root as well, so container and Kubernetes probes need no prefix. */
const ROOT_PROBES = new Set(["/health", "/ready"]);

type Disposition = "outside" | "redirect";

function splitUrl(url: string): { readonly path: string; readonly query: string } {
  const index = url.indexOf("?");
  return index === -1 ? { path: url, query: "" } : { path: url.slice(0, index), query: url.slice(index) };
}

/**
 * Serves every route of `app` under `basePath`: requests arrive with the prefix, which is removed
 * before routing, so routes, hooks and handlers keep seeing root paths. `<basePath>` alone is
 * redirected to `<basePath>/`; `/health` and `/ready` also answer at the root; anything else
 * outside the prefix is `route-not-found`. Returns the Fastify `rewriteUrl` option and installs
 * the hook that answers the requests it cannot route; with an empty base path it does nothing.
 */
export interface BasePathRouting {
  /** The Fastify `rewriteUrl` server option; undefined at the root. */
  readonly rewriteUrl?: (request: IncomingMessage) => string;
  /** Adds the hook answering redirected and out-of-prefix requests; call it before any other registration. */
  readonly install: (app: FastifyInstance) => void;
}

export function basePathRouting(basePath: string): BasePathRouting {
  if (basePath === "") return { install: () => undefined };
  const dispositions = new WeakMap<IncomingMessage, Disposition>();
  return {
    rewriteUrl: (request) => {
      const url = request.url ?? "";
      const { path, query } = splitUrl(url);
      if (path === basePath) {
        dispositions.set(request, "redirect");
        return url;
      }
      if (path.startsWith(`${basePath}/`)) return url.slice(basePath.length);
      if (!ROOT_PROBES.has(path)) dispositions.set(request, "outside");
      return `${path}${query}`;
    },
    install: (app) => {
      app.addHook("onRequest", async (request, reply) => {
        const disposition = dispositions.get(request.raw);
        if (disposition === undefined) return;
        if (disposition === "outside") return sendProblem(reply, ROUTE_NOT_FOUND_PROBLEM);
        const { query } = splitUrl(request.raw.url ?? "");
        return reply.code(308).header("location", `${basePath}/${query}`).header("cache-control", "no-store").send();
      });
    },
  };
}

// An element alone on its line is removed with the line.
const BASE_ELEMENT = /(?:^[ \t]*<base\b[^>]*>[ \t]*(?:\r?\n|$))|<base\b[^>]*>/gim;
const BASE_PATH_META = /(?:^[ \t]*<meta\b[^>]*\bname=["']?gauntlet-base-path["']?[^>]*>[ \t]*(?:\r?\n|$))|<meta\b[^>]*\bname=["']?gauntlet-base-path["']?[^>]*>/gim;
const HEAD_OPEN = /<head\b[^>]*>/i;
const HTML_OPEN = /<html\b[^>]*>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * Tells a built page where Gauntlet is served: `<meta name="gauntlet-base-path">` for the page's
 * API client and router, and with `baseHref` a `<base href="<basePath>/">` so the page's relative
 * asset URLs resolve from the base path on every client-side route. Replaces any such elements the
 * page already has and inserts the new ones first in `<head>`. The base path needs no escaping.
 */
export function injectBasePath(html: string, basePath: string, options: { readonly baseHref: boolean }): string {
  const tags = `${options.baseHref ? `<base href="${basePath}/">` : ""}<meta name="gauntlet-base-path" content="${basePath}">`;
  const page = html.replace(BASE_ELEMENT, "").replace(BASE_PATH_META, "");
  for (const anchor of [HEAD_OPEN, HTML_OPEN, DOCTYPE]) {
    const match = anchor.exec(page);
    if (match !== null) {
      const end = match.index + match[0].length;
      return `${page.slice(0, end)}${tags}${page.slice(end)}`;
    }
  }
  return `${tags}${page}`;
}
