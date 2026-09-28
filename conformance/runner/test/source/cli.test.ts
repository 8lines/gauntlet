import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFixtureAdapter } from "../../src/fixture-adapter.js";
import { loadAdapterV1Scenario } from "../../src/scenario.js";
import { runBoundedChild } from "../support/child-process.js";

const scenarioUrl = new URL("../../../scenarios/adapter-v1.json", import.meta.url);
const scenarioPath = scenarioUrl.pathname;
const usage = "Usage: gauntlet-conformance --base-url ABSOLUTE_HTTP_ORIGIN --scenario PATH\n";

function sourceArguments(file: "cli" | "env-cli" | "fixture-adapter", arguments_: readonly string[]): readonly string[] {
  return ["--import", "tsx", `src/${file}.ts`, ...arguments_];
}

async function sourceChild(
  file: "cli" | "env-cli" | "fixture-adapter",
  arguments_: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  deadlineMs = 30_000,
) {
  return await runBoundedChild({
    command: process.execPath,
    arguments: sourceArguments(file, arguments_),
    cwd: process.cwd(),
    env,
    deadlineMs,
  });
}

test("the source runner CLI succeeds silently in either exact flag order", async () => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  for (const reverse of [false, true]) {
    const fixture = await startFixtureAdapter({ scenario });
    try {
      const flags = reverse
        ? ["--scenario", scenarioPath, "--base-url", fixture.baseUrl]
        : ["--base-url", fixture.baseUrl, "--scenario", scenarioPath];
      const result = await sourceChild("cli", flags);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(result.timedOut, false);
    } finally {
      await fixture.close();
    }
  }
});

test("every runner flag grammar failure is exact usage with exit 2 and no stdout", async () => {
  const cases = [
    [],
    ["--base-url", "http://example.test"],
    ["--scenario", scenarioPath],
    ["--unknown", "value", "--scenario", scenarioPath],
    ["--base-url=http://example.test", "--scenario", scenarioPath],
    ["--base-url", "http://example.test", "--base-url", "http://example.test", "--scenario", scenarioPath],
    ["--base-url", "http://example.test", "--scenario", scenarioPath, "positional"],
  ];
  for (const arguments_ of cases) {
    const result = await sourceChild("cli", arguments_);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, usage);
  }
});

test("a symlinked runner bin still executes while ordinary imports stay side-effect free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc-bin-link-"));
  const link = join(directory, "gauntlet-conformance.ts");
  try {
    await symlink(join(process.cwd(), "src/cli.ts"), link);
    const result = await runBoundedChild({
      command: process.execPath,
      arguments: ["--import", "tsx", link],
      cwd: process.cwd(),
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, usage);

    const imported = await import("../../src/cli.js");
    assert.equal(typeof imported.executeConformanceCli, "function");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-grammar configuration failures are fixed, caller-value-free, and exit 2", async () => {
  const privateUrl = "https://user:password@example.test/private";
  const result = await sourceChild("cli", [
    "--base-url",
    privateUrl,
    "--scenario",
    scenarioPath,
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Conformance configuration failed\n");
  assert.doesNotMatch(result.stderr, /password|private/);
});

test("malformed terminal failures name the canonical schema and /problem with exit 1", async () => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario, mode: "invalid-terminal" });
  try {
    const result = await sourceChild("cli", [
      "--base-url",
      fixture.baseUrl,
      "--scenario",
      scenarioPath,
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /run\.schema\.json.*\/problem\n$/);
    assert.equal(result.stderr.split("\n").length, 2);
  } finally {
    await fixture.close();
  }
});

test("malicious secret echo exits 1 while both captured streams remain sentinel-free", async () => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario, mode: "secret-echo" });
  try {
    const result = await sourceChild("cli", [
      "--base-url",
      fixture.baseUrl,
      "--scenario",
      scenarioPath,
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stdout, /731904/);
    assert.doesNotMatch(result.stderr, /731904/);
    assert.match(result.stderr, /protected secret/i);
  } finally {
    await fixture.close();
  }
});

test("the environment wrapper rejects arguments and names only the first missing variable", async () => {
  const withoutBoth = { ...process.env };
  delete withoutBoth.GAUNTLET_ADAPTER_URL;
  delete withoutBoth.GAUNTLET_SCENARIO;
  const missingAdapter = await sourceChild("env-cli", [], withoutBoth);
  assert.equal(missingAdapter.status, 2);
  assert.equal(missingAdapter.stdout, "");
  assert.equal(missingAdapter.stderr, "Missing GAUNTLET_ADAPTER_URL\n");

  const missingScenarioEnvironment = { ...withoutBoth, GAUNTLET_ADAPTER_URL: "http://127.0.0.1:1" };
  const missingScenario = await sourceChild("env-cli", [], missingScenarioEnvironment);
  assert.equal(missingScenario.status, 2);
  assert.equal(missingScenario.stderr, "Missing GAUNTLET_SCENARIO\n");

  const argumentsRejected = await sourceChild("env-cli", ["unexpected"], process.env);
  assert.equal(argumentsRejected.status, 2);
  assert.equal(argumentsRejected.stdout, "");
  assert.equal(argumentsRejected.stderr, "Environment conformance runner accepts no arguments\n");
});

test("fixture source bin rejects every malformed grammar and reports occupied-port startup as exit 1", async (t) => {
  const malformed = [
    [],
    ["--scenario", scenarioPath, "--mode", "async-success"],
    ["--scenario", scenarioPath, "--host", "0.0.0.0"],
    ["--scenario", scenarioPath, "--port", "65536"],
    ["--scenario", scenarioPath, "--port=0"],
    ["--scenario", scenarioPath, "--scenario", scenarioPath],
    ["--scenario", scenarioPath, "positional"],
  ];
  for (const arguments_ of malformed) {
    const result = await sourceChild("fixture-adapter", arguments_);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Fixture configuration failed\n");
  }

  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => blocker.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const address = blocker.address();
  assert.ok(address !== null && typeof address !== "string");
  const startup = await sourceChild("fixture-adapter", [
    "--scenario",
    scenarioPath,
    "--port",
    String(address.port),
  ]);
  assert.equal(startup.status, 1);
  assert.equal(startup.stdout, "");
  assert.equal(startup.stderr, "Fixture failed\n");
});

test("the bounded child harness terminates a stalled process within its grace policy", async () => {
  const result = await runBoundedChild({
    command: process.execPath,
    arguments: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    deadlineMs: 25,
    graceMs: 50,
  });
  assert.equal(result.timedOut, true);
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");

  const ignoresTerm = await runBoundedChild({
    command: process.execPath,
    arguments: [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ],
    cwd: process.cwd(),
    // Give the child enough time to install its signal handler. A deadline
    // shorter than Node startup races SIGTERM against script evaluation and
    // sometimes tests the default OS disposition instead of escalation.
    deadlineMs: 500,
    graceMs: 50,
  });
  assert.equal(ignoresTerm.timedOut, true);
  assert.equal(ignoresTerm.stdout, "ready\n");
  assert.equal(ignoresTerm.signal, "SIGKILL");
});
