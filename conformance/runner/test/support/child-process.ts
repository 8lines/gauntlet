import { spawn } from "node:child_process";

const STREAM_CAP = 1024 * 1024;

export interface ChildResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export async function runBoundedChild(options: {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly deadlineMs?: number;
  readonly graceMs?: number;
}): Promise<ChildResult> {
  const child = spawn(options.command, options.arguments, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let overflow: Error | undefined;

  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    const current = stream === "stdout" ? stdout : stderr;
    const next = Buffer.concat([current, chunk]);
    if (next.byteLength > STREAM_CAP) {
      overflow = new Error(`${stream} exceeded one MiB`);
      child.kill("SIGKILL");
      return;
    }
    if (stream === "stdout") stdout = next;
    else stderr = next;
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), options.graceMs ?? 2_000);
    killTimer.unref();
  }, options.deadlineMs ?? 30_000);
  let killTimer: NodeJS.Timeout | undefined;
  deadline.unref();

  const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(deadline);
  if (killTimer !== undefined) clearTimeout(killTimer);
  if (overflow !== undefined) throw overflow;
  return {
    ...result,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    timedOut,
  };
}
