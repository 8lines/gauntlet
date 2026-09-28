import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runBoundedChild } from "../support/child-process.js";

const scenarioPath = fileURLToPath(new URL("../../../scenarios/adapter-v1.json", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

test("built CLI targets retain executable package modes", () => {
  if (process.platform === "win32") return;
  for (const filename of ["cli.js", "extended-cli.js", "fixture-adapter.js"]) {
    assert.equal(statSync(new URL(`../../dist/${filename}`, import.meta.url)).mode & 0o111, 0o111);
  }
});

async function startBuiltFixture(): Promise<{
  readonly origin: string;
  readonly child: ChildProcessWithoutNullStreams;
  stop(): Promise<{ readonly status: number | null; readonly stderr: string }>;
}> {
  const child = spawn(process.execPath, [
    "dist/fixture-adapter.js",
    "--scenario",
    scenarioPath,
    "--port",
    "0",
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 1024 * 1024) child.kill("SIGKILL");
  });
  const origin = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("built fixture did not announce within five seconds"));
    }, 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        clearTimeout(deadline);
        child.kill("SIGKILL");
        reject(new Error("built fixture stdout exceeded one MiB"));
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(deadline);
        const line = stdout.slice(0, newline);
        if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(line) || stdout !== `${line}\n`) {
          reject(new Error("built fixture emitted an invalid announcement"));
          return;
        }
        resolve(line);
      }
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("exit", (status) => {
      clearTimeout(deadline);
      reject(new Error(`built fixture exited before listening (${String(status)})`));
    });
  });

  return {
    origin,
    child,
    async stop() {
      const closed = new Promise<{ status: number | null }>((resolve) => {
        child.once("close", (status) => resolve({ status }));
      });
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      const result = await closed;
      clearTimeout(killer);
      return { ...result, stderr };
    },
  };
}

test("built package API, both bin targets, and the positive root wrapper share one finite fixture", async () => {
  const api = await import("@8lines/gauntlet-conformance-runner");
  assert.deepEqual(Object.keys(api).sort(), [
    "loadAdapterV1ExtendedScenario",
    "loadAdapterV1Scenario",
    "runAdapterV1Conformance",
    "runAdapterV1ExtendedConformance",
  ]);

  const fixture = await startBuiltFixture();
  try {
    const scenario = await api.loadAdapterV1Scenario(scenarioPath);
    await api.runAdapterV1Conformance({ baseUrl: fixture.origin, scenario, pollIntervalMs: 1 });

    const builtRunner = await runBoundedChild({
      command: process.execPath,
      arguments: [
        "dist/cli.js",
        "--base-url",
        fixture.origin,
        "--scenario",
        scenarioPath,
      ],
      cwd: process.cwd(),
    });
    assert.equal(builtRunner.status, 0);
    assert.equal(builtRunner.stdout, "");
    assert.equal(builtRunner.stderr, "");

    const rootWrapper = await runBoundedChild({
      command: "pnpm",
      arguments: ["--silent", "conformance:adapter-v1"],
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GAUNTLET_ADAPTER_URL: fixture.origin,
        GAUNTLET_SCENARIO: scenarioPath,
      },
    });
    assert.equal(rootWrapper.status, 0);
    assert.equal(rootWrapper.signal, null);
    assert.equal(rootWrapper.timedOut, false);
    assert.equal(rootWrapper.stdout, "");
    assert.equal(rootWrapper.stderr, "");
  } finally {
    const stopped = await fixture.stop();
    assert.equal(stopped.status, 0);
    assert.equal(stopped.stderr, "");
  }
});
