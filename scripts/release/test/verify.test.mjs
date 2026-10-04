import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { allUnitsPlan, createReleasePlan } from "../plan.mjs";
import { RELEASE_UNITS } from "../units.mjs";
import {
  commandsForPhase,
  createProcessRunner,
  parseVerifyArguments,
  phasesForUnits,
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
const SET = "release-2026-10-03.1";
const SET_ROOT = `.artifacts/release/${SET}`;
const ALL_UNITS_PLAN = allUnitsPlan(new Map(RELEASE_UNITS.map(({ id }) => [id, "0.1.0"])));
const ALL_UNIT_IDS = ALL_UNITS_PLAN.order;

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

const RELEASE_SCOPE = Object.freeze({ releaseSet: SET, version: "0.1.0" });

test("publishes the exact release phase order and strict empty CLI", () => {
  assert.deepEqual(plannedReleasePhases(), PHASES);
  assert.deepEqual(parseVerifyArguments([]), { planPath: null });
  assert.deepEqual(parseVerifyArguments(["--plan", ".release/plan.json"]), { planPath: ".release/plan.json" });
  for (const invalid of [
    ["--help"], ["--release"], [undefined], "", ["--plan"], ["--plan", ""], ["--plan", "a", "--plan", "b"],
    ["--plan", "a", "extra"], ["--plan", "../outside.json"],
  ]) {
    assert.throws(() => parseVerifyArguments(invalid), /Usage: verify\.mjs/u);
  }

  assert.deepEqual(commandsForPhase("documentation", RELEASE_SCOPE), [
    ["pnpm", ["docs:check"]],
    ["pnpm", ["docs:verify-commands", "--release-root", SET_ROOT]],
  ]);
  assert.deepEqual(commandsForPhase("dashboard", RELEASE_SCOPE), [
    ["pnpm", ["--filter", "@8lines/gauntlet-dashboard", "build"]],
    ["pnpm", ["--filter", "@8lines/gauntlet-dashboard", "test"]],
    ["pnpm", ["dashboard:test:e2e"]],
  ]);
  assert.deepEqual(commandsForPhase("php", RELEASE_SCOPE), [
    ["pnpm", ["test:php:compatibility"]],
    ["pnpm", ["test:composer:consumer"]],
  ]);
  assert.deepEqual(commandsForPhase("node", RELEASE_SCOPE), [
    ["pnpm", ["verify:protocol-sdk", "--node-only"]],
  ]);
  assert.deepEqual(commandsForPhase("java", RELEASE_SCOPE), [
    [process.execPath, ["scripts/release/test-java-source.mjs"]],
    ["pnpm", ["test:java:release"]],
  ]);
  assert.deepEqual(commandsForPhase("inventory", RELEASE_SCOPE), [
    [process.execPath, [
      "scripts/release/verify-inventory.mjs",
      "--release-root",
      resolve(ROOT, SET_ROOT),
    ]],
  ]);
  assert.deepEqual(commandsForPhase("skills", RELEASE_SCOPE), [
    ["pnpm", ["skills:test-install"]],
    ["pnpm", ["skills:test-evals"]],
    ["pnpm", ["skills:validate"]],
    [process.execPath, ["--test", "scripts/skills/test/release-artifact.test.mjs"]],
  ]);
  assert.deepEqual(commandsForPhase("security", RELEASE_SCOPE), [
    [process.execPath, ["scripts/release/security.mjs", "--source-only"]],
    [process.execPath, ["scripts/release/security.mjs", "--image-archive", `${SET_ROOT}/image/gauntlet-0.1.0.docker.tar`]],
  ]);
  assert.throws(() => commandsForPhase("documentation"), /invalid/u);
  assert.throws(() => commandsForPhase("documentation", { version: "0.1.0" }), /release set is invalid/u);
  assert.throws(() => commandsForPhase("documentation", { releaseSet: "0.1.0", version: "0.1.0" }), /release set is invalid/u);
  assert.throws(() => commandsForPhase("documentation", { releaseSet: SET }), /version is invalid/u);
  assert.throws(() => commandsForPhase("deployment", RELEASE_SCOPE), /Unknown release phase/u);
});

test("development verification runs only source-safe work and reports explicit partial evidence", async () => {
  const calls = [];
  const report = await runPhases({ root: "/workspace/gauntlet", plan: ALL_UNITS_PLAN, runner: successfulRunner(calls) });

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
      units: report.units,
    },
    {
      mode: "development",
      scope: "source-only",
      status: "partial",
      ok: false,
      sourceChecksOk: true,
      releaseReady: false,
      version: "0.1.0",
      units: ALL_UNIT_IDS,
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
    runPhases({ root: "/workspace/gauntlet", plan: ALL_UNITS_PLAN, runner }),
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
      runPhases({ root: "/workspace/gauntlet", plan: ALL_UNITS_PLAN, runner: scenario.runner }),
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
    stderr: '{"error":{"code":"INVALID_ARGUMENTS","message":"Usage: verify.mjs [--plan PATH]"},"ok":false,"releaseReady":false}\n',
  });

  const failed = await runVerifyCli([], {
    root: "/workspace/gauntlet",
    plan: ALL_UNITS_PLAN,
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

test("a plan selects only the phases its units need", () => {
  assert.deepEqual(phasesForUnits(["gauntlet", "skills"]), [
    "source", "node", "skills", "dashboard", "image", "compose", "helm", "security", "inventory", "documentation",
  ]);
  assert.deepEqual(phasesForUnits(["php-core"]), ["source", "php", "conformance", "inventory", "documentation"]);
  assert.deepEqual(phasesForUnits(["protocol"]), ["source", "node", "conformance", "packages", "inventory", "documentation"]);
  assert.deepEqual(phasesForUnits(ALL_UNIT_IDS), PHASES);
  assert.throws(() => phasesForUnits(["unknown-unit"]), /Unknown release unit/u);
});

test("unneeded phases are skipped and never invoked", async () => {
  const calls = [];
  const plan = createReleasePlan([{ id: "php-core", from: "0.1.8", to: "0.1.9" }]);
  const report = await runPhases({ root: "/workspace/gauntlet", plan, runner: async (invocation) => {
    calls.push(invocation.phase);
    return { status: 0, signal: null, stderr: "", stdout: invocation.args[0] === "scripts/release/version.mjs"
      ? `${JSON.stringify({ command: "check", mismatches: [], ok: true, tag: null, version: "0.1.8" })}\n` : "" };
  } });
  assert.deepEqual([...new Set(calls)], ["source", "php", "conformance", "documentation"]);
  assert.deepEqual(report.units, ["php-core"]);
  assert.deepEqual(report.phases.find(({ name }) => name === "dashboard"), { name: "dashboard", status: "skipped", reason: "not-in-release-plan", commands: 0 });
  assert.deepEqual(
    Object.fromEntries(report.phases.map(({ name, status }) => [name, status])),
    {
      source: "passed", node: "skipped", php: "partial", java: "skipped", conformance: "passed", skills: "skipped",
      dashboard: "skipped", image: "skipped", compose: "skipped", helm: "skipped", security: "skipped",
      packages: "skipped", inventory: "not-run", documentation: "partial",
    },
  );
});

test("verification phases run with their raised timeouts", async () => {
  const calls = [];
  await runPhases({ root: "/workspace/gauntlet", plan: ALL_UNITS_PLAN, runner: successfulRunner(calls) });
  const timeouts = new Map(calls.map(({ phase, timeoutMs }) => [phase, timeoutMs]));
  assert.equal(timeouts.get("helm"), 60 * 60_000);
  assert.equal(timeouts.get("packages"), 60 * 60_000);
  assert.equal(timeouts.get("documentation"), 60 * 60_000);
  assert.equal(timeouts.get("security"), 90 * 60_000);
  assert.equal(timeouts.get("source"), 10 * 60_000);
});

test("runPhases requires a release plan with units", async () => {
  for (const plan of [undefined, null, { order: [] }, { order: ["unknown-unit"] }, createReleasePlan([])]) {
    await assert.rejects(
      runPhases({ root: "/workspace/gauntlet", plan, runner: async () => result() }),
      (error) => error.code === "INVALID_OPTIONS" && error.phase === null,
    );
  }
});

test("the verify CLI rejects an empty or unreadable plan without execution", async () => {
  let called = false;
  const runner = async () => {
    called = true;
    return result();
  };
  const empty = await runVerifyCli([], { root: "/workspace/gauntlet", plan: createReleasePlan([]), runner });
  assert.equal(empty.exitCode, 2);
  assert.deepEqual(JSON.parse(empty.stderr), {
    error: { code: "INVALID_ARGUMENTS", message: "Release plan has no units" }, ok: false, releaseReady: false,
  });
  const missing = await runVerifyCli(["--plan", "missing-plan.json"], { root: ROOT, runner });
  assert.equal(missing.exitCode, 2);
  assert.equal(JSON.parse(missing.stderr).error.code, "INVALID_ARGUMENTS");
  assert.equal(called, false);
});
