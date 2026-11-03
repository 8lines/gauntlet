import {
  createAdapterClient,
  type AdapterClientOptions,
} from "@8lines/gauntlet-dashboard-client";
import {
  assertNonProductionEnvironment,
  type CapabilityId,
  type EnvironmentDescriptor,
  type ProfileId,
} from "@8lines/gauntlet-protocol";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { AUTH_DISABLED, type AuthConfiguration } from "./auth/config.js";
import { registerAuth } from "./auth/index.js";
import { basePathRouting, injectBasePath, parseBasePath } from "./base-path.js";
import { createDataSourceService } from "./data-source-service.js";
import { openDatabase } from "./database.js";
import { registerMcp, validateMcpOptions, type McpOptions } from "./mcp.js";
import { createInMemoryGauntletStore } from "./in-memory-gauntlet-store.js";
import { createManifestService } from "./manifest-service.js";
import {
  configureProblemResponses,
  sendBadUrlProblem,
  sendClientErrorProblem,
} from "./problem-response.js";
import { registerPinRoutes } from "./pin-routes.js";
import { registerRoutes } from "./routes.js";
import { createRunProxyService } from "./run-proxy-service.js";
import { createSqlitePinStore } from "./sqlite-pin-store.js";
import { createStaticTargetProvider } from "./static-target-provider.js";
import { createTargetRegistry } from "./target-registry.js";
import { FRAME_ANCESTORS_NONE, registerWidget, type WidgetOptions } from "./widget.js";

const DEFAULT_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const DASHBOARD_FRAME_POLICY = FRAME_ANCESTORS_NONE;

export interface CreateAppOptions {
  readonly environment: EnvironmentDescriptor;
  readonly targets: unknown;
  readonly fetch?: AdapterClientOptions["fetch"];
  readonly clock?: () => Date;
  readonly supportedProfiles?: readonly ProfileId[];
  readonly supportedCapabilities?: readonly CapabilityId[];
  readonly bodyLimit?: number;
  readonly maxUploadBytes?: number;
  /**
   * URL path prefix every route is served under, such as `/tester`; requests arrive with it.
   * `/health` and `/ready` also answer at the root. Omitted or `""` ⇒ served at the root.
   */
  readonly basePath?: string;
  /** Directory containing the built dashboard. Omitted ⇒ the server exposes the API only. */
  readonly dashboardDir?: string;
  /** Opt-in MCP endpoint sharing the control-plane services and store. */
  readonly mcp?: McpOptions;
  /** Embeddable widget; omitted ⇒ disabled and every /widget path is 404. */
  readonly widget?: WidgetOptions;
  /** Authentication; omitted ⇒ disabled. Any mode other than `none` needs the signing secret. */
  readonly auth?: AuthOptions;
  /**
   * Existing, writable directory for Gauntlet's SQLite database (`gauntlet.sqlite`), which holds
   * pinned operations. Omitted ⇒ the database is in memory and is lost on restart.
   */
  readonly dataDir?: string;
}

export interface AuthOptions {
  readonly configuration: AuthConfiguration;
  /** Decoded `GAUNTLET_AUTH_SECRET`. */
  readonly secret?: Buffer;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  assertNonProductionEnvironment(options.environment);
  const basePath = parseBasePath(options.basePath ?? "");
  const routing = basePathRouting(basePath);
  const mcp = validateMcpOptions(options.mcp ?? { enabled: false });
  const auth = options.auth ?? { configuration: AUTH_DISABLED };
  if (auth.configuration.mode !== "none" && auth.secret === undefined) {
    throw new TypeError("Authentication requires GAUNTLET_AUTH_SECRET");
  }
  const clock = options.clock ?? (() => new Date());
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isSafeInteger(maxUploadBytes)
    || maxUploadBytes <= 0
    || maxUploadBytes > Number.MAX_SAFE_INTEGER - MAX_MULTIPART_OVERHEAD_BYTES) {
    throw new TypeError("maxUploadBytes must be a positive safe integer");
  }
  const targetProvider = createStaticTargetProvider(options.targets);
  const registry = createTargetRegistry([targetProvider]);
  const store = createInMemoryGauntletStore();
  const client = createAdapterClient({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    maxUploadBytes,
  });
  const manifests = createManifestService({
    registry,
    client,
    store,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.supportedProfiles === undefined ? {} : { supportedProfiles: options.supportedProfiles }),
    ...(options.supportedCapabilities === undefined ? {} : { supportedCapabilities: options.supportedCapabilities }),
  });
  const runs = createRunProxyService({
    registry,
    client,
    manifests,
    store,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const database = openDatabase({
    clock,
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
  });

  // Closed by the Fastify onClose hook, or here when composition fails before there is an app to close.
  try {
    const app = Fastify({
      logger: false,
      exposeHeadRoutes: false,
      bodyLimit: options.bodyLimit ?? 1024 * 1024,
      clientErrorHandler: (_error, socket) => sendClientErrorProblem(socket),
      routerOptions: {
        onBadUrl: (_path, _request, response) => sendBadUrlProblem(response),
      },
      ...(routing.rewriteUrl === undefined ? {} : { rewriteUrl: routing.rewriteUrl }),
    });
    routing.install(app);
    app.addHook("onClose", async () => {
      if (database.isOpen) database.close();
    });
    app.addContentTypeParser(
      /^multipart\/form-data(?:\s*;|$)/i,
      { parseAs: "buffer", bodyLimit: maxUploadBytes + MAX_MULTIPART_OVERHEAD_BYTES },
      (_request, body, done) => done(null, body),
    );
    const dashboard = await registerDashboard(app, options.dashboardDir, basePath);
    await registerWidget(app, options.widget ?? { enabled: false }, targetProvider.targets(), basePath);
    configureProblemResponses(app, dashboard === undefined ? {} : { spaFallback: (_request, reply) => dashboard.sendIndex(reply) });
    registerAuth(app, { ...auth, clock, basePath });
    const dataSources = createDataSourceService(client, manifests);
    registerRoutes(app, { dataSources, manifests, runs, maxUploadBytes });
    registerPinRoutes(app, { pins: createSqlitePinStore(database), registry, clock });
    registerMcp(app, { dataSources, manifests, runs, maxUploadBytes }, mcp);
    await app.ready();
    return app;
  } catch (error) {
    if (database.isOpen) database.close();
    throw error;
  }
}

export type { McpOptions } from "./mcp.js";
export type { AuthConfiguration } from "./auth/config.js";
export { createManifestService } from "./manifest-service.js";
export type {
  CompatibleTargetResult,
  ManifestService,
  ManifestServiceOptions,
  RequirementCheck,
  TargetSnapshot,
} from "./manifest-service.js";
export { createStaticTargetProvider, validateStaticTargets } from "./static-target-provider.js";
export type { StaticTargetConfig } from "./static-target-provider.js";
export { createTargetRegistry } from "./target-registry.js";
export type { TargetRegistry } from "./target-registry.js";
export type { TargetProvider } from "./target-provider.js";
export type { WidgetOptions } from "./widget.js";

export interface MountedDashboard {
  /** Sends the dashboard's `index.html`, for `/` and client-side routes. */
  readonly sendIndex: (reply: FastifyReply) => FastifyReply;
}

/**
 * Serves the built dashboard at the root (of the base path) when a directory is given explicitly.
 * Only an omitted directory is a valid API-only mode; an explicitly given directory without a
 * regular index.html file aborts startup with a generic error. Under a base path `index.html` is
 * read once and served with the base path injected (see `injectBasePath`), so one build works
 * under any prefix. Returns the mounted dashboard, or undefined in API-only mode; handling of
 * unmatched paths is added by `configureProblemResponses` so the 404 handler is not duplicated.
 */
export async function registerDashboard(
  app: FastifyInstance,
  directory: string | undefined,
  basePath = "",
): Promise<MountedDashboard | undefined> {
  if (directory === undefined) return undefined;
  let root: string;
  let index: string | undefined;
  try {
    root = resolve(directory);
    const indexPath = resolve(root, "index.html");
    if (!(await lstat(indexPath)).isFile()) {
      throw new TypeError("Dashboard index is missing");
    }
    if (basePath !== "") index = injectBasePath(await readFile(indexPath, "utf8"), basePath, { baseHref: true });
  } catch {
    throw new TypeError("Dashboard index is missing");
  }

  await app.register(fastifyStatic, {
    root,
    index: index === undefined ? ["index.html"] : false,
    wildcard: false,
    cacheControl: false,
    globIgnore: [
      "mcp",
      "mcp/**",
      "api",
      "api/**",
      "health",
      "health/**",
      "ready",
      "ready/**",
      "widget",
      "widget/**",
      "assets/index.html",
      ...(index === undefined ? [] : ["index.html"]),
    ],
    allowedPath: (pathname) => !isControlPlaneStaticPath(pathname),
    setHeaders: (reply, path) => {
      const normalized = relative(root, path).split(sep).join("/");
      const hashedAsset = /^assets\/.+-[A-Za-z0-9_-]{8,}\.([A-Za-z0-9]+)$/.exec(normalized);
      reply.header(
        "cache-control",
        hashedAsset !== null && hashedAsset[1]!.toLowerCase() !== "html"
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
      if (normalized.toLowerCase().endsWith(".html")) {
        reply.header("content-security-policy", DASHBOARD_FRAME_POLICY);
      }
    },
  });

  if (index === undefined) {
    return {
      sendIndex: (reply) => reply.header("content-security-policy", DASHBOARD_FRAME_POLICY).sendFile("index.html"),
    };
  }
  const body = index;
  const sendIndex = (reply: FastifyReply): FastifyReply => reply
    .header("cache-control", "no-cache")
    .header("content-security-policy", DASHBOARD_FRAME_POLICY)
    .type("text/html; charset=utf-8")
    .send(body);
  app.get("/", (_request, reply) => sendIndex(reply));
  app.get("/index.html", (_request, reply) => sendIndex(reply));
  return { sendIndex };
}

function isControlPlaneStaticPath(pathname: string): boolean {
  return pathname === "/mcp"
    || pathname.startsWith("/mcp/")
    || pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/health"
    || pathname.startsWith("/health/")
    || pathname === "/ready"
    || pathname.startsWith("/ready/")
    || pathname === "/widget"
    || pathname.startsWith("/widget/");
}
