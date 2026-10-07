import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { decodeAuthSecret } from "./auth/secret.js";
import { validateMcpOptions, type McpOptions } from "./mcp.js";
import { loadServerConfiguration } from "./config.js";

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

export interface ConfiguredAppDependencies {
  readonly readConfig?: (path: string) => Promise<Uint8Array>;
}

function environmentConfigurationError(): TypeError {
  return new TypeError("Invalid server environment configuration");
}

function ownEnvironmentString(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (descriptor === undefined) return undefined;
    if (!descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw environmentConfigurationError();
    }
    return descriptor.value;
  } catch {
    throw environmentConfigurationError();
  }
}

export function listenAddress(environment: Readonly<Record<string, string | undefined>>): ListenAddress {
  const host = ownEnvironmentString(environment, "GAUNTLET_HOST") ?? "0.0.0.0";
  const rawPort = ownEnvironmentString(environment, "GAUNTLET_PORT") ?? "8080";
  if (host.trim().length === 0 || !/^[0-9]+$/.test(rawPort)) {
    throw new TypeError("Invalid server listen configuration");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Invalid server listen configuration");
  }
  return Object.freeze({ host, port });
}

export function mcpConfiguration(environment: Readonly<Record<string, string | undefined>>): McpOptions {
  const enabled = ownEnvironmentString(environment, "GAUNTLET_MCP_ENABLED");
  const origins = ownEnvironmentString(environment, "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON");
  if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
    throw new TypeError("Invalid MCP configuration");
  }
  try {
    return validateMcpOptions({
      enabled: enabled === "true",
      ...(origins === undefined ? {} : { allowedOrigins: JSON.parse(origins) }),
    });
  } catch {
    throw new TypeError("Invalid MCP configuration");
  }
}

let authDisabledWarningEmitted = false;

function emitAuthDisabledWarning(): void {
  if (authDisabledWarningEmitted) return;
  authDisabledWarningEmitted = true;
  try {
    process.emitWarning("Gauntlet authentication is disabled; keep it behind a private network boundary", {
      code: "GAUNTLET_AUTH_DISABLED",
    });
  } catch {
    // A warning transport must not change startup.
  }
}

let dataEphemeralWarningEmitted = false;

function emitDataEphemeralWarning(): void {
  if (dataEphemeralWarningEmitted) return;
  dataEphemeralWarningEmitted = true;
  try {
    process.emitWarning("GAUNTLET_DATA_DIR is not set; pinned operations are kept in memory and lost on restart", {
      code: "GAUNTLET_DATA_EPHEMERAL",
    });
  } catch {
    // A warning transport must not change startup.
  }
}

/** Decoded `GAUNTLET_AUTH_SECRET`, or undefined when unset. */
export function authSecret(environment: Readonly<Record<string, string | undefined>>): Buffer | undefined {
  const value = ownEnvironmentString(environment, "GAUNTLET_AUTH_SECRET");
  return value === undefined ? undefined : decodeAuthSecret(value);
}

export async function createConfiguredApp(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: ConfiguredAppDependencies = {},
): Promise<FastifyInstance> {
  const configuration = await loadServerConfiguration(environment, dependencies.readConfig ?? readFile);
  const dashboardDir = ownEnvironmentString(environment, "GAUNTLET_DASHBOARD_DIR");
  const widgetDir = ownEnvironmentString(environment, "GAUNTLET_WIDGET_DIR");
  const dataDir = ownEnvironmentString(environment, "GAUNTLET_DATA_DIR");
  const secret = configuration.auth.mode === "none" ? undefined : authSecret(environment);
  if (configuration.auth.mode === "none") emitAuthDisabledWarning();
  if (dataDir === undefined) emitDataEphemeralWarning();
  return await createApp({
    auth: { configuration: configuration.auth, ...(secret === undefined ? {} : { secret }) },
    environment: configuration.instance.environment,
    targets: configuration.targets,
    mcp: mcpConfiguration(environment),
    widget: {
      enabled: configuration.widget.enabled,
      ...(widgetDir === undefined ? {} : { dir: widgetDir }),
    },
    ...(dashboardDir === undefined ? {} : { dashboardDir }),
    ...(dataDir === undefined ? {} : { dataDir }),
  });
}

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  let app: FastifyInstance | undefined;
  try {
    app = await createConfiguredApp(environment);
    const address = listenAddress(environment);
    await app.listen({ host: address.host, port: address.port });
  } catch (error) {
    if (app !== undefined) {
      try {
        await app.close();
      } catch {
        // Preserve the generic startup failure and avoid exposing server internals.
      }
    }
    throw error;
  }

  const close = async (): Promise<void> => {
    await app!.close();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try {
    await main();
  } catch {
    process.stderr.write("Gauntlet server failed to start\n");
    process.exitCode = 1;
  }
}
