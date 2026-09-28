import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StaticTargetConfig } from "./static-target-provider.js";

export interface WidgetOptions {
  readonly enabled: boolean;
  /** Directory containing index.html, loader.js and optional assets/. Required when enabled. */
  readonly dir?: string;
}

export interface WidgetConfigDocument {
  readonly targets: Readonly<Record<string, readonly string[]>>;
}

const HASHED_ASSET = /^.+-[A-Za-z0-9_-]{8,}\.([A-Za-z0-9]+)$/;

/**
 * Shared with `app.ts`'s dashboard static handler. Defined here — the module
 * `app.ts` imports `registerWidget` from — so both can import one literal
 * without an import cycle.
 */
export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

function widgetFilesMissing(): TypeError {
  return new TypeError("Widget files are missing");
}

function invalidWidgetOptions(): TypeError {
  return new TypeError("Invalid widget options");
}

export function widgetConfigDocument(targets: readonly StaticTargetConfig[]): WidgetConfigDocument {
  const entries: Record<string, readonly string[]> = {};
  for (const target of targets) {
    if (target.widget !== undefined) entries[target.id] = target.widget.origins;
  }
  return Object.freeze({ targets: Object.freeze(entries) });
}

export function widgetFramePolicy(targets: readonly StaticTargetConfig[]): string {
  const origins = [...new Set(targets.flatMap((target) => target.widget?.origins ?? []))].sort();
  return origins.length === 0 ? FRAME_ANCESTORS_NONE : `frame-ancestors ${origins.join(" ")}`;
}

interface CachedFile {
  readonly body: Buffer;
  readonly etag: string;
}

async function regularFile(path: string): Promise<CachedFile> {
  if (!(await lstat(path)).isFile()) throw widgetFilesMissing();
  const body = await readFile(path);
  return { body, etag: `"${createHash("sha256").update(body).digest("base64url")}"` };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function sendCached(
  request: FastifyRequest,
  reply: FastifyReply,
  file: CachedFile,
  headers: Readonly<Record<string, string>>,
): FastifyReply {
  reply.headers({ ...headers, "cache-control": "no-cache", etag: file.etag });
  if (request.headers["if-none-match"] === file.etag) return reply.code(304).send();
  return reply.send(file.body);
}

export async function registerWidget(
  app: FastifyInstance,
  options: WidgetOptions,
  targets: readonly StaticTargetConfig[],
): Promise<void> {
  if (typeof options.enabled !== "boolean") throw invalidWidgetOptions();
  if (!options.enabled) return;
  if (options.dir === undefined) throw widgetFilesMissing();
  let root: string;
  let panel: CachedFile;
  let loader: CachedFile;
  try {
    root = resolve(options.dir);
    panel = await regularFile(resolve(root, "index.html"));
    loader = await regularFile(resolve(root, "loader.js"));
  } catch {
    throw widgetFilesMissing();
  }

  const framePolicy = widgetFramePolicy(targets);
  const config = JSON.stringify(widgetConfigDocument(targets));

  app.get("/widget/loader.js", (request, reply) => sendCached(request, reply, loader, {
    "content-type": "text/javascript; charset=utf-8",
    "cross-origin-resource-policy": "cross-origin",
    "x-content-type-options": "nosniff",
  }));
  app.get("/widget/", (request, reply) => sendCached(request, reply, panel, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": framePolicy,
  }));
  app.get("/widget/config.json", (_request, reply) => reply
    .header("cache-control", "no-cache")
    .type("application/json; charset=utf-8")
    .send(config));

  const assets = resolve(root, "assets");
  if (await isDirectory(assets)) {
    await app.register(fastifyStatic, {
      root: assets,
      prefix: "/widget/assets/",
      decorateReply: false,
      wildcard: false,
      index: false,
      cacheControl: false,
      setHeaders: (reply, path) => {
        const name = relative(assets, path).split(sep).join("/");
        const hashed = HASHED_ASSET.exec(name);
        reply.header(
          "cache-control",
          hashed !== null && hashed[1]!.toLowerCase() !== "html"
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
        if (name.toLowerCase().endsWith(".html")) {
          reply.header("content-security-policy", FRAME_ANCESTORS_NONE);
        }
      },
    });
  }
}
