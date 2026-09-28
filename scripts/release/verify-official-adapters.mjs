#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const USAGE = "Usage: node scripts/release/verify-official-adapters.mjs";
const PHP_IMAGE = "php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4";
const GRADLE_IMAGE = "docker.io/library/gradle:9.2.1-jdk21@sha256:f1d5be114f4f16e780eee51a942449eaa98808887dddd5da4a5b608971c90aa4";
const NODE_IMAGE = "docker.io/library/node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf";
const MAX_CAPTURE_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 60_000;
const MAX_CONTEXT_FILES = 4_096;
const MAX_CONTEXT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 96 * 1024 * 1024;
const SYMFONY_CONTEXT_INPUTS = Object.freeze([
  "packages/php/core/composer.json",
  "packages/php/core/composer.lock",
  "packages/php/core/src",
  "packages/php/symfony-bundle/composer.json",
  "packages/php/symfony-bundle/composer.lock",
  "packages/php/symfony-bundle/config",
  "packages/php/symfony-bundle/src",
  "examples/symfony/Dockerfile",
  "examples/symfony/composer.json",
  "examples/symfony/composer.lock",
  "examples/symfony/config",
  "examples/symfony/public",
  "examples/symfony/src",
  "conformance/scenarios",
]);

function invalidPlan() {
  throw new TypeError("Official adapters plan is invalid");
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function safeAbsolutePath(value) {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 4096
    && isAbsolute(value)
    && resolve(value) === value
    && value !== sep
    && !value.includes(",")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function platformForArchitecture(architecture) {
  if (architecture === "arm64") return "linux/arm64";
  if (architecture === "x64") return "linux/amd64";
  invalidPlan();
}

function commandStep(phase, invocation, adapter) {
  return {
    phase,
    ...(adapter === undefined ? {} : { adapter }),
    kind: "command",
    invocation: {
      ...invocation,
      cwd: invocation.cwd,
      env: {},
      shell: false,
    },
  };
}

function commandGroupStep(phase, invocations) {
  return {
    phase,
    kind: "command-group",
    invocations: invocations.map((invocation) => ({
      ...invocation,
      env: {},
      shell: false,
    })),
  };
}

function runtimeInstance({ adapter, state, image, taskIdentifier, uid, gid, artifactDirectory }) {
  const name = `gauntlet-official-adapters-${taskIdentifier}-${adapter}-${state}`;
  const enabled = state === "enabled";
  if (adapter === "symfony") {
    return {
      name,
      image,
      containerPort: 8080,
      origin: `http://${name}:8080`,
      readOnly: true,
      capDrop: "ALL",
      noNewPrivileges: true,
      uid,
      gid,
      environment: {
        APP_DEBUG: "0",
        APP_ENV: enabled ? "conformance" : "disabled",
        GAUNTLET_ENABLED: enabled ? "true" : "false",
        GAUNTLET_RUN_STORE_PATH: `/tmp/gauntlet-${state}.sqlite`,
      },
      command: [],
    };
  }
  return {
    name,
    image,
    containerPort: 8080,
    origin: `http://${name}:8080`,
    readOnly: true,
    capDrop: "ALL",
    noNewPrivileges: true,
    uid,
    gid,
    artifactDirectory,
    environment: {},
    command: [
      "java", "-jar", "/app/application.jar",
      "--server.address=0.0.0.0",
      "--server.port=8080",
      "--spring.main.banner-mode=off",
      "--logging.level.root=OFF",
      `--gauntlet.enabled=${enabled ? "true" : "false"}`,
    ],
  };
}

export function createOfficialAdaptersPlan(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) invalidPlan();
  const { root, sandbox, taskIdentifier, uid, gid, architecture } = options;
  if (Object.keys(options).sort().join(",") !== "architecture,gid,root,sandbox,taskIdentifier,uid"
      || !safeAbsolutePath(root)
      || !safeAbsolutePath(sandbox)
      || typeof taskIdentifier !== "string"
      || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(taskIdentifier)
      || !Number.isSafeInteger(uid) || uid < 0 || uid > 2_147_483_647
      || !Number.isSafeInteger(gid) || gid < 0 || gid > 2_147_483_647) invalidPlan();
  const phpPlatform = platformForArchitecture(architecture);
  const prefix = `gauntlet-official-adapters-${taskIdentifier}`;
  const symfonyImage = `gauntlet-official-adapters:${taskIdentifier}-symfony`;
  const symfonyContext = resolve(sandbox, "symfony-context");
  const springArtifactDirectory = resolve(root, "packages/java/spring-example/build/libs");
  const network = (adapter) => ({
    name: `${prefix}-${adapter}`,
    internal: true,
    label: `dev.8lines.gauntlet.task=${taskIdentifier}`,
  });

  const plan = [
    commandGroupStep("typescript-build", [
      "packages/protocol/tsconfig.json",
      "packages/typescript/core/tsconfig.json",
      "conformance/runner/tsconfig.json",
      "examples/typescript-fixture/tsconfig.json",
      "packages/typescript/node/tsconfig.json",
      "packages/typescript/next/tsconfig.json",
      "examples/node-adapter/tsconfig.json",
    ].map((project) => ({
      command: process.execPath,
      args: [resolve(root, "node_modules/typescript/bin/tsc"), "-p", resolve(root, project), "--pretty", "false"],
      cwd: root,
      timeoutMs: COMMAND_TIMEOUT_MS,
    }))),
    commandStep("node-http-conformance", {
      command: process.execPath,
      args: [
        resolve(root, "node_modules/tsx/dist/cli.mjs"), "--test",
        "--test-concurrency=1", "test/live-conformance.test.ts", "test/extended-conformance.test.ts",
      ],
      cwd: resolve(root, "examples/node-adapter"),
      timeoutMs: COMMAND_TIMEOUT_MS,
    }, "node"),
    commandStep("next-production-build", {
      command: process.execPath,
      args: [resolve(root, "examples/next/node_modules/next/dist/bin/next"), "build"],
      cwd: resolve(root, "examples/next"),
      timeoutMs: COMMAND_TIMEOUT_MS,
    }, "next"),
    commandStep("next-http-conformance", {
      command: process.execPath,
      args: [
        resolve(root, "node_modules/tsx/dist/cli.mjs"), "--test",
        "--test-concurrency=1", "test/live-conformance.test.ts", "test/extended-conformance.test.ts",
      ],
      cwd: resolve(root, "examples/next"),
      timeoutMs: COMMAND_TIMEOUT_MS,
    }, "next"),
    {
      ...commandStep("symfony-image-build", {
        command: "docker",
        args: [
          "build", "--pull", "--platform", phpPlatform,
          "--file", resolve(symfonyContext, "examples/symfony/Dockerfile"),
          "--tag", symfonyImage,
          symfonyContext,
        ],
        cwd: root,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }, "symfony"),
      toolchainImage: PHP_IMAGE,
    },
    {
      phase: "symfony-http-conformance",
      adapter: "symfony",
      kind: "http-conformance",
      root,
      contracts: ["base", "extended"],
      network: network("symfony"),
      runnerImage: NODE_IMAGE,
      enabled: runtimeInstance({
        adapter: "symfony", state: "enabled", image: symfonyImage, taskIdentifier, uid, gid,
      }),
      disabled: runtimeInstance({
        adapter: "symfony", state: "disabled", image: symfonyImage, taskIdentifier, uid, gid,
      }),
      cleanupImage: symfonyImage,
    },
    commandStep("spring-boot-build", {
      command: "docker",
      args: [
        "run", "--rm", "--name", `${prefix}-spring-build`,
        "--platform", "linux/amd64", "--user", `${uid}:${gid}`, "--network", "bridge",
        "--read-only",
        "--env", "GRADLE_USER_HOME=/gradle-home",
        "--env", "HOME=/tmp/home",
        "--env", "LANG=C.UTF-8",
        "--env", "LC_ALL=C.UTF-8",
        "--env", "TZ=UTC",
        "--env", "CI=1",
        "--mount", `type=bind,src=${root},dst=/workspace,readonly`,
        "--mount", `type=bind,src=${resolve(root, "packages/java")},dst=/workspace/packages/java`,
        "--mount", `type=bind,src=${resolve(sandbox, "gradle-home")},dst=/gradle-home`,
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=536870912,mode=1777",
        "--workdir", "/workspace/packages/java",
        GRADLE_IMAGE,
        "gradle", "--no-daemon", "--console=plain", "--warning-mode=fail",
        "--project-cache-dir", "/tmp/project-cache",
        "-DgauntletProtocolFixtures=/workspace/packages/protocol/fixtures/v1",
        ":spring-example:clean",
        ":spring-example:bootJar",
      ],
      cwd: root,
      timeoutMs: COMMAND_TIMEOUT_MS,
    }, "spring"),
    {
      phase: "spring-http-conformance",
      adapter: "spring",
      kind: "http-conformance",
      root,
      contracts: ["base", "extended"],
      network: network("spring"),
      runnerImage: NODE_IMAGE,
      enabled: runtimeInstance({
        adapter: "spring", state: "enabled", image: GRADLE_IMAGE,
        taskIdentifier, uid, gid, artifactDirectory: springArtifactDirectory,
      }),
      disabled: runtimeInstance({
        adapter: "spring", state: "disabled", image: GRADLE_IMAGE,
        taskIdentifier, uid, gid, artifactDirectory: springArtifactDirectory,
      }),
    },
  ];
  return deepFreeze(plan);
}

function appendBounded(chunks, chunk, size) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_CAPTURE_BYTES - size.value;
  if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
  size.value += bytes.length;
}

async function executeProcess(command, args, options = {}) {
  return await new Promise((resolveProcess) => {
    let settled = false;
    const capture = options.capture === true;
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutSize = { value: 0 };
    const stderrSize = { value: 0 };
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        windowsHide: true,
      });
    } catch (error) {
      resolveProcess({ error, signal: null, status: null, stdout: "", stderr: "" });
      return;
    }
    if (capture) {
      child.stdout?.on("data", (chunk) => appendBounded(stdoutChunks, chunk, stdoutSize));
      child.stderr?.on("data", (chunk) => appendBounded(stderrChunks, chunk, stderrSize));
    }
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ error, signal: null, status: null, stdout: "", stderr: "" });
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({
        error: undefined,
        signal,
        status,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

function normalResult(result) {
  return result !== null
    && typeof result === "object"
    && result.error === undefined
    && result.signal === null
    && Number.isInteger(result.status)
    && result.status >= 0
    && result.status <= 255;
}

function phaseOutcome(result) {
  if (!normalResult(result)) return { ok: false, exitCode: 1, executionError: true };
  return result.status === 0
    ? { ok: true, exitCode: 0 }
    : { ok: false, exitCode: result.status };
}

async function executeInvocation(invocation, environment, execute = executeProcess, capture = false) {
  let result;
  try {
    result = await execute(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...environment, ...invocation.env },
      shell: false,
      stdio: capture ? "pipe" : "inherit",
      capture,
      timeoutMs: invocation.timeoutMs,
      windowsHide: true,
    });
  } catch {
    return { outcome: { ok: false, exitCode: 1, executionError: true }, result: undefined };
  }
  return { outcome: phaseOutcome(result), result };
}

function dockerInvocation(args, root, environment, timeoutMs = COMMAND_TIMEOUT_MS) {
  return {
    command: "docker",
    args,
    cwd: root,
    env: environment,
    shell: false,
    timeoutMs,
  };
}

function springJar(instance) {
  try {
    if (!safeAbsolutePath(instance.artifactDirectory)) throw new Error();
    const entries = readdirSync(instance.artifactDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^spring-example-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.jar$/u.test(entry.name));
    if (entries.length !== 1) throw new Error();
    const path = resolve(instance.artifactDirectory, entries[0].name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.size <= 0) throw new Error();
    return path;
  } catch {
    return undefined;
  }
}

function startArguments(step, instance) {
  const args = [
    "run", "--detach", "--name", instance.name,
    "--network", step.network.name,
    "--read-only", "--cap-drop", instance.capDrop,
    "--security-opt", "no-new-privileges",
    "--user", `${instance.uid}:${instance.gid}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456,mode=1777",
    "--label", step.network.label,
  ];
  for (const [key, value] of Object.entries(instance.environment)) {
    args.push("--env", `${key}=${value}`);
  }
  if (["spring", "symfony"].includes(step.adapter)) {
    args.push("--env", "GAUNTLET_IDEMPOTENCY_SECRET");
  }
  if (step.adapter === "spring") {
    const artifact = springJar(instance);
    if (artifact === undefined) return undefined;
    args.push("--mount", `type=bind,src=${artifact},dst=/app/application.jar,readonly`);
  }
  args.push(instance.image, ...instance.command);
  return args;
}

function conformanceNodeArguments(step, enabledUrl, disabledUrl, contract) {
  if (contract === "base") {
    return [
      "node", "/workspace/conformance/runner/dist/cli.js",
      "--base-url", enabledUrl,
      "--scenario", "/workspace/conformance/scenarios/adapter-v1.json",
    ];
  }
  return [
    "node", "/workspace/conformance/runner/dist/extended-cli.js",
    "--enabled-base-url", enabledUrl,
    "--disabled-base-url", disabledUrl,
    "--scenario", "/workspace/conformance/scenarios/adapter-v1-extended.json",
  ];
}

const READINESS_SCRIPT = [
  "const pairs = [[process.argv[1], Number(process.argv[2])], [process.argv[3], Number(process.argv[4])]];",
  `const deadline = Date.now() + ${READY_TIMEOUT_MS};`,
  "while (Date.now() < deadline) {",
  "  let ready = true;",
  "  for (const [origin, status] of pairs) {",
  "    try {",
  "      const response = await fetch(`${origin}/_gauntlet/v1/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });",
  "      if (response.status !== status) ready = false;",
  "    } catch { ready = false; }",
  "  }",
  "  if (ready) process.exit(0);",
  "  await new Promise((resolve) => setTimeout(resolve, 100));",
  "}",
  "process.exit(1);",
].join("\n");

function networkRunnerArguments(step, name, nodeArguments) {
  return [
    "run", "--name", name,
    "--network", step.network.name,
    "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", `${step.enabled.uid}:${step.enabled.gid}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=134217728,mode=1777",
    "--env", "HOME=/tmp",
    "--env", "TMPDIR=/tmp",
    "--mount", `type=bind,src=${step.root},dst=/workspace,readonly`,
    "--workdir", "/workspace",
    "--label", step.network.label,
    step.runnerImage,
    ...nodeArguments,
  ];
}

function validHttpConformanceStep(step) {
  if (step?.kind !== "http-conformance"
      || !["symfony", "spring"].includes(step.adapter)
      || !safeAbsolutePath(step.root)
      || step.network?.internal !== true
      || !/^gauntlet-official-adapters-[a-z0-9-]+-(?:symfony|spring)$/u.test(step.network.name)
      || step.runnerImage !== NODE_IMAGE
      || typeof step.network.label !== "string"
      || !/^dev\.8lines\.gauntlet\.task=[a-z0-9][a-z0-9-]{0,47}$/u.test(step.network.label)
      || JSON.stringify(step.contracts) !== JSON.stringify(["base", "extended"])) return false;
  for (const [state, instance] of [["enabled", step.enabled], ["disabled", step.disabled]]) {
    if (instance?.name !== `${step.network.name}-${state}`
        || instance.containerPort !== 8080
        || instance.origin !== `http://${instance.name}:8080`
        || Object.hasOwn(instance, "publish")
        || instance.readOnly !== true
        || instance.capDrop !== "ALL"
        || instance.noNewPrivileges !== true
        || !Number.isSafeInteger(instance.uid) || instance.uid < 0
        || !Number.isSafeInteger(instance.gid) || instance.gid < 0
        || !Array.isArray(instance.command)) return false;
  }
  return step.adapter === "symfony"
    ? step.cleanupImage === step.enabled.image && step.enabled.image === step.disabled.image
    : step.cleanupImage === undefined && step.enabled.image === GRADLE_IMAGE
      && step.disabled.image === GRADLE_IMAGE;
}

async function performHttpConformance(step, { execute, environment }) {
  const adapterEnvironment = ["spring", "symfony"].includes(step.adapter)
    ? { ...environment, GAUNTLET_IDEMPOTENCY_SECRET: randomBytes(32).toString("hex") }
    : environment;
  let execution = await executeInvocation(dockerInvocation([
    "network", "create", "--driver", "bridge", "--internal",
    "--label", step.network.label, step.network.name,
  ], step.root, {}), environment, execute, true);
  if (!execution.outcome.ok) return execution.outcome;

  for (const [state, instance] of [["enabled", step.enabled], ["disabled", step.disabled]]) {
    const args = startArguments(step, instance);
    if (args === undefined) return { ok: false, exitCode: 1, executionError: true };
    execution = await executeInvocation(
      dockerInvocation(args, step.root, {}), adapterEnvironment, execute, true,
    );
    if (!execution.outcome.ok) return execution.outcome;
  }

  execution = await executeInvocation(dockerInvocation(networkRunnerArguments(
    step,
    `${step.network.name}-readiness`,
    [
      "node", "--input-type=module", "--eval", READINESS_SCRIPT,
      step.enabled.origin, "200", step.disabled.origin, "503",
    ],
  ), step.root, {}), environment, execute, true);
  if (!execution.outcome.ok) return execution.outcome;

  for (const contract of step.contracts) {
    const contractExecution = await executeInvocation(
      dockerInvocation(networkRunnerArguments(
        step,
        `${step.network.name}-${contract}`,
        conformanceNodeArguments(step, step.enabled.origin, step.disabled.origin, contract),
      ), step.root, {}),
      environment, execute,
    );
    if (!contractExecution.outcome.ok) return contractExecution.outcome;
  }
  return { ok: true, exitCode: 0 };
}

export async function executeHttpConformanceStep(step, dependencies = {}) {
  const execute = dependencies.execute ?? executeProcess;
  const environment = dependencies.environment ?? {};
  let outcome = { ok: false, exitCode: 1, executionError: true };
  let cleanupFailed = false;
  const cleanupAllowed = validHttpConformanceStep(step);
  try {
    if (cleanupAllowed) {
      outcome = await performHttpConformance(step, { execute, environment });
    }
  } catch {
    outcome = { ok: false, exitCode: 1, executionError: true };
  } finally {
    if (!cleanupAllowed) return outcome;
    for (const name of [
      step?.enabled?.name,
      step?.disabled?.name,
      typeof step?.network?.name === "string" ? `${step.network.name}-readiness` : undefined,
      typeof step?.network?.name === "string" ? `${step.network.name}-base` : undefined,
      typeof step?.network?.name === "string" ? `${step.network.name}-extended` : undefined,
    ]) {
      if (typeof name !== "string") continue;
      const cleanup = await executeInvocation(
        dockerInvocation(["rm", "--force", name], step.root, {}), environment, execute, true,
      );
      cleanupFailed ||= !cleanup.outcome.ok;
    }
    if (typeof step?.network?.name === "string") {
      const cleanup = await executeInvocation(
        dockerInvocation(["network", "rm", step.network.name], step.root, {}), environment, execute, true,
      );
      cleanupFailed ||= !cleanup.outcome.ok;
    }
    if (typeof step?.cleanupImage === "string") {
      const cleanup = await executeInvocation(
        dockerInvocation(["image", "rm", step.cleanupImage], step.root, {}), environment, execute, true,
      );
      cleanupFailed ||= !cleanup.outcome.ok;
    }
  }
  if (outcome.ok && cleanupFailed) return { ok: false, exitCode: 1, executionError: true };
  return outcome;
}

function sameSourceFile(left, right) {
  return left.isFile() && right.isFile()
    && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function copyContextEntry(root, context, relativePath, budget) {
  const source = resolve(root, relativePath);
  const destination = resolve(context, relativePath);
  if (!source.startsWith(`${root}${sep}`) || !destination.startsWith(`${context}${sep}`)
      || realpathSync(source) !== source) throw new Error("Unsafe Symfony context input");
  const before = lstatSync(source, { bigint: true });
  if (before.isSymbolicLink()) throw new Error("Unsafe Symfony context input");
  if (before.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o755 });
    chmodSync(destination, 0o755);
    const names = readdirSync(source).sort();
    if (names.length > MAX_CONTEXT_FILES
        || names.some((name) => name === "" || name === "." || name === ".." || name.includes(sep))) {
      throw new Error("Unsafe Symfony context input");
    }
    for (const name of names) copyContextEntry(root, context, join(relativePath, name), budget);
    return;
  }
  if (!before.isFile() || before.nlink !== 1n || before.size < 0n
      || before.size > BigInt(MAX_CONTEXT_FILE_BYTES)) throw new Error("Unsafe Symfony context input");
  budget.files += 1;
  budget.bytes += Number(before.size);
  if (budget.files > MAX_CONTEXT_FILES || budget.bytes > MAX_CONTEXT_BYTES) {
    throw new Error("Unsafe Symfony context input");
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o644);
  const after = lstatSync(source, { bigint: true });
  const copied = lstatSync(destination, { bigint: true });
  if (!sameSourceFile(before, after) || !copied.isFile() || copied.isSymbolicLink()
      || copied.size !== before.size) throw new Error("Unsafe Symfony context input");
}

function normalizeContextModes(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Unsafe Symfony context output");
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) normalizeContextModes(resolve(path, name));
    chmodSync(path, 0o755);
    return;
  }
  if (!stat.isFile()) throw new Error("Unsafe Symfony context output");
  chmodSync(path, 0o644);
}

export function prepareSymfonyBuildContext(root, sandbox) {
  const context = resolve(sandbox, "symfony-context");
  mkdirSync(context, { mode: 0o700 });
  const budget = { files: 0, bytes: 0 };
  for (const relativePath of SYMFONY_CONTEXT_INPUTS) {
    copyContextEntry(root, context, relativePath, budget);
  }
  if (budget.files < 10 || budget.bytes < 1_024) throw new Error("Symfony context is incomplete");
  normalizeContextModes(context);
}

function safeEnvironment(sandbox) {
  const path = process.env.PATH;
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new Error();
  const home = resolve(sandbox, "home");
  const dockerConfig = resolve(sandbox, "docker-config");
  const temporary = resolve(sandbox, "tmp");
  const gradleHome = resolve(sandbox, "gradle-home");
  for (const directory of [home, dockerConfig, temporary, gradleHome]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  return deepFreeze({
    PATH: path,
    HOME: home,
    DOCKER_CONFIG: dockerConfig,
    TMPDIR: temporary,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
    NO_COLOR: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    ...(typeof process.env.DOCKER_HOST === "string"
      && process.env.DOCKER_HOST.length > 0
      && !process.env.DOCKER_HOST.includes("\0")
      ? { DOCKER_HOST: process.env.DOCKER_HOST }
      : {}),
  });
}

function validateExecutionEnvironment(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) throw new Error();
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error();
  }
  if (typeof environment.PATH !== "string" || environment.PATH.length === 0) throw new Error();
  return environment;
}

async function defaultPhaseRunner(step, context) {
  if (step.kind === "http-conformance") {
    return await executeHttpConformanceStep(step, { environment: context.environment });
  }
  if (step.kind === "command-group") {
    for (const invocation of step.invocations) {
      const execution = await executeInvocation(invocation, context.environment);
      if (!execution.outcome.ok) return execution.outcome;
    }
    return { ok: true, exitCode: 0 };
  }
  const execution = await executeInvocation(step.invocation, context.environment);
  return execution.outcome;
}

function executionFailure(phase) {
  return { code: "EXECUTION_FAILED", exitCode: 1, ok: false, phase };
}

function createTaskSandbox() {
  const candidates = process.platform === "win32" ? [tmpdir()] : ["/tmp", tmpdir()];
  for (const candidate of candidates) {
    try {
      const base = realpathSync(candidate);
      const sandbox = realpathSync(mkdtempSync(join(base, "tc-oa-")));
      chmodSync(sandbox, 0o700);
      if (sandbox.length <= 48 && safeAbsolutePath(sandbox)) return sandbox;
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // Try the next operating-system temporary directory without exposing its path.
    }
  }
  throw new Error("Task sandbox unavailable");
}

export async function runOfficialAdaptersVerification(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    return { code: "INVALID_ARGUMENTS", exitCode: 2, ok: false, phase: null };
  }
  const ownsSandbox = options.sandbox === undefined;
  let sandbox;
  try {
    sandbox = options.sandbox ?? createTaskSandbox();
    const root = options.root ?? ROOT;
    const taskIdentifier = options.taskIdentifier ?? randomBytes(8).toString("hex");
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 1000);
    const gid = options.gid ?? (typeof process.getgid === "function" ? process.getgid() : 1000);
    const architecture = options.architecture ?? process.arch;
    const plan = createOfficialAdaptersPlan({ root, sandbox, taskIdentifier, uid, gid, architecture });
    const environment = validateExecutionEnvironment(options.environment ?? safeEnvironment(sandbox));
    const phaseRunner = options.phaseRunner ?? defaultPhaseRunner;
    if (typeof phaseRunner !== "function") return executionFailure(null);
    if (phaseRunner === defaultPhaseRunner) {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) return executionFailure(null);
      prepareSymfonyBuildContext(root, sandbox);
    }

    for (const step of plan) {
      let result;
      try {
        result = await phaseRunner(step, { environment });
      } catch {
        return executionFailure(step.phase);
      }
      if (result === null || typeof result !== "object" || typeof result.ok !== "boolean"
          || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
          || (result.ok && result.exitCode !== 0) || (!result.ok && result.exitCode === 0)) {
        return executionFailure(step.phase);
      }
      if (!result.ok) {
        return result.executionError === true
          ? executionFailure(step.phase)
          : { code: "PHASE_FAILED", exitCode: result.exitCode, ok: false, phase: step.phase };
      }
    }
    return { exitCode: 0, ok: true };
  } catch {
    return executionFailure(null);
  } finally {
    if (ownsSandbox && typeof sandbox === "string" && safeAbsolutePath(sandbox)) {
      try {
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // The structured gate result deliberately does not expose cleanup diagnostics.
      }
    }
  }
}

function isMainModule() {
  try {
    return process.argv[1] !== undefined
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const result = await runOfficialAdaptersVerification(process.argv.slice(2));
  if (!result.ok) {
    if (result.code === "INVALID_ARGUMENTS") process.stderr.write(`${USAGE}\n`);
    else process.stderr.write(`Official adapter verification failed safely in ${result.phase ?? "setup"}\n`);
  }
  process.exitCode = result.exitCode;
}
