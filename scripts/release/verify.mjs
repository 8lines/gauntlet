#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder, types as utilTypes } from "node:util";

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: verify.mjs";
const FAILURE = "Release verification failed safely";
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

const PHASES = Object.freeze([
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
]);

const PHASE_TIMEOUTS = Object.freeze({
  source: 10 * 60_000,
  node: 35 * 60_000,
  php: 90 * 60_000,
  java: 60 * 60_000,
  conformance: 90 * 60_000,
  skills: 15 * 60_000,
  dashboard: 40 * 60_000,
  image: 45 * 60_000,
  compose: 45 * 60_000,
  helm: 30 * 60_000,
  security: 90 * 60_000,
  packages: 30 * 60_000,
  inventory: 10 * 60_000,
  documentation: 30 * 60_000,
});

const RELEASE_ONLY_EVIDENCE = Object.freeze({
  php: "committed-staged-composer-consumers",
  java: "committed-staged-java-consumers",
  security: "staged-image-security",
  packages: "canonical-staged-packages",
  inventory: "staged-inventory-and-checksums",
  documentation: "staged-documented-commands",
});

function command(id, executable, args, scope = "source") {
  return Object.freeze({ id, command: executable, args: Object.freeze([...args]), scope });
}

function phaseCommands(version, root = ROOT) {
  const releaseRoot = version === null ? null : `.artifacts/release/${version}`;
  const imageArchive = releaseRoot === null ? null : `${releaseRoot}/image/gauntlet-${version}.docker.tar`;
  return Object.freeze({
    source: Object.freeze([
      command("version", process.execPath, ["scripts/release/version.mjs", "--check"]),
      command("release-unit-tests", "pnpm", ["release:test"]),
    ]),
    node: Object.freeze([
      command("protocol-sdk", "pnpm", ["verify:protocol-sdk", "--node-only"]),
    ]),
    php: Object.freeze([
      command("php-compatibility", "pnpm", ["test:php:compatibility"]),
      ...(version === null ? [] : [
        command("composer-release-consumers", "pnpm", ["test:composer:consumer"], "release"),
      ]),
    ]),
    java: Object.freeze([
      command("java-source", process.execPath, ["scripts/release/test-java-source.mjs"]),
      ...(version === null ? [] : [
        command("java-release-consumers", "pnpm", ["test:java:release"], "release"),
      ]),
    ]),
    conformance: Object.freeze([
      command("official-adapters", "pnpm", ["verify:official-adapters"]),
    ]),
    skills: Object.freeze([
      command("skills-install", "pnpm", ["skills:test-install"]),
      command("skills-evaluations", "pnpm", ["skills:test-evals"]),
      command("skills-validation", "pnpm", ["skills:validate"]),
      command("skills-release-artifact", process.execPath, ["--test", "scripts/skills/test/release-artifact.test.mjs"]),
    ]),
    dashboard: Object.freeze([
      command("dashboard-build", "pnpm", ["--filter", "@8lines/gauntlet-dashboard", "build"]),
      command("dashboard-tests", "pnpm", ["--filter", "@8lines/gauntlet-dashboard", "test"]),
      command("dashboard-browser-tests", "pnpm", ["dashboard:test:e2e"]),
    ]),
    image: Object.freeze([
      command("product-image", "pnpm", ["test:image"]),
    ]),
    compose: Object.freeze([
      command("compose-distribution", "pnpm", ["test:compose:distribution"]),
      command("compose-smoke", "pnpm", ["smoke:compose"]),
    ]),
    helm: Object.freeze([
      command("helm-distribution", "pnpm", ["test:helm"]),
    ]),
    security: Object.freeze([
      command("source-security", process.execPath, ["scripts/release/security.mjs", "--source-only"]),
      ...(version === null ? [] : [
        command("release-security", process.execPath, [
          "scripts/release/security.mjs", "--image-archive", imageArchive,
        ], "release"),
      ]),
    ]),
    packages: Object.freeze([
      command("source-packages", "pnpm", ["test:packages"]),
    ]),
    inventory: Object.freeze(version === null ? [] : [
      command("release-inventory", process.execPath, [
        "scripts/release/verify-inventory.mjs", "--release-root", resolve(root, releaseRoot),
      ], "release"),
    ]),
    documentation: Object.freeze([
      command("documentation", "pnpm", ["docs:check"]),
      ...(version === null ? [] : [
        command("documented-commands", "pnpm", [
          "docs:verify-commands", "--release-root", releaseRoot,
        ], "release"),
      ]),
    ]),
  });
}

function stableVersion(value) {
  if (typeof value !== "string" || !STABLE_VERSION.test(value)) {
    throw new TypeError("Release verification version is invalid");
  }
  return value;
}

export function plannedReleasePhases() {
  return [...PHASES];
}

export function commandsForPhase(phase, { version } = {}) {
  if (typeof phase !== "string" || !PHASES.includes(phase)) throw new TypeError("Unknown release phase");
  const commands = phaseCommands(stableVersion(version))[phase];
  return commands.map(({ command: executable, args }) => [executable, [...args]]);
}

export function parseVerifyArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new TypeError(USAGE);
  return {};
}

function initialPhaseRecords() {
  return PHASES.map((name) => ({ name, status: "not-run", reason: "not-reached", commands: 0 }));
}

function frozenPhaseRecords(records) {
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
}

function report(records, { sourceChecksOk, status, version = null, failure } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    mode: "development",
    scope: "source-only",
    status,
    ok: false,
    sourceChecksOk,
    releaseReady: false,
    version,
    phases: frozenPhaseRecords(records),
    ...(failure === undefined ? {} : { failure: Object.freeze({ ...failure }) }),
  });
}

class VerificationFailure extends Error {
  constructor(code, phase, exitCode, records, version) {
    super(`${phase ?? "setup"} phase failed`);
    this.name = "VerificationFailure";
    this.code = code;
    this.phase = phase;
    this.exitCode = exitCode;
    this.report = report(records, {
      sourceChecksOk: false,
      status: "failed",
      version,
      failure: { code, phase },
    });
  }
}

function fail(code, phase, exitCode, records, version) {
  throw new VerificationFailure(code, phase, exitCode, records, version);
}

function closeResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = ["status", "signal", "stdout", "stderr"];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) return undefined;
  const result = Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
  if (!Number.isInteger(result.status) || result.status < 0 || result.status > 255
      || result.signal !== null || typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_COMMAND_OUTPUT_BYTES) return undefined;
  return result;
}

function oneJsonLine(source) {
  if (typeof source !== "string" || !source.endsWith("\n") || source.slice(0, -1).includes("\n")) throw new Error();
  const value = JSON.parse(source.slice(0, -1));
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
  return value;
}

function validateVersionOutput(result) {
  const value = oneJsonLine(result.stdout);
  if (result.stderr !== "" || value.command !== "check" || value.ok !== true || value.tag !== null
      || !Array.isArray(value.mismatches) || value.mismatches.length !== 0) throw new Error();
  return stableVersion(value.version);
}

function validateSourceSecurityOutput(result) {
  const value = oneJsonLine(result.stdout);
  const expectedChecks = [
    "source-snapshot",
    "composer-audit",
    "credential-material",
    "pnpm-audit",
    "production-defaults",
    "trivy-filesystem",
    "trivy-image",
  ];
  const expectedReports = [
    "composer-audit.json",
    "credential-material.json",
    "pnpm-audit.json",
    "production-defaults.json",
    "source-snapshot.json",
    "trivy-filesystem.json",
    "trivy-image.json",
  ];
  if (result.stderr !== "" || value.schemaVersion !== 1 || value.mode !== "source-only"
      || value.scope !== "working-tree-snapshot" || value.ok !== false || value.sourceChecksOk !== true
      || !Array.isArray(value.checks) || value.checks.length !== expectedChecks.length
      || value.checks.some((check, index) => check?.name !== expectedChecks[index])
      || value.checks.slice(0, -1).some((check) => check.required !== true || check.status !== "passed")
      || value.checks.at(-1)?.required !== false || value.checks.at(-1)?.status !== "not-run"
      || value.checks.at(-1)?.reason !== "excluded-by-source-only-mode"
      || JSON.stringify(value.reports) !== JSON.stringify(expectedReports)) throw new Error();
}

function validateCommandOutput(descriptor, result) {
  if (descriptor.id === "version") return validateVersionOutput(result);
  if (descriptor.id === "source-security") validateSourceSecurityOutput(result);
  return undefined;
}

function runOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !["root", "runner"].includes(key)
      || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) throw new TypeError();
  const root = descriptors.root?.value ?? ROOT;
  const runner = descriptors.runner?.value ?? createProcessRunner();
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/" || typeof runner !== "function") {
    throw new TypeError();
  }
  return { root, runner };
}

export async function runPhases(options = {}) {
  let root;
  let runner;
  const records = initialPhaseRecords();
  let version = null;
  try {
    ({ root, runner } = runOptions(options));
  } catch {
    fail("INVALID_OPTIONS", null, 1, records, version);
  }
  const commands = phaseCommands(null, root);

  for (let phaseIndex = 0; phaseIndex < PHASES.length; phaseIndex += 1) {
    const phase = PHASES[phaseIndex];
    const runnable = commands[phase].filter(({ scope }) => scope === "source");
    const excluded = RELEASE_ONLY_EVIDENCE[phase];
    if (runnable.length === 0) {
      records[phaseIndex] = {
        name: phase,
        status: "not-run",
        reason: "excluded-in-development-mode",
        commands: 0,
        excluded,
      };
      continue;
    }

    let completed = 0;
    for (const descriptor of runnable) {
      let raw;
      try {
        raw = await runner({
          phase,
          command: descriptor.command,
          args: [...descriptor.args],
          workingDirectory: root,
          timeoutMs: PHASE_TIMEOUTS[phase],
        });
      } catch {
        records[phaseIndex] = { name: phase, status: "failed", commands: completed };
        for (let index = phaseIndex + 1; index < records.length; index += 1) {
          records[index] = { name: PHASES[index], status: "not-run", reason: "short-circuited", commands: 0 };
        }
        fail("EXECUTION_FAILED", phase, 1, records, version);
      }
      const child = closeResult(raw);
      if (child === undefined) {
        records[phaseIndex] = { name: phase, status: "failed", commands: completed };
        for (let index = phaseIndex + 1; index < records.length; index += 1) {
          records[index] = { name: PHASES[index], status: "not-run", reason: "short-circuited", commands: 0 };
        }
        fail("MALFORMED_RESULT", phase, 1, records, version);
      }
      if (child.status !== 0) {
        records[phaseIndex] = { name: phase, status: "failed", commands: completed + 1 };
        for (let index = phaseIndex + 1; index < records.length; index += 1) {
          records[index] = { name: PHASES[index], status: "not-run", reason: "short-circuited", commands: 0 };
        }
        fail("PHASE_FAILED", phase, child.status, records, version);
      }
      try {
        const observedVersion = validateCommandOutput(descriptor, child);
        if (observedVersion !== undefined) version = observedVersion;
      } catch {
        records[phaseIndex] = { name: phase, status: "failed", commands: completed + 1 };
        for (let index = phaseIndex + 1; index < records.length; index += 1) {
          records[index] = { name: PHASES[index], status: "not-run", reason: "short-circuited", commands: 0 };
        }
        fail("OUTPUT_INVALID", phase, 1, records, version);
      }
      completed += 1;
    }
    records[phaseIndex] = excluded === undefined
      ? { name: phase, status: "passed", commands: completed }
      : {
          name: phase,
          status: "partial",
          reason: "release-evidence-excluded",
          commands: completed,
          excluded,
        };
  }

  if (version === null) fail("OUTPUT_INVALID", "source", 1, records, version);
  return report(records, { sourceChecksOk: true, status: "partial", version });
}

function safeEnvironment(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)
      || typeof source.PATH !== "string" || source.PATH === "" || source.PATH.includes("\0")) throw new TypeError();
  const environment = {
    PATH: source.PATH,
    HOME: typeof source.HOME === "string" ? source.HOME : "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    CI: "true",
    NO_COLOR: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of ["TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"]) {
    if (typeof source[name] === "string" && source[name] !== "" && !source[name].includes("\0")) environment[name] = source[name];
  }
  if (Object.hasOwn(source, "PLAYWRIGHT_BROWSER_CHANNEL")) {
    if (source.PLAYWRIGHT_BROWSER_CHANNEL !== "chrome" && source.PLAYWRIGHT_BROWSER_CHANNEL !== "chromium") {
      throw new TypeError();
    }
    environment.PLAYWRIGHT_BROWSER_CHANNEL = source.PLAYWRIGHT_BROWSER_CHANNEL;
  }
  return Object.freeze(environment);
}

export function createProcessRunner({
  environment = process.env,
  maximumOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
  terminationGraceMs = 1_000,
} = {}) {
  const childEnvironment = safeEnvironment(environment);
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) throw new TypeError();
  return async ({ command: executable, args, workingDirectory, timeoutMs }) => {
    if (typeof executable !== "string" || executable === "" || /[\u0000-\u001f\u007f]/u.test(executable)
        || !Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
        || typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error(FAILURE);
    return await new Promise((resolvePromise, rejectPromise) => {
      let child;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let failed = false;
      let killTimer;
      const terminate = () => {
        if (failed) return;
        failed = true;
        try {
          if (process.platform === "win32" || child?.pid === undefined) child?.kill("SIGTERM");
          else process.kill(-child.pid, "SIGTERM");
        } catch {
          try { child?.kill("SIGTERM"); } catch { /* The child may already have exited. */ }
        }
        killTimer = setTimeout(() => {
          try {
            if (process.platform === "win32" || child?.pid === undefined) child?.kill("SIGKILL");
            else process.kill(-child.pid, "SIGKILL");
          } catch {
            try { child?.kill("SIGKILL"); } catch { /* The child may already have exited. */ }
          }
        }, terminationGraceMs);
        killTimer.unref();
      };
      try {
        child = spawn(executable, args, {
          cwd: workingDirectory,
          detached: process.platform !== "win32",
          env: childEnvironment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        rejectPromise(new Error(FAILURE));
        return;
      }
      const append = (current, chunk) => {
        if (stdout.length + stderr.length + chunk.length > maximumOutputBytes) {
          terminate();
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      const deadline = setTimeout(terminate, timeoutMs);
      deadline.unref();
      child.once("error", terminate);
      child.once("close", (status, signal) => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        if (failed) {
          rejectPromise(new Error(FAILURE));
          return;
        }
        try {
          resolvePromise({ status, signal, stdout: UTF8.decode(stdout), stderr: UTF8.decode(stderr) });
        } catch {
          rejectPromise(new Error(FAILURE));
        }
      });
    });
  };
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export async function runVerifyCli(argv, options = {}) {
  try {
    parseVerifyArguments(argv);
  } catch {
    return {
      exitCode: 2,
      stdout: "",
      stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false, releaseReady: false }),
    };
  }
  try {
    const verification = await runPhases(options);
    return { exitCode: 0, stdout: jsonLine(verification), stderr: "" };
  } catch (error) {
    const code = error instanceof VerificationFailure ? error.code : "EXECUTION_FAILED";
    const phase = error instanceof VerificationFailure ? error.phase : null;
    const exitCode = error instanceof VerificationFailure ? error.exitCode : 1;
    const failureReport = error instanceof VerificationFailure ? error.report : undefined;
    return {
      exitCode,
      stdout: "",
      stderr: jsonLine({
        error: { code, message: FAILURE, phase },
        ...(failureReport ?? { ok: false, releaseReady: false }),
      }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runVerifyCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
