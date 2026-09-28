import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  COMPOSE_SMOKE_USAGE,
  createProcessRunner,
  parseDockerEndpoint,
  parseCliPluginDirectories,
  parsePublishedPort,
  runComposeSmoke,
  sanitizedSmokeEnvironment,
} from "../run-compose-smoke.mjs";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "../run-compose-smoke.mjs");

function succeeded(stdout = "") {
  return { status: 0, signal: null, stdout, stderr: "" };
}

function commandKey(command, args) {
  return `${command}\0${args.join("\0")}`;
}

const pluginInventory = JSON.stringify([
  { Name: "compose", Path: "/plugins/docker-compose" },
  { Name: "buildx", Path: "/plugins/docker-buildx" },
]);

async function scratch() {
  return await mkdtemp(join(tmpdir(), "gauntlet-compose-smoke-test-"));
}

test("parses only a local Docker endpoint and one dynamic loopback port", () => {
  assert.equal(parseDockerEndpoint('"unix:///var/run/docker.sock"\n'), "unix:///var/run/docker.sock");
  for (const value of [
    '"tcp://127.0.0.1:2375"\n',
    '"ssh://builder.example"\n',
    '"unix://"\n',
    "not-json\n",
  ]) assert.throws(() => parseDockerEndpoint(value), /local Docker daemon/);

  assert.equal(parsePublishedPort("127.0.0.1:49152\n"), "http://127.0.0.1:49152");
  for (const value of [
    "0.0.0.0:49152\n",
    "[::1]:49152\n",
    "127.0.0.1:0\n",
    "127.0.0.1:65536\n",
    "127.0.0.1:49152\n127.0.0.1:49153\n",
  ]) assert.throws(() => parsePublishedPort(value), /loopback port/);
});

test("admits only absolute Compose and Buildx plugin inventory paths", () => {
  assert.deepEqual(parseCliPluginDirectories(pluginInventory), ["/plugins"]);
  for (const value of [
    "[]",
    JSON.stringify([{ Name: "compose", Path: "relative/docker-compose" }]),
    JSON.stringify([{ Name: "compose", Path: "/plugins/not-compose" }, { Name: "buildx", Path: "/plugins/docker-buildx" }]),
    "not-json",
  ]) assert.throws(() => parseCliPluginDirectories(value), /Docker CLI plugins/);
});

test("scrubs Compose, Gauntlet, registry and cloud credentials", () => {
  const safe = sanitizedSmokeEnvironment({
    PATH: "/safe/bin",
    LANG: "C.UTF-8",
    COMPOSE_FILE: "/hostile.yaml",
    GAUNTLET_IMAGE: "hostile.invalid/latest",
    DOCKER_AUTH_CONFIG: "secret",
    GH_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    NPM_TOKEN: "secret",
    NODE_AUTH_TOKEN: "secret",
    COMPOSER_AUTH: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    KUBECONFIG: "/secret",
    SSH_AUTH_SOCK: "/secret",
    HTTPS_PROXY: "http://user:secret@example.test",
    BUILDX_BUILDER: "remote-builder",
    BUILDX_CONFIG: "/hostile-buildx-config",
    BUILDKIT_HOST: "tcp://remote-builder.invalid:1234",
    DOCKER_BUILDKIT: "1",
  });
  assert.deepEqual(safe, { PATH: "/safe/bin", LANG: "C.UTF-8" });
});

test("CLI accepts only no arguments or fixed help without invoking Docker", () => {
  const help = spawnSync(process.execPath, [runnerPath, "--help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(help.status, 0);
  assert.equal(help.stdout, `${COMPOSE_SMOKE_USAGE}\n`);
  assert.equal(help.stderr, "");

  const invalid = spawnSync(process.execPath, [runnerPath, "--project-name", "shared"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(invalid.status, 64);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, `${COMPOSE_SMOKE_USAGE}\n`);
});

test("runs an isolated UUID project, discovers its dynamic port and always cleans it", async () => {
  const temporaryDirectory = await scratch();
  const calls = [];
  let dockerConfiguration;
  const run = async ({ command, args, environment }) => {
    calls.push({ command, args, environment });
    if (args[0] === "context") return succeeded('"unix:///var/run/docker.sock"\n');
    if (args[0] === "info") return succeeded(pluginInventory);
    if (args.includes("ps")) return succeeded("");
    if (args.includes("port")) return succeeded("127.0.0.1:49152\n");
    return succeeded();
  };

  try {
    await runComposeSmoke({
      repositoryRoot: "/repo",
      temporaryDirectory,
      randomUUID: () => UUID,
      environment: {
        PATH: "/safe/bin",
        COMPOSE_FILE: "/hostile.yaml",
        GAUNTLET_URL: "https://hostile.invalid",
        GH_TOKEN: "secret",
        DOCKER_HOST: "tcp://remote.invalid:2375",
        DOCKER_CONTEXT: "remote-context",
        DOCKER_CERT_PATH: "/secret",
        DOCKER_TLS_VERIFY: "1",
      },
      run,
    });
    dockerConfiguration = JSON.parse(
      await readFile(join(temporaryDirectory, "docker-config/config.json"), "utf8"),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const project = `gauntlet-smoke-${UUID}`;
  const prefix = [
    "compose",
    "--project-name", project,
    "--project-directory", "/repo",
    "-f", "/repo/compose.smoke.yaml",
  ];
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]],
    ["docker", ["info", "--format", "{{json .ClientInfo.Plugins}}"]],
    ["docker", [...prefix, "ps", "--all", "--quiet"]],
    ["docker", [...prefix, "up", "--build", "-d", "--wait"]],
    ["docker", [...prefix, "port", "gauntlet", "8080"]],
    [process.execPath, ["--test", "/repo/conformance/smoke/control-plane.test.mjs"]],
    ["docker", [...prefix, "down", "--volumes", "--remove-orphans", "--rmi", "local"]],
  ]);
  const testEnvironment = calls[5].environment;
  assert.equal(testEnvironment.GAUNTLET_URL, "http://127.0.0.1:49152");
  assert.equal(testEnvironment.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(testEnvironment.DOCKER_CONFIG, join(temporaryDirectory, "docker-config"));
  assert.equal(Object.hasOwn(testEnvironment, "COMPOSE_FILE"), false);
  assert.equal(Object.hasOwn(testEnvironment, "GH_TOKEN"), false);
  assert.equal(Object.hasOwn(testEnvironment, "DOCKER_CONTEXT"), false);
  assert.equal(Object.hasOwn(testEnvironment, "DOCKER_CERT_PATH"), false);
  assert.equal(Object.hasOwn(testEnvironment, "DOCKER_TLS_VERIFY"), false);
  assert.equal(calls[0].environment.DOCKER_CONTEXT, "remote-context");
  assert.deepEqual(dockerConfiguration, { cliPluginsExtraDirs: ["/plugins"] });
});

test("refuses a non-empty project before mutation and does not clean another owner", async () => {
  const temporaryDirectory = await scratch();
  const calls = [];
  try {
    await assert.rejects(
      runComposeSmoke({
        repositoryRoot: "/repo",
        temporaryDirectory,
        randomUUID: () => UUID,
        environment: { PATH: "/safe/bin" },
        run: async ({ command, args }) => {
          calls.push(commandKey(command, args));
          if (args[0] === "context") return succeeded('"unix:///var/run/docker.sock"\n');
          if (args[0] === "info") return succeeded(pluginInventory);
          return succeeded("existing-container-id\n");
        },
      }),
      /project name collision/,
    );
    assert.equal(calls.some((call) => call.includes("\0up\0")), false);
    assert.equal(calls.some((call) => call.includes("\0down\0")), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("reports both a primary failure and a cleanup failure", async () => {
  const temporaryDirectory = await scratch();
  const calls = [];
  try {
    await assert.rejects(
      runComposeSmoke({
        repositoryRoot: "/repo",
        temporaryDirectory,
        randomUUID: () => UUID,
        environment: { PATH: "/safe/bin" },
        run: async ({ args }) => {
          calls.push(args);
          if (args[0] === "context") return succeeded('"unix:///var/run/docker.sock"\n');
          if (args[0] === "info") return succeeded(pluginInventory);
          if (args.includes("ps")) return succeeded();
          if (args.includes("up")) return { ...succeeded(), status: 17, stderr: "up failed\n" };
          if (args.includes("down")) return { ...succeeded(), status: 19, stderr: "down failed\n" };
          return succeeded();
        },
      }),
      (error) => {
        assert.match(String(error), /setup failed/);
        assert.match(String(error), /cleanup also failed/);
        return true;
      },
    );
    assert.equal(calls.at(-1).includes("down"), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("reports diagnostic output from both command streams", async () => {
  const temporaryDirectory = await scratch();
  try {
    await assert.rejects(
      runComposeSmoke({
        repositoryRoot: "/repo",
        temporaryDirectory,
        randomUUID: () => UUID,
        environment: { PATH: "/safe/bin" },
        run: async ({ args }) => {
          if (args[0] === "context") return succeeded('"unix:///var/run/docker.sock"\n');
          if (args[0] === "info") return succeeded(pluginInventory);
          if (args.includes("ps")) return succeeded();
          if (args.includes("up")) {
            return {
              ...succeeded(),
              status: 17,
              stdout: "builder: no space left on device\n",
              stderr: "target gauntlet: failed to solve\n",
            };
          }
          return succeeded();
        },
      }),
      (error) => {
        assert.match(error.message, /target gauntlet: failed to solve/);
        assert.match(error.message, /builder: no space left on device/);
        return true;
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("cleans the owned project before reporting an interrupt", async () => {
  const temporaryDirectory = await scratch();
  const controller = new AbortController();
  const calls = [];
  try {
    await assert.rejects(
      runComposeSmoke({
        repositoryRoot: "/repo",
        temporaryDirectory,
        randomUUID: () => UUID,
        environment: { PATH: "/safe/bin" },
        abortSignal: controller.signal,
        run: async ({ args }) => {
          calls.push(args);
          if (args[0] === "context") return succeeded('"unix:///var/run/docker.sock"\n');
          if (args[0] === "info") return succeeded(pluginInventory);
          if (args.includes("ps")) return succeeded();
          if (args.includes("up")) controller.abort("SIGTERM");
          return succeeded();
        },
      }),
      /interrupted by SIGTERM/,
    );
    assert.equal(calls.at(-1).includes("down"), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("preserves primary signal semantics when interrupt cleanup also fails", async () => {
  const temporaryDirectory = await scratch();
  const controller = new AbortController();
  try {
    await assert.rejects(
      runComposeSmoke({
        repositoryRoot: "/repo",
        temporaryDirectory,
        randomUUID: () => UUID,
        environment: { PATH: "/safe/bin" },
        abortSignal: controller.signal,
        run: async ({ args }) => {
          if (args[0] === "context") return succeeded('"unix:///var/run/docker.sock"\n');
          if (args[0] === "info") return succeeded(pluginInventory);
          if (args.includes("ps")) return succeeded();
          if (args.includes("up")) controller.abort("SIGTERM");
          if (args.includes("down")) return { ...succeeded(), status: 19 };
          return succeeded();
        },
      }),
      (error) => {
        assert.equal(error.signal, "SIGTERM");
        assert.match(error.message, /cleanup also failed/);
        return true;
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("propagates an interrupt received while owned cleanup is running", async () => {
  const temporaryDirectory = await scratch();
  const controller = new AbortController();
  try {
    await assert.rejects(
      runComposeSmoke({
        repositoryRoot: "/repo",
        temporaryDirectory,
        randomUUID: () => UUID,
        environment: { PATH: "/safe/bin" },
        abortSignal: controller.signal,
        run: async ({ args }) => {
          if (args[0] === "context") return succeeded('"unix:///var/run/docker.sock"\n');
          if (args[0] === "info") return succeeded(pluginInventory);
          if (args.includes("ps")) return succeeded();
          if (args.includes("port")) return succeeded("127.0.0.1:49152\n");
          if (args.includes("down")) controller.abort("SIGINT");
          return succeeded();
        },
      }),
      (error) => error.signal === "SIGINT" && /interrupted by SIGINT/.test(error.message),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("applies one overall deadline across setup and still cleans", async () => {
  const temporaryDirectory = await scratch();
  const calls = [];
  try {
    await assert.rejects(
      runComposeSmoke({
        repositoryRoot: "/repo",
        temporaryDirectory,
        randomUUID: () => UUID,
        environment: { PATH: "/safe/bin" },
        overallTimeoutMs: 25,
        run: async ({ args, abortSignal }) => {
          calls.push(args);
          if (args[0] === "context") return succeeded('"unix:///var/run/docker.sock"\n');
          if (args[0] === "info") return succeeded(pluginInventory);
          if (args.includes("ps")) return succeeded();
          if (args.includes("up")) {
            return await new Promise((resolve) => {
              abortSignal.addEventListener("abort", () => resolve(succeeded()), { once: true });
            });
          }
          return succeeded();
        },
      }),
      /overall deadline/,
    );
    assert.equal(calls.at(-1).includes("down"), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the real process runner bounds output and enforces a deadline", async () => {
  const run = createProcessRunner({ maximumOutputBytes: 64, terminationGraceMs: 100 });
  await assert.rejects(
    run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1024))"],
      environment: process.env,
      workingDirectory: process.cwd(),
      timeoutMs: 5_000,
    }),
    /output limit/,
  );
  await assert.rejects(
    run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      environment: process.env,
      workingDirectory: process.cwd(),
      timeoutMs: 50,
    }),
    /deadline/,
  );
});

test("the real process runner rejects an already-aborted signal without spawning", async () => {
  const temporaryDirectory = await scratch();
  const sentinel = join(temporaryDirectory, "spawned");
  const controller = new AbortController();
  controller.abort("SIGTERM");
  const run = createProcessRunner();
  try {
    await assert.rejects(
      run({
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", sentinel],
        environment: process.env,
        workingDirectory: process.cwd(),
        timeoutMs: 5_000,
        abortSignal: controller.signal,
      }),
      (error) => error.signal === "SIGTERM" && /interrupted by SIGTERM/.test(error.message),
    );
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
