import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createOfficialAdaptersPlan,
  executeHttpConformanceStep,
  prepareSymfonyBuildContext,
  runOfficialAdaptersVerification,
} from "../verify-official-adapters.mjs";

const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const SCRIPT = fileURLToPath(new URL("../verify-official-adapters.mjs", import.meta.url));
const PLAN_OPTIONS = Object.freeze({
  root: "/repository",
  sandbox: "/private/gauntlet-official-adapters",
  taskIdentifier: "unit-a1b2c3",
  uid: 501,
  gid: 20,
  architecture: "arm64",
});

function successfulChild(stdout = "") {
  return { error: undefined, signal: null, status: 0, stdout, stderr: "" };
}

test("plans every official HTTP adapter against the shared base and extended contracts", () => {
  const plan = createOfficialAdaptersPlan(PLAN_OPTIONS);

  assert.deepEqual(plan.map(({ phase, adapter, kind }) => ({ phase, adapter, kind })), [
    { phase: "typescript-build", adapter: undefined, kind: "command-group" },
    { phase: "node-http-conformance", adapter: "node", kind: "command" },
    { phase: "next-production-build", adapter: "next", kind: "command" },
    { phase: "next-http-conformance", adapter: "next", kind: "command" },
    { phase: "symfony-image-build", adapter: "symfony", kind: "command" },
    { phase: "symfony-http-conformance", adapter: "symfony", kind: "http-conformance" },
    { phase: "spring-boot-build", adapter: "spring", kind: "command" },
    { phase: "spring-http-conformance", adapter: "spring", kind: "http-conformance" },
  ]);

  const node = plan.find(({ phase }) => phase === "node-http-conformance");
  assert.deepEqual(node.invocation.args, [
    "/repository/node_modules/tsx/dist/cli.mjs", "--test",
    "--test-concurrency=1", "test/live-conformance.test.ts", "test/extended-conformance.test.ts",
  ]);
  assert.equal(node.invocation.cwd, "/repository/examples/node-adapter");
  const next = plan.find(({ phase }) => phase === "next-http-conformance");
  assert.deepEqual(next.invocation.args, [
    "/repository/node_modules/tsx/dist/cli.mjs", "--test",
    "--test-concurrency=1", "test/live-conformance.test.ts", "test/extended-conformance.test.ts",
  ]);
  assert.equal(next.invocation.cwd, "/repository/examples/next");

  for (const adapter of ["symfony", "spring"]) {
    const step = plan.find(({ kind, adapter: name }) => kind === "http-conformance" && name === adapter);
    assert.deepEqual(step.contracts, ["base", "extended"]);
    assert.equal(step.network.internal, true);
    assert.match(step.network.name, /^gauntlet-official-adapters-unit-a1b2c3-/);
    for (const instance of [step.enabled, step.disabled]) {
      assert.equal(instance.containerPort, 8080);
      assert.equal(Object.hasOwn(instance, "publish"), false);
      assert.equal(instance.origin, `http://${instance.name}:8080`);
      assert.equal(instance.readOnly, true);
      assert.equal(instance.capDrop, "ALL");
      assert.equal(instance.noNewPrivileges, true);
      assert.doesNotMatch(JSON.stringify(instance), /0\.0\.0\.0:/);
    }
  }
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan[0]), true);
});

test("pins container toolchains and never forwards host secrets into planned invocations", () => {
  const plan = createOfficialAdaptersPlan(PLAN_OPTIONS);
  const serialized = JSON.stringify(plan);
  assert.match(serialized, /php:8\.3\.33-cli-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(serialized, /gradle:9\.2\.1-jdk21@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(serialized, /(?:GITHUB_|AUTHORIZATION|PASSWORD|PRIVATE_KEY|TOKEN)/i);

  for (const step of plan.filter(({ kind }) => kind === "command")) {
    assert.equal(step.invocation.shell, false);
    assert.equal(step.invocation.cwd === "/repository" || step.invocation.cwd.startsWith("/repository/"), true);
    assert.equal(step.invocation.env.PATH, undefined);
  }
  const springBuild = plan.find(({ phase }) => phase === "spring-boot-build");
  assert.deepEqual(springBuild.invocation.args.slice(0, 9), [
    "run", "--rm", "--name", "gauntlet-official-adapters-unit-a1b2c3-spring-build",
    "--platform", "linux/amd64", "--user", "501:20", "--network",
  ]);
  assert.ok(springBuild.invocation.args.includes(":spring-example:clean"));
  assert.ok(
    springBuild.invocation.args.indexOf(":spring-example:clean")
      < springBuild.invocation.args.indexOf(":spring-example:bootJar"),
  );
  assert.ok(springBuild.invocation.args.includes(":spring-example:bootJar"));
});

test("the deployable Spring example requires a runtime-supplied idempotency secret", () => {
  const configuration = readFileSync(
    resolve(REPOSITORY_ROOT, "packages/java/spring-example/src/main/resources/application.yml"),
    "utf8",
  );
  assert.match(configuration, /idempotency-secret: \$\{GAUNTLET_IDEMPOTENCY_SECRET\}/u);
  assert.doesNotMatch(configuration, /spring-example-stable-idempotency-secret/u);
});

test("the deployable Symfony example contains no built-in framework or idempotency secret", () => {
  const source = readFileSync(resolve(REPOSITORY_ROOT, "examples/symfony/src/Kernel.php"), "utf8");
  assert.match(source, /'secret' => false/u);
  assert.match(source, /GAUNTLET_IDEMPOTENCY_SECRET/u);
  assert.doesNotMatch(source, /reference-adapter-(?:kernel|stable-idempotency)-secret/u);
});

test("Spring conformance forwards one generated secret through the process environment, never a Docker argument", async (t) => {
  const sandbox = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "tc-oa-spring-secret-")));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const artifacts = resolve(sandbox, "artifacts");
  mkdirSync(artifacts, { mode: 0o700 });
  writeFileSync(resolve(artifacts, "spring-example-0.1.0.jar"), "synthetic jar\n", { mode: 0o600 });

  const planned = createOfficialAdaptersPlan({
    ...PLAN_OPTIONS,
    root: REPOSITORY_ROOT,
    sandbox,
    taskIdentifier: "spring-secret",
  }).find(({ phase }) => phase === "spring-http-conformance");
  const step = {
    ...planned,
    enabled: { ...planned.enabled, artifactDirectory: artifacts },
    disabled: { ...planned.disabled, artifactDirectory: artifacts },
  };
  const calls = [];
  const outcome = await executeHttpConformanceStep(step, {
    environment: { PATH: "/usr/bin:/bin" },
    async execute(command, args, options) {
      calls.push({ command, args, options });
      return successfulChild("ok\n");
    },
  });

  assert.deepEqual(outcome, { ok: true, exitCode: 0 });
  const starts = calls.filter(({ args }) => args[0] === "run" && args[1] === "--detach");
  assert.equal(starts.length, 2);
  const secrets = new Set();
  for (const { args, options } of starts) {
    const serialized = args.join("\n");
    assert.equal(args.some((value, index) => value === "--env"
      && args[index + 1] === "GAUNTLET_IDEMPOTENCY_SECRET"), true);
    assert.doesNotMatch(serialized, /GAUNTLET_IDEMPOTENCY_SECRET=/u);
    assert.match(options.env.GAUNTLET_IDEMPOTENCY_SECRET, /^[a-f0-9]{64}$/u);
    assert.equal(serialized.includes(options.env.GAUNTLET_IDEMPOTENCY_SECRET), false);
    secrets.add(options.env.GAUNTLET_IDEMPOTENCY_SECRET);
  }
  assert.equal(secrets.size, 1);
});

test("keeps containerized adapters off host ports and runs conformance inside the private network", () => {
  const plan = createOfficialAdaptersPlan(PLAN_OPTIONS);
  for (const step of plan.filter(({ kind }) => kind === "http-conformance")) {
    assert.match(step.runnerImage, /node:24\.20\.0-alpine@sha256:[a-f0-9]{64}/);
    for (const instance of [step.enabled, step.disabled]) {
      assert.equal(Object.hasOwn(instance, "publish"), false);
      assert.equal(instance.origin, `http://${instance.name}:8080`);
    }
  }
});

test("uses installed Node entrypoints without changing the workspace package-manager store", () => {
  const plan = createOfficialAdaptersPlan(PLAN_OPTIONS);
  const commands = plan.filter(({ kind }) => kind === "command");
  const invocations = plan.flatMap((step) => step.kind === "command-group"
    ? step.invocations
    : step.kind === "command" ? [step.invocation] : []);
  assert.equal(invocations.some(({ command }) => command === "pnpm" || command === "corepack"), false);
  assert.equal(
    commands.some(({ phase, invocation }) => phase === "next-production-build"
      && invocation.command === process.execPath
      && invocation.args[0] === "/repository/examples/next/node_modules/next/dist/bin/next"
      && invocation.args[1] === "build"),
    true,
  );
});

test("compiles TypeScript projects independently without leaving build-info state", () => {
  const build = createOfficialAdaptersPlan(PLAN_OPTIONS)
    .find(({ phase }) => phase === "typescript-build");
  assert.equal(build.kind, "command-group");
  assert.equal(build.invocations.length, 7);
  for (const invocation of build.invocations) {
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0], "/repository/node_modules/typescript/bin/tsc");
    assert.equal(invocation.args[1], "-p");
    assert.equal(invocation.args.includes("--build"), false);
    assert.equal(invocation.args.includes("--incremental"), false);
  }
});

test("builds Symfony from a task-owned allowlisted context instead of the product image context", () => {
  const plan = createOfficialAdaptersPlan(PLAN_OPTIONS);
  const build = plan.find(({ phase }) => phase === "symfony-image-build").invocation;
  assert.equal(build.args.at(-1), "/private/gauntlet-official-adapters/symfony-context");
  assert.equal(
    build.args[build.args.indexOf("--file") + 1],
    "/private/gauntlet-official-adapters/symfony-context/examples/symfony/Dockerfile",
  );
  assert.notEqual(build.args.at(-1), PLAN_OPTIONS.root);
});

test("stages nested Symfony and conformance inputs without copying ignored dependency trees", () => {
  const sandbox = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "tc-oa-context-test-")));
  try {
    prepareSymfonyBuildContext(REPOSITORY_ROOT, sandbox);
    const context = join(sandbox, "symfony-context");
    assert.equal(existsSync(join(context, "conformance/scenarios/adapter-v1.json")), true);
    assert.equal(existsSync(join(context, "packages/php/core/src")), true);
    assert.equal(existsSync(join(context, "packages/php/core/vendor")), false);
    assert.equal(existsSync(join(context, ".dockerignore")), false);
    assert.equal(statSync(join(context, "examples/symfony/public/index.php")).mode & 0o044, 0o044);
    assert.equal(statSync(join(context, "examples/symfony/public")).mode & 0o055, 0o055);
    assert.equal(statSync(join(context, "examples/symfony")).mode & 0o055, 0o055);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("fails fast with the exact safe phase and preserves a normal child exit status", async () => {
  const phases = [];
  const result = await runOfficialAdaptersVerification([], {
    ...PLAN_OPTIONS,
    environment: { PATH: "/fixed/bin", HOME: "/private/home", TMPDIR: "/private/tmp" },
    async phaseRunner(step) {
      phases.push(step.phase);
      return step.phase === "node-http-conformance"
        ? { ok: false, exitCode: 7 }
        : { ok: true, exitCode: 0 };
    },
  });

  assert.deepEqual(phases, ["typescript-build", "node-http-conformance"]);
  assert.deepEqual(result, {
    code: "PHASE_FAILED",
    exitCode: 7,
    ok: false,
    phase: "node-http-conformance",
  });
});

test("execution anomalies fail closed without exposing thrown diagnostics", async (t) => {
  for (const [name, outcome] of [
    ["throw", () => { throw new Error("sensitive 731904"); }],
    ["malformed", () => undefined],
    ["signal-like", () => ({ ok: false, exitCode: null })],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const result = await runOfficialAdaptersVerification([], {
        ...PLAN_OPTIONS,
        environment: { PATH: "/fixed/bin", HOME: "/private/home", TMPDIR: "/private/tmp" },
        async phaseRunner() {
          calls += 1;
          return outcome();
        },
      });
      assert.equal(calls, 1);
      assert.deepEqual(result, {
        code: "EXECUTION_FAILED",
        exitCode: 1,
        ok: false,
        phase: "typescript-build",
      });
      assert.doesNotMatch(JSON.stringify(result), /731904|sensitive/);
    });
  }
});

test("rejects arguments and unsafe plan inputs before any phase executes", async () => {
  let called = false;
  const result = await runOfficialAdaptersVerification(["--adapter", "spring"], {
    ...PLAN_OPTIONS,
    environment: { PATH: "/fixed/bin", HOME: "/private/home", TMPDIR: "/private/tmp" },
    async phaseRunner() {
      called = true;
      return { ok: true, exitCode: 0 };
    },
  });
  assert.equal(called, false);
  assert.deepEqual(result, {
    code: "INVALID_ARGUMENTS",
    exitCode: 2,
    ok: false,
    phase: null,
  });

  for (const change of [
    { root: "relative" },
    { root: "/" },
    { sandbox: "/private/../escape" },
    { taskIdentifier: "../escape" },
    { uid: -1 },
    { architecture: "s390x" },
  ]) {
    assert.throws(() => createOfficialAdaptersPlan({ ...PLAN_OPTIONS, ...change }), {
      name: "TypeError",
      message: "Official adapters plan is invalid",
    });
  }
});

test("the default task-owned TMPDIR stays below Unix socket path limits and is removed", async () => {
  let temporary;
  const result = await runOfficialAdaptersVerification([], {
    root: REPOSITORY_ROOT,
    taskIdentifier: "short-temp-test",
    uid: 501,
    gid: 20,
    architecture: process.arch,
    async phaseRunner(_step, context) {
      temporary = context.environment.TMPDIR;
      return { ok: false, exitCode: 3 };
    },
  });

  assert.equal(result.phase, "typescript-build");
  assert.equal(typeof temporary, "string");
  assert.equal(temporary.length <= 64, true, temporary);
  assert.equal(existsSync(dirname(temporary)), false);
});

test("HTTP conformance cleanup runs after an extended-suite failure with no host publication", async () => {
  const step = createOfficialAdaptersPlan(PLAN_OPTIONS)
    .find(({ phase }) => phase === "symfony-http-conformance");
  const calls = [];

  const outcome = await executeHttpConformanceStep(step, {
    async execute(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === "network" && args[1] === "create") return successfulChild("network-id\n");
      if (args[0] === "run") {
        return args.includes("/workspace/conformance/runner/dist/extended-cli.js")
          ? { ...successfulChild(), status: 9 }
          : successfulChild("container-id\n");
      }
      return successfulChild();
    },
  });

  assert.deepEqual(outcome, { ok: false, exitCode: 9 });
  const runCalls = calls.filter(({ args }) => args[0] === "run" && args[1] === "--detach");
  assert.equal(runCalls.length, 2);
  for (const { args } of runCalls) {
    assert.equal(args.includes("--publish"), false);
    assert.equal(args.includes("--read-only"), true);
    assert.deepEqual(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2), ["--cap-drop", "ALL"]);
  }
  const forwardedSecrets = new Set();
  for (const { args, options } of runCalls) {
    assert.equal(args.some((value, index) => value === "--env"
      && args[index + 1] === "GAUNTLET_IDEMPOTENCY_SECRET"), true);
    assert.doesNotMatch(args.join("\n"), /GAUNTLET_IDEMPOTENCY_SECRET=/u);
    assert.match(options.env.GAUNTLET_IDEMPOTENCY_SECRET, /^[a-f0-9]{64}$/u);
    assert.equal(args.join("\n").includes(options.env.GAUNTLET_IDEMPOTENCY_SECRET), false);
    forwardedSecrets.add(options.env.GAUNTLET_IDEMPOTENCY_SECRET);
  }
  assert.equal(forwardedSecrets.size, 1);
  assert.equal(calls.some(({ args }) => args[0] === "rm" && args.includes(step.enabled.name)), true);
  assert.equal(calls.some(({ args }) => args[0] === "rm" && args.includes(step.disabled.name)), true);
  assert.equal(calls.some(({ args }) => args[0] === "network" && args[1] === "rm"), true);
  assert.equal(calls.some(({ args }) => args[0] === "image" && args[1] === "rm"), true);
});

test("an otherwise successful adapter phase fails closed when task-owned cleanup fails", async () => {
  const step = createOfficialAdaptersPlan(PLAN_OPTIONS)
    .find(({ phase }) => phase === "symfony-http-conformance");

  const outcome = await executeHttpConformanceStep(step, {
    async execute(command, args) {
      if (args[0] === "network" && args[1] === "create") return successfulChild("network-id\n");
      if (args[0] === "run") return successfulChild("container-id\n");
      if (args[0] === "image" && args[1] === "rm") return { ...successfulChild(), status: 4 };
      return successfulChild();
    },
  });

  assert.deepEqual(outcome, { ok: false, exitCode: 1, executionError: true });
});

test("standalone CLI rejects every flag without starting Docker", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--adapter", "node"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    shell: false,
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Usage: node scripts/release/verify-official-adapters.mjs\n");
});
