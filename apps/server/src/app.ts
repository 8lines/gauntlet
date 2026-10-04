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
import { lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { AUTH_DISABLED, type AuthConfiguration } from "./auth/config.js";
import { createDataSourceService } from "./data-source-service.js";
import { registerMcp, validateMcpOptions, type McpOptions } from "./mcp.js";
import { createInMemoryGauntletStore } from "./in-memory-gauntlet-store.js";
import { createManifestService } from "./manifest-service.js";
import {
  configureProblemResponses,
  sendBadUrlProblem,
  sendClientErrorProblem,
} from "./problem-response.js";
import { registerRoutes } from "./routes.js";
import { createRunProxyService } from "./run-proxy-service.js";
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
  /** Directory containing the built dashboard. Omitted ⇒ the server exposes the API only. */
  readonly dashboardDir?: string;
  /** Opt-in MCP endpoint sharing the control-plane services and store. */
  readonly mcp?: McpOptions;
  /** Embeddable widget; omitted ⇒ disabled and every /widget path is 404. */
  readonly widget?: WidgetOptions;
  /** Authentication; omitted ⇒ disabled. Any mode other than `none` needs the signing secret. */
  readonly auth?: AuthOptions;
}

export interface AuthOptions {
  readonly configuration: AuthConfiguration;
  /** Decoded `GAUNTLET_AUTH_SECRET`. */
  readonly secret?: Buffer;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  assertNonProductionEnvironment(options.environment);
  const mcp = validateMcpOptions(options.mcp ?? { enabled: false });
  const auth = options.auth ?? { configuration: AUTH_DISABLED };
  if (auth.configuration.mode !== "none" && auth.secret === undefined) {
    throw new TypeError("Authentication requires GAUNTLET_AUTH_SECRET");
  }
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

  const app = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    clientErrorHandler: (_error, socket) => sendClientErrorProblem(socket),
    routerOptions: {
      onBadUrl: (_path, _request, response) => sendBadUrlProblem(response),
    },
  });
  app.addContentTypeParser(
    /^multipart\/form-data(?:\s*;|$)/i,
    { parseAs: "buffer", bodyLimit: maxUploadBytes + MAX_MULTIPART_OVERHEAD_BYTES },
    (_request, body, done) => done(null, body),
  );
  const dashboard = await registerDashboard(app, options.dashboardDir);
  await registerWidget(app, options.widget ?? { enabled: false }, targetProvider.targets());
  configureProblemResponses(app, dashboard ? { spaFallback: (_request, reply) => reply.header("content-security-policy", DASHBOARD_FRAME_POLICY).sendFile("index.html") } : {});
  const dataSources = createDataSourceService(client, manifests);
  registerRoutes(app, { dataSources, manifests, runs, maxUploadBytes });
  registerMcp(app, { dataSources, manifests, runs, maxUploadBytes }, mcp);
  await app.ready();
  return app;
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

/**
 * Serves the built dashboard at the root when a directory is given explicitly.
 * Only an omitted directory is a valid API-only mode; an explicitly given
 * directory without a regular index.html file aborts startup with a generic error.
 * Returns whether the dashboard was mounted; handling of unmatched paths is
 * added by `configureProblemResponses` so the 404 handler is not duplicated.
 */
export async function registerDashboard(app: FastifyInstance, directory: string | undefined): Promise<boolean> {
  if (directory === undefined) return false;
  let root: string;
  try {
    root = resolve(directory);
    if (!(await lstat(resolve(root, "index.html"))).isFile()) {
      throw new TypeError("Dashboard index is missing");
    }
  } catch {
    throw new TypeError("Dashboard index is missing");
  }

  await app.register(fastifyStatic, {
    root,
    index: ["index.html"],
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
  return true;
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
