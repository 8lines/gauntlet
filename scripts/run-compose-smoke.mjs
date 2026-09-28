import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
export const COMPOSE_SMOKE_USAGE = "Usage: pnpm smoke:compose [--help]";

function commandError(message, result) {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return new Error(detail.length === 0 ? message : `${message}: ${detail}`);
}

function interruption(abortSignal) {
  if (!abortSignal?.aborted) return undefined;
  const signal = typeof abortSignal.reason === "string" ? abortSignal.reason : "signal";
  const error = new Error(`Compose smoke interrupted by ${signal}`);
  error.signal = signal;
  return error;
}

export function sanitizedSmokeEnvironment(source) {
  const safe = {};
  const forbidden = /^(?:COMPOSE_|GAUNTLET_|BUILDX_|BUILDKIT_|DOCKER_AUTH_CONFIG$|DOCKER_BUILDKIT$|GH_|GITHUB_|NPM_|NODE_AUTH_TOKEN$|COMPOSER_AUTH$|AWS_|AZURE_|GOOGLE_|GCLOUD_|KUBE|SSH_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)|(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)$/i;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && !forbidden.test(key)) safe[key] = value;
  }
  return safe;
}

export function parseDockerEndpoint(output) {
  let endpoint;
  try {
    endpoint = JSON.parse(output.trim());
  } catch {
    throw new Error("Compose smoke requires a local Docker daemon");
  }
  if (typeof endpoint !== "string" || !/^unix:\/\/\/[^\u0000-\u0020\u007f]+$/.test(endpoint)) {
    throw new Error("Compose smoke requires a local Docker daemon");
  }
  return endpoint;
}

export function parseCliPluginDirectories(output) {
  let plugins;
  try {
    plugins = JSON.parse(output.trim());
  } catch {
    throw new Error("Compose smoke requires local Docker CLI plugins");
  }
  if (!Array.isArray(plugins)) throw new Error("Compose smoke requires local Docker CLI plugins");
  const directories = new Set();
  for (const name of ["compose", "buildx"]) {
    const matching = plugins.filter((plugin) => plugin !== null && typeof plugin === "object"
      && plugin.Name === name && typeof plugin.Path === "string");
    if (matching.length !== 1) throw new Error("Compose smoke requires local Docker CLI plugins");
    const path = matching[0].Path;
    if (!isAbsolute(path) || resolve(path) !== path || path !== join(dirname(path), `docker-${name}`)
        || /[\u0000-\u0020\u007f]/.test(path)) {
      throw new Error("Compose smoke requires local Docker CLI plugins");
    }
    directories.add(dirname(path));
  }
  return [...directories].sort();
}

export function parsePublishedPort(output) {
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})\r?\n?$/.exec(output);
  const port = match === null ? 0 : Number(match[1]);
  if (port < 1 || port > 65_535) {
    throw new Error("Compose smoke requires one dynamic loopback port");
  }
  return `http://127.0.0.1:${port}`;
}

export function createProcessRunner({
  maximumOutputBytes = DEFAULT_OUTPUT_LIMIT,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
} = {}) {
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new TypeError("Process runner limits must be positive integers");
  }

  return async function run({ command, args, environment, workingDirectory, timeoutMs, abortSignal }) {
    const alreadyInterrupted = interruption(abortSignal);
    if (alreadyInterrupted !== undefined) throw alreadyInterrupted;
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        cwd: workingDirectory,
        env: environment,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let failure;
      let killTimer;

      const terminate = (error) => {
        if (failure !== undefined) return;
        failure = error;
        try {
          if (process.platform === "win32") child.kill("SIGTERM");
          else process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        killTimer = setTimeout(() => {
          try {
            if (process.platform === "win32") child.kill("SIGKILL");
            else process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, terminationGraceMs);
        killTimer.unref();
      };

      const append = (current, chunk) => {
        const next = Buffer.concat([current, chunk]);
        if (stdout.length + stderr.length + chunk.length > maximumOutputBytes) {
          terminate(new Error("Smoke command output limit exceeded"));
        }
        return next.subarray(0, maximumOutputBytes);
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });

      const deadline = setTimeout(
        () => terminate(new Error("Smoke command deadline exceeded")),
        timeoutMs,
      );
      deadline.unref();
      const onAbort = () => terminate(interruption(abortSignal));
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.once("error", (error) => terminate(new Error("Smoke command could not start", { cause: error })));
      child.once("close", (status, signal) => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        abortSignal?.removeEventListener("abort", onAbort);
        if (failure !== undefined) {
          rejectPromise(failure);
          return;
        }
        resolvePromise({
          status,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        });
      });
    });
  };
}

export async function runComposeSmoke({
  repositoryRoot,
  temporaryDirectory,
  randomUUID: makeUUID = randomUUID,
  environment = process.env,
  run = createProcessRunner(),
  abortSignal,
  overallTimeoutMs = 10 * 60_000,
}) {
  if (!isAbsolute(repositoryRoot) || !isAbsolute(temporaryDirectory)) {
    throw new TypeError("Compose smoke paths must be absolute");
  }
  const uuid = makeUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
    throw new TypeError("Compose smoke requires a UUID v4 project owner");
  }
  const project = `gauntlet-smoke-${uuid}`;
  const composeFile = join(repositoryRoot, "compose.smoke.yaml");
  const testFile = join(repositoryRoot, "conformance/smoke/control-plane.test.mjs");
  const dockerConfig = join(temporaryDirectory, "docker-config");
  await mkdir(dockerConfig, { recursive: false, mode: 0o700 });

  if (!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs < 1) {
    throw new TypeError("Compose smoke overall deadline must be a positive integer");
  }
  const deadlineController = new AbortController();
  const overallDeadline = setTimeout(
    () => deadlineController.abort("overall deadline"),
    overallTimeoutMs,
  );
  overallDeadline.unref();
  const activeAbortSignal = abortSignal === undefined
    ? deadlineController.signal
    : AbortSignal.any([abortSignal, deadlineController.signal]);

  try {
  const baseEnvironment = sanitizedSmokeEnvironment(environment);
  const invoke = async (command, args, phase, phaseEnvironment, allowInterrupted = false) => {
    const result = await run({
      command,
      args,
      environment: phaseEnvironment,
      workingDirectory: repositoryRoot,
      timeoutMs: phase === "test" ? 30_000 : 300_000,
      abortSignal: allowInterrupted ? undefined : activeAbortSignal,
    });
    if (result.status !== 0) throw commandError(`Compose smoke ${phase} failed`, result);
    const interrupted = interruption(activeAbortSignal);
    if (!allowInterrupted && interrupted !== undefined) throw interrupted;
    return result;
  };

  const context = await invoke(
    "docker",
    ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
    "Docker context inspection",
    baseEnvironment,
  );
  const dockerHost = parseDockerEndpoint(context.stdout);
  const {
    DOCKER_CONTEXT: _dockerContext,
    DOCKER_CERT_PATH: _dockerCertPath,
    DOCKER_TLS_VERIFY: _dockerTlsVerify,
    DOCKER_CONFIG: _dockerConfig,
    DOCKER_HOST: _dockerHost,
    ...postDiscoveryEnvironment
  } = baseEnvironment;
  const pluginEnvironment = { ...postDiscoveryEnvironment, DOCKER_HOST: dockerHost };
  const pluginInventory = await invoke(
    "docker",
    ["info", "--format", "{{json .ClientInfo.Plugins}}"],
    "Docker plugin inspection",
    pluginEnvironment,
  );
  const cliPluginsExtraDirs = parseCliPluginDirectories(pluginInventory.stdout);
  await writeFile(
    join(dockerConfig, "config.json"),
    `${JSON.stringify({ cliPluginsExtraDirs })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  const dockerEnvironment = {
    ...postDiscoveryEnvironment,
    DOCKER_CONFIG: dockerConfig,
    DOCKER_HOST: dockerHost,
  };
  const prefix = [
    "compose",
    "--project-name", project,
    "--project-directory", repositoryRoot,
    "-f", composeFile,
  ];

  const existing = await invoke(
    "docker",
    [...prefix, "ps", "--all", "--quiet"],
    "ownership check",
    dockerEnvironment,
  );
  if (existing.stdout.trim().length !== 0) {
    throw new Error("Compose smoke project name collision");
  }

  let primaryFailure;
  let cleanupFailure;
  try {
    await invoke("docker", [...prefix, "up", "--build", "-d", "--wait"], "setup", dockerEnvironment);
    const published = await invoke(
      "docker",
      [...prefix, "port", "gauntlet", "8080"],
      "port discovery",
      dockerEnvironment,
    );
    const origin = parsePublishedPort(published.stdout);
    await invoke(
      process.execPath,
      ["--test", testFile],
      "test",
      { ...dockerEnvironment, GAUNTLET_URL: origin },
    );
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      await invoke(
        "docker",
        [...prefix, "down", "--volumes", "--remove-orphans", "--rmi", "local"],
        "cleanup",
        dockerEnvironment,
        true,
      );
    } catch (error) {
      cleanupFailure = error;
    }
  }

  const lateInterruption = interruption(activeAbortSignal);
  if (lateInterruption !== undefined && primaryFailure === undefined) {
    primaryFailure = lateInterruption;
  }

  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    const combined = new AggregateError(
      [primaryFailure, cleanupFailure],
      `${primaryFailure.message}; cleanup also failed: ${cleanupFailure.message}`,
    );
    if (primaryFailure?.signal !== undefined) combined.signal = primaryFailure.signal;
    throw combined;
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  } finally {
    clearTimeout(overallDeadline);
  }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write(`${COMPOSE_SMOKE_USAGE}\n`);
    return;
  }
  if (process.argv.length !== 2) {
    process.stderr.write(`${COMPOSE_SMOKE_USAGE}\n`);
    process.exitCode = 64;
    return;
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "gauntlet-compose-smoke-"));
  const controller = new AbortController();
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => controller.abort(signal);
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  let propagatedSignal;
  try {
    await runComposeSmoke({ repositoryRoot, temporaryDirectory, abortSignal: controller.signal });
  } catch (error) {
    propagatedSignal = error?.signal;
    if (propagatedSignal === undefined) throw error;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  if (propagatedSignal !== undefined) process.kill(process.pid, propagatedSignal);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Compose smoke failed"}\n`);
    process.exitCode = 1;
  });
}
