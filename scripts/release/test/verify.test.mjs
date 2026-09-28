import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  commandsForPhase,
  createProcessRunner,
  parseVerifyArguments,
  plannedReleasePhases,
  runPhases,
  runVerifyCli,
} from "../verify.mjs";

const PHASES = [
  "source",
  "node",
  "php",
  "java",
  "conformance",
  "skills",
  "dashboard",
  "image",
  "compose",
  "helm",
  "security",
  "packages",
  "inventory",
  "documentation",
];
const ROOT = resolve(import.meta.dirname, "../../..");

function result(stdout = "", overrides = {}) {
  return {
    status: 0,
    signal: null,
    stdout,
    stderr: "",
    ...overrides,
  };
}

function versionOutput(version = "0.1.0") {
  return `${JSON.stringify({
    command: "check",
    mismatches: [],
    ok: true,
    tag: null,
    version,
  })}\n`;
}

function sourceSecurityOutput({
  ok = false,
  sourceChecksOk = true,
  reports = [
    "composer-audit.json",
    "credential-material.json",
    "pnpm-audit.json",
    "production-defaults.json",
    "source-snapshot.json",
    "trivy-filesystem.json",
    "trivy-image.json",
  ],
} = {}) {
  return `${JSON.stringify({
    schemaVersion: 1,
    mode: "source-only",
    scope: "working-tree-snapshot",
    sourceCommit: "1".repeat(40),
    sourceChecksOk,
    ok,
    checks: [
      { name: "source-snapshot", required: true, status: "passed" },
      { name: "composer-audit", required: true, status: "passed" },
      { name: "credential-material", required: true, status: "passed" },
      { name: "pnpm-audit", required: true, status: "passed" },
      { name: "production-defaults", required: true, status: "passed" },
      { name: "trivy-filesystem", required: true, status: "passed" },
      {
        name: "trivy-image",
        required: false,
        status: "not-run",
        reason: "excluded-by-source-only-mode",
      },
    ],
    reports,
  })}\n`;
}

function successfulRunner(calls) {
  return async (invocation) => {
    calls.push(invocation);
    if (invocation.phase === "source" && invocation.args.includes("--check")) {
      return result(versionOutput());
    }
    if (invocation.phase === "security") return result(sourceSecurityOutput());
    return result();
  };
}

test("publishes the exact release phase order and strict empty CLI", () => {
  assert.deepEqual(plannedReleasePhases(), PHASES);
  assert.deepEqual(parseVerifyArguments([]), {});
  for (const invalid of [["--help"], ["--release"], [undefined], ""] ) {
    assert.throws(() => parseVerifyArguments(invalid), /Usage: verify\.mjs/u);
  }

  assert.deepEqual(commandsForPhase("documentation", { version: "0.1.0" }), [
    ["pnpm", ["docs:check"]],
    ["pnpm", ["docs:verify-commands", "--release-root", ".artifacts/release/0.1.0"]],
  ]);
  assert.deepEqual(commandsForPhase("dashboard", { version: "0.1.0" }), [
    ["pnpm", ["--filter", "@8lines/gauntlet-dashboard", "build"]],
    ["pnpm", ["--filter", "@8lines/gauntlet-dashboard", "test"]],
    ["pnpm", ["dashboard:test:e2e"]],
  ]);
  assert.deepEqual(commandsForPhase("php", { version: "0.1.0" }), [
    ["pnpm", ["test:php:compatibility"]],
    ["pnpm", ["test:composer:consumer"]],
  ]);
  assert.deepEqual(commandsForPhase("node", { version: "0.1.0" }), [
    ["pnpm", ["verify:protocol-sdk", "--node-only"]],
  ]);
  assert.deepEqual(commandsForPhase("java", { version: "0.1.0" }), [
    [process.execPath, ["scripts/release/test-java-source.mjs"]],
    ["pnpm", ["test:java:release"]],
  ]);
  assert.deepEqual(commandsForPhase("inventory", { version: "0.1.0" }), [
    [process.execPath, [
      "scripts/release/verify-inventory.mjs",
      "--release-root",
      resolve(ROOT, ".artifacts/release/0.1.0"),
    ]],
  ]);
  assert.deepEqual(commandsForPhase("skills", { version: "0.1.0" }), [
    ["pnpm", ["skills:test-install"]],
    ["pnpm", ["skills:test-evals"]],
    ["pnpm", ["skills:validate"]],
    [process.execPath, ["--test", "scripts/skills/test/release-artifact.test.mjs"]],
  ]);
  assert.throws(() => commandsForPhase("documentation"), /version is invalid/u);
  assert.throws(() => commandsForPhase("deployment", { version: "0.1.0" }), /Unknown release phase/u);
});

test("development verification runs only source-safe work and reports explicit partial evidence", async () => {
  const calls = [];
  const report = await runPhases({ root: "/workspace/gauntlet", runner: successfulRunner(calls) });

  assert.deepEqual([...new Set(calls.map(({ phase }) => phase))], [
    "source",
    "node",
    "php",
    "java",
    "conformance",
    "skills",
    "dashboard",
    "image",
    "compose",
    "helm",
    "security",
    "packages",
    "documentation",
  ]);
  assert.equal(calls.some(({ args }) => args.includes("docs:verify-commands")), false);
  assert.equal(calls.some(({ args }) => args.includes("test:java:release")), false);
  assert.equal(calls.some(({ args }) => args.includes("test:composer:consumer")), false);
  assert.equal(calls.some(({ args }) => args.includes("--image-archive")), false);
  const java = calls.find(({ phase }) => phase === "java");
  assert.equal(java.command, process.execPath);
  assert.deepEqual(java.args, ["scripts/release/test-java-source.mjs"]);
  assert.equal(calls.every(({ command, args, workingDirectory, timeoutMs }) =>
    typeof command === "string"
      && Array.isArray(args)
      && workingDirectory === "/workspace/gauntlet"
      && Number.isSafeInteger(timeoutMs)
      && timeoutMs > 0), true);

  assert.deepEqual(report.phases.map(({ name }) => name), PHASES);
  assert.deepEqual(
    Object.fromEntries(report.phases.map(({ name, status }) => [name, status])),
    {
      source: "passed",
      node: "passed",
      php: "partial",
      java: "partial",
      conformance: "passed",
      skills: "passed",
      dashboard: "passed",
      image: "passed",
      compose: "passed",
      helm: "passed",
      security: "partial",
      packages: "partial",
      inventory: "not-run",
      documentation: "partial",
    },
  );
  assert.equal(report.phases.find(({ name }) => name === "inventory").reason, "excluded-in-development-mode");
  assert.equal(report.phases.find(({ name }) => name === "security").reason, "release-evidence-excluded");
  assert.deepEqual(
    {
      mode: report.mode,
      scope: report.scope,
      status: report.status,
      ok: report.ok,
      sourceChecksOk: report.sourceChecksOk,
      releaseReady: report.releaseReady,
      version: report.version,
    },
    {
      mode: "development",
      scope: "source-only",
      status: "partial",
      ok: false,
      sourceChecksOk: true,
      releaseReady: false,
      version: "0.1.0",
    },
  );
});

test("process runner forwards only the supported Playwright browser channel", async () => {
  for (const channel of ["chrome", "chromium"]) {
    const runner = createProcessRunner({
      environment: { PATH: process.env.PATH, HOME: "/tmp", PLAYWRIGHT_BROWSER_CHANNEL: channel },
    });
    const observed = await runner({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? 'missing')"],
      workingDirectory: process.cwd(),
      timeoutMs: 10_000,
    });
    assert.equal(observed.stdout, channel);
  }
  for (const value of ["", "edge", "Chrome", "chrome\0secret", 17]) {
    assert.throws(() => createProcessRunner({
      environment: { PATH: process.env.PATH, PLAYWRIGHT_BROWSER_CHANNEL: value },
    }), TypeError);
  }
});

test("a phase failure stops immediately and sanitizes all later phase state", async () => {
  const calls = [];
  const sentinel = "private-child-diagnostic-9173";
  const runner = async (invocation) => {
    calls.push(invocation);
    if (invocation.phase === "source" && invocation.args.includes("--check")) return result(versionOutput());
    if (invocation.phase === "java") return result("", { status: 17, stderr: sentinel });
    return result();
  };

  await assert.rejects(
    runPhases({ root: "/workspace/gauntlet", runner }),
    (error) => {
      assert.match(error.message, /java phase failed/u);
      assert.equal(error.code, "PHASE_FAILED");
      assert.equal(error.exitCode, 17);
      assert.equal(error.phase, "java");
      assert.deepEqual(error.report.phases.map(({ name }) => name), PHASES);
      assert.equal(error.report.phases.find(({ name }) => name === "java").status, "failed");
      assert.equal(error.report.phases.find(({ name }) => name === "conformance").reason, "short-circuited");
      assert.equal(JSON.stringify(error.report).includes(sentinel), false);
      return true;
    },
  );
  assert.equal(calls.some(({ phase }) => phase === "conformance"), false);
});

test("malformed command results and dishonest source-security summaries fail closed", async () => {
  const cases = [
    {
      name: "missing status",
      runner: async () => ({ signal: null, stdout: "", stderr: "" }),
      code: "MALFORMED_RESULT",
      phase: "source",
    },
    {
      name: "unexpected result property",
      runner: async () => ({ ...result(), diagnostic: "secret" }),
      code: "MALFORMED_RESULT",
      phase: "source",
    },
    {
      name: "security claims a complete pass",
      runner: async (invocation) => {
        if (invocation.phase === "source" && invocation.args.includes("--check")) return result(versionOutput());
        if (invocation.phase === "security") return result(sourceSecurityOutput({ ok: true }));
        return result();
      },
      code: "OUTPUT_INVALID",
      phase: "security",
    },
    {
      name: "security omits its managed reports",
      runner: async (invocation) => {
        if (invocation.phase === "source" && invocation.args.includes("--check")) return result(versionOutput());
        if (invocation.phase === "security") return result(sourceSecurityOutput({ reports: [] }));
        return result();
      },
      code: "OUTPUT_INVALID",
      phase: "security",
    },
  ];

  for (const scenario of cases) {
    await assert.rejects(
      runPhases({ root: "/workspace/gauntlet", runner: scenario.runner }),
      (error) => {
        assert.equal(error.code, scenario.code, scenario.name);
        assert.equal(error.phase, scenario.phase, scenario.name);
        return true;
      },
    );
  }
});

test("dependency options reject accessors without evaluating them", async () => {
  let accessed = false;
  const options = {
    root: "/workspace/gauntlet",
    get runner() {
      accessed = true;
      return async () => result();
    },
  };
  await assert.rejects(
    runPhases(options),
    (error) => error.code === "INVALID_OPTIONS" && error.phase === null,
  );
  assert.equal(accessed, false);
});

test("the verify CLI rejects arguments without execution and emits only bounded structured failures", async () => {
  let called = false;
  const invalid = await runVerifyCli(["--release"], {
    root: "/workspace/gauntlet",
    runner: async () => {
      called = true;
      return result();
    },
  });
  assert.equal(called, false);
  assert.deepEqual(invalid, {
    exitCode: 2,
    stdout: "",
    stderr: '{"error":{"code":"INVALID_ARGUMENTS","message":"Usage: verify.mjs"},"ok":false,"releaseReady":false}\n',
  });

  const failed = await runVerifyCli([], {
    root: "/workspace/gauntlet",
    runner: async () => {
      throw new Error("sensitive process detail");
    },
  });
  const parsed = JSON.parse(failed.stderr);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stdout, "");
  assert.deepEqual(parsed.error, {
    code: "EXECUTION_FAILED",
    message: "Release verification failed safely",
    phase: "source",
  });
  assert.equal(parsed.releaseReady, false);
  assert.equal(JSON.stringify(failed).includes("sensitive process detail"), false);
});
