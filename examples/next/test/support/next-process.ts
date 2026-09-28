import { spawn, type ChildProcess } from "node:child_process";

const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const START_SCRIPT = [
  'import { startServer } from "next/dist/server/lib/start-server.js";',
  "await startServer({",
  "  dir: process.cwd(),",
  "  isDev: false,",
  '  hostname: "127.0.0.1",',
  "  port: 0,",
  "});",
].join("\n");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

export function findLoopbackBaseUrl(output: string): string | undefined {
  const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
  return match?.[1] === undefined ? undefined : `http://127.0.0.1:${match[1]}`;
}

export function createStartupUrlDetector(): (
  source: "stdout" | "stderr",
  chunk: string,
) => string | undefined {
  const windows = { stdout: "", stderr: "" };
  return (source, chunk) => {
    windows[source] = `${windows[source]}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
    return findLoopbackBaseUrl(windows[source]);
  };
}

export interface NextFixtureProcess {
  readonly url: string;
  close(): Promise<void>;
}

export async function startNextFixture(enabled: boolean): Promise<NextFixtureProcess> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", START_SCRIPT], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, GAUNTLET_ENABLED: String(enabled) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let diagnostics = "";
  let baseUrl: string | undefined;
  const detectUrl = createStartupUrlDetector();
  const capture = (source: "stdout" | "stderr") => (chunk: string): void => {
    diagnostics = `${diagnostics}[${source}] ${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
    baseUrl ??= detectUrl(source, chunk);
  };
  const captureStdout = capture("stdout");
  const captureStderr = capture("stderr");
  child.stdout.on("data", captureStdout);
  child.stderr.on("data", captureStderr);
  const discardOutput = (): void => {
    child.stdout.off("data", captureStdout);
    child.stderr.off("data", captureStderr);
    child.stdout.resume();
    child.stderr.resume();
  };

  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (await Promise.race([
      exited(child).then(() => true),
      delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
    ])) return;
    child.kill("SIGKILL");
    await exited(child);
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Next exited during startup (code=${String(child.exitCode)}, signal=${String(child.signalCode)}).\n${diagnostics}`,
        );
      }
      if (baseUrl !== undefined) {
        try {
          const response = await fetch(`${baseUrl}/host-health`, {
            signal: AbortSignal.timeout(500),
          });
          if (response.status === 200) {
            discardOutput();
            return { url: baseUrl, close };
          }
        } catch {
          // The process has bound its collision-free port but is not accepting requests yet.
        }
      }
      await delay(50);
    }
    throw new Error(`Next did not become ready within ${STARTUP_TIMEOUT_MS}ms.\n${diagnostics}`);
  } catch (error) {
    await close();
    throw error;
  }
}
