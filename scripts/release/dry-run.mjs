#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import { parse } from "yaml";

import { RELEASE_STAGE_ARTIFACT_COUNT } from "./release-model.mjs";
import { inspectDockerArchive } from "./stage-image.mjs";
import { createProcessRunner, plannedReleasePhases } from "./verify.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: dry-run.mjs";
const FAILURE = "Release dry-run failed safely";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TOKEN = /^[0-9a-f]{32}$/u;
const CONTAINER = /^gauntlet-release-registry-[0-9a-f]{24}$/u;
const PHASES = Object.freeze(plannedReleasePhases());

export const LOCAL_REGISTRY_IMAGE = "registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e";

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function stableVersion(value) {
  if (typeof value !== "string" || !STABLE_VERSION.test(value)) throw new TypeError();
  return value;
}

function canonicalAbsolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === sep
      || /[\u0000-\u001f\u007f,]/u.test(value)) throw new TypeError();
  return value;
}

function invocation(command, args, workingDirectory) {
  return Object.freeze({ command, args: Object.freeze([...args]), workingDirectory });
}

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))
      || actual.some((key) => typeof key !== "string" || !keys.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) return undefined;
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function validateWorkspace(value) {
  const workspace = exactObject(value, [
    "root", "registryStorage", "helmPullDirectory", "token", "device", "inode", "uid", "gid",
  ]);
  if (workspace === undefined) throw new TypeError();
  canonicalAbsolute(workspace.root);
  canonicalAbsolute(workspace.registryStorage);
  canonicalAbsolute(workspace.helmPullDirectory);
  if (workspace.registryStorage !== resolve(workspace.root, "registry")
      || workspace.helmPullDirectory !== resolve(workspace.root, "helm-pull")
      || !TOKEN.test(workspace.token) || !/^(?:0|[1-9][0-9]*)$/u.test(workspace.device)
      || !/^(?:0|[1-9][0-9]*)$/u.test(workspace.inode)
      || !Number.isSafeInteger(workspace.uid) || workspace.uid < 0
      || !Number.isSafeInteger(workspace.gid) || workspace.gid < 0) throw new TypeError();
  return Object.freeze({ ...workspace });
}

function registryContainerName(workspace) {
  const name = `gauntlet-release-registry-${workspace.token.slice(0, 24)}`;
  if (!CONTAINER.test(name)) throw new TypeError();
  return name;
}

export function createLocalRegistryPlan({ root: rawRoot, releaseRoot: rawReleaseRoot, version: rawVersion, workspace: rawWorkspace, port }) {
  const root = canonicalAbsolute(rawRoot);
  const releaseRoot = canonicalAbsolute(rawReleaseRoot);
  const version = stableVersion(rawVersion);
  const workspace = validateWorkspace(rawWorkspace);
  if (releaseRoot !== resolve(root, ".artifacts", "release", version)
      || !Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("Local registry plan is invalid");
  const containerName = registryContainerName(workspace);
  const ownerLabel = "dev.8lines.gauntlet.release-owner";
  const owner = `${ownerLabel}=${workspace.token}`;
  const host = `127.0.0.1:${port}`;
  const imageArchive = resolve(releaseRoot, "image", `gauntlet-${version}.docker.tar`);
  const chartArchive = resolve(releaseRoot, "helm", `gauntlet-${version}.tgz`);
  const sourceImage = `gauntlet.local/gauntlet:${version}`;
  const imageTag = `${host}/gauntlet:${version}`;
  const chartRepository = `oci://${host}/gauntlet-charts`;
  const pulledChart = resolve(workspace.helmPullDirectory, `gauntlet-${version}.tgz`);
  const dockerContext = invocation("docker", [
    "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}",
  ], root);
  const containerAbsent = invocation("docker", ["container", "inspect", containerName], root);
  const start = invocation("docker", [
    "run", "--detach",
    "--name", containerName,
    "--label", owner,
    "--publish", "127.0.0.1::5000",
    "--user", `${workspace.uid}:${workspace.gid}`,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--mount", `type=bind,src=${workspace.registryStorage},dst=/var/lib/registry`,
    LOCAL_REGISTRY_IMAGE,
  ], root);
  const portCommand = invocation("docker", ["port", containerName, "5000/tcp"], root);
  const ready = invocation("curl", [
    "--fail", "--silent", "--show-error", "--max-time", "2", `http://${host}/v2/`,
  ], root);
  const sourceAbsent = invocation("docker", ["image", "inspect", sourceImage, "--format", "{{.Id}}"], root);
  const load = invocation("docker", ["load", "--input", imageArchive], root);
  const sourceInspect = invocation("docker", ["image", "inspect", sourceImage, "--format", "{{.Id}}"], root);
  const tagAbsent = invocation("docker", ["image", "inspect", imageTag, "--format", "{{.Id}}"], root);
  const tag = invocation("docker", ["image", "tag", sourceImage, imageTag], root);
  const tagInspect = invocation("docker", ["image", "inspect", imageTag, "--format", "{{.Id}}"], root);
  const imagePush = invocation("docker", ["image", "push", imageTag], root);
  const tagRemove = invocation("docker", ["image", "rm", imageTag], root);
  const chartPush = invocation("helm", ["push", chartArchive, chartRepository, "--plain-http"], root);
  const chartPull = invocation("helm", [
    "pull", `${chartRepository}/gauntlet`, "--version", version,
    "--destination", workspace.helmPullDirectory, "--plain-http",
  ], root);
  const chartInspect = invocation("helm", ["show", "chart", pulledChart], root);
  const ownerInspect = invocation("docker", [
    "container", "inspect", "--format", `{{ index .Config.Labels \"${ownerLabel}\" }}`, containerName,
  ], root);
  const containerRemove = invocation("docker", ["rm", "--force", containerName], root);
  const sourceRemove = invocation("docker", ["image", "rm", sourceImage], root);
  const commands = Object.freeze([
    dockerContext, containerAbsent, start, portCommand, ready, sourceAbsent, load, sourceInspect, tagAbsent, tag, tagInspect,
    imagePush, tagRemove, chartPush, chartPull, chartInspect, ownerInspect, containerRemove, sourceRemove,
  ]);
  return Object.freeze({
    root,
    releaseRoot,
    version,
    workspace,
    containerName,
    ownerLabel,
    host,
    imageArchive,
    chartArchive,
    sourceImage,
    imageTag,
    chartRepository,
    pulledChart,
    dockerContext,
    containerAbsent,
    start,
    portCommand,
    ready,
    sourceAbsent,
    load,
    sourceInspect,
    tagAbsent,
    tag,
    tagInspect,
    imagePush,
    tagRemove,
    chartPush,
    chartPull,
    chartInspect,
    ownerInspect,
    containerRemove,
    sourceRemove,
    commands,
  });
}

function invocationKey(value) {
  return JSON.stringify([value.command, value.args, value.workingDirectory]);
}

export function assertLocalRegistryInvocation(candidate, plan) {
  try {
    const values = exactObject(candidate, ["command", "args", "workingDirectory"]);
    if (values === undefined || typeof values.command !== "string" || !Array.isArray(values.args)
        || values.args.some((argument) => typeof argument !== "string")
        || values.workingDirectory !== plan.root) throw new Error();
    if (plan.commands.some((allowed) => invocationKey(allowed) === invocationKey(values))) return;
    const digestReference = new RegExp(`^127\\.0\\.0\\.1:${plan.host.split(":")[1]}/gauntlet@sha256:[0-9a-f]{64}$`, "u");
    const dynamicImageCommand = values.command === "docker" && values.args[0] === "image"
      && (
        (values.args[1] === "pull" && values.args.length === 3 && digestReference.test(values.args[2]))
        || (values.args[1] === "inspect" && values.args.length === 5 && digestReference.test(values.args[2])
          && values.args[3] === "--format" && values.args[4] === "{{.Id}}")
        || (values.args[1] === "rm" && values.args.length === 3 && digestReference.test(values.args[2]))
      );
    if (!dynamicImageCommand) throw new Error();
  } catch {
    throw new Error("Local registry command is not allowed");
  }
}

export function parseDryRunArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new TypeError(USAGE);
  return {};
}

function defaultWorkspaceLifecycle() {
  return Object.freeze({
    outputExists: async (path) => {
      try {
        lstatSync(path);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw new Error(FAILURE);
      }
    },
    create: async () => {
      const temporary = realpathSync(tmpdir());
      const root = realpathSync(mkdtempSync(join(temporary, "gauntlet-release-dry-run-")));
      chmodSync(root, 0o700);
      const registryStorage = resolve(root, "registry");
      const helmPullDirectory = resolve(root, "helm-pull");
      for (const directory of [registryStorage, helmPullDirectory]) {
        mkdirSync(directory, { mode: 0o700 });
        chmodSync(directory, 0o700);
      }
      const stat = lstatSync(root, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root || (stat.mode & 0o077n) !== 0n) {
        throw new Error(FAILURE);
      }
      return {
        root,
        registryStorage,
        helmPullDirectory,
        token: randomBytes(16).toString("hex"),
        device: String(stat.dev),
        inode: String(stat.ino),
        uid: typeof process.getuid === "function" ? process.getuid() : Number(stat.uid),
        gid: typeof process.getgid === "function" ? process.getgid() : Number(stat.gid),
      };
    },
    remove: async (rawWorkspace) => {
      const workspace = validateWorkspace(rawWorkspace);
      const stat = lstatSync(workspace.root, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(workspace.root) !== workspace.root
          || String(stat.dev) !== workspace.device || String(stat.ino) !== workspace.inode) throw new Error(FAILURE);
      rmSync(workspace.root, { recursive: true, force: false });
      try {
        lstatSync(workspace.root);
        throw new Error(FAILURE);
      } catch (error) {
        if (error instanceof Error && error.message === FAILURE) throw error;
        if (error?.code !== "ENOENT") throw new Error(FAILURE);
      }
    },
  });
}

function validateLifecycle(value) {
  const lifecycle = exactObject(value, ["outputExists", "create", "remove"]);
  if (lifecycle === undefined || Object.values(lifecycle).some((entry) => typeof entry !== "function")) throw new TypeError();
  return lifecycle;
}

function optionsValues(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !["root", "runner", "workspace", "archiveInspector"].includes(key)
      || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) throw new TypeError();
  const root = canonicalAbsolute(descriptors.root?.value ?? ROOT);
  const runner = descriptors.runner?.value ?? createProcessRunner();
  const workspace = validateLifecycle(descriptors.workspace?.value ?? defaultWorkspaceLifecycle());
  const archiveInspector = descriptors.archiveInspector?.value ?? inspectDockerArchive;
  if (typeof runner !== "function" || typeof archiveInspector !== "function") throw new TypeError();
  return { root, runner, workspace, archiveInspector };
}

function closeCommandResult(value) {
  const result = exactObject(value, ["status", "signal", "stdout", "stderr"]);
  if (result === undefined || !Number.isInteger(result.status) || result.status < 0 || result.status > 255
      || result.signal !== null || typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) return undefined;
  return result;
}

function oneJsonLine(source) {
  if (typeof source !== "string" || !source.endsWith("\n") || source.slice(0, -1).includes("\n")) throw new Error();
  const value = JSON.parse(source.slice(0, -1));
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
  return value;
}

function freshRecords() {
  return PHASES.map((name) => ({ name, status: "not-run", reason: "not-reached" }));
}

function freezeRecords(records) {
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function dryReport(records, {
  ok, sourceChecksOk, status, version = null, sourceCommit = null, failure, evidence,
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    mode: "dry-run",
    scope: "complete-local-rehearsal",
    status,
    ok,
    sourceChecksOk,
    releaseReady: ok === true && records.every((record) => record.status === "passed"),
    version,
    sourceCommit,
    phases: freezeRecords(records),
    ...(failure === undefined ? {} : { failure: Object.freeze({ ...failure }) }),
    ...(evidence === undefined ? {} : { evidence: deepFreeze(evidence) }),
  });
}

class DryRunFailure extends Error {
  constructor(code, phase, exitCode, records, version, sourceCommit) {
    super(`${phase ?? "setup"} phase failed`);
    this.name = "DryRunFailure";
    this.code = code;
    this.phase = phase;
    this.exitCode = exitCode;
    this.report = dryReport(records, {
      ok: false,
      sourceChecksOk: false,
      status: "failed",
      version,
      sourceCommit,
      failure: { code, phase },
    });
  }
}

function markFailure(records, phase) {
  const failedIndex = PHASES.indexOf(phase);
  if (failedIndex >= 0) records[failedIndex] = { name: phase, status: "failed" };
  for (let index = failedIndex + 1; index < records.length; index += 1) {
    if (records[index].status === "not-run") {
      records[index] = { name: PHASES[index], status: "not-run", reason: "short-circuited" };
    }
  }
}

function failure(code, phase, exitCode, records, version, sourceCommit) {
  markFailure(records, phase);
  return new DryRunFailure(code, phase, exitCode, records, version, sourceCommit);
}

async function execute(runner, call, phase, records, state, { expectedStatus = 0 } = {}) {
  let raw;
  try {
    raw = await runner({ ...call, phase, timeoutMs: phase === "security" ? 90 * 60_000 : 30 * 60_000 });
  } catch {
    throw failure("EXECUTION_FAILED", phase, 1, records, state.version, state.sourceCommit);
  }
  const result = closeCommandResult(raw);
  if (result === undefined) throw failure("MALFORMED_RESULT", phase, 1, records, state.version, state.sourceCommit);
  if (result.status !== expectedStatus) {
    throw failure("PHASE_FAILED", phase, result.status === 0 ? 1 : result.status, records, state.version, state.sourceCommit);
  }
  return result;
}

async function executeRaw(runner, call, phase, records, state) {
  let raw;
  try {
    raw = await runner({ ...call, phase, timeoutMs: 30 * 60_000 });
  } catch {
    throw failure("EXECUTION_FAILED", phase, 1, records, state.version, state.sourceCommit);
  }
  const result = closeCommandResult(raw);
  if (result === undefined) throw failure("MALFORMED_RESULT", phase, 1, records, state.version, state.sourceCommit);
  return result;
}

function parseVersionOutput(result) {
  const value = oneJsonLine(result.stdout);
  if (result.stderr !== "" || value.command !== "check" || value.ok !== true || value.tag !== null
      || !Array.isArray(value.mismatches) || value.mismatches.length !== 0) throw new Error();
  return stableVersion(value.version);
}

async function observeSource(root, runner, records, state, initial) {
  const calls = {
    root: invocation("git", ["-C", root, "rev-parse", "--show-toplevel"], root),
    head: invocation("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], root),
    status: invocation("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], root),
    version: invocation(process.execPath, [resolve(root, "scripts/release/version.mjs"), "--check"], root),
  };
  const topLevel = await execute(runner, calls.root, "source", records, state);
  const head = await execute(runner, calls.head, "source", records, state);
  const status = await execute(runner, calls.status, "source", records, state);
  const versionResult = await execute(runner, calls.version, "source", records, state);
  let version;
  try {
    if (topLevel.stderr !== "" || topLevel.stdout !== `${root}\n` || head.stderr !== ""
        || !FULL_COMMIT.test(head.stdout.slice(0, -1)) || head.stdout !== `${head.stdout.slice(0, -1)}\n`)
      throw new Error();
    version = parseVersionOutput(versionResult);
  } catch {
    throw failure("OUTPUT_INVALID", "source", 1, records, state.version, state.sourceCommit);
  }
  const sourceCommit = head.stdout.slice(0, -1);
  if (status.stdout !== "" || status.stderr !== "") {
    throw failure(initial ? "SOURCE_NOT_CLEAN" : "SOURCE_MUTATED", "source", 1, records, state.version, state.sourceCommit);
  }
  if (!initial && (sourceCommit !== state.sourceCommit || version !== state.version)) {
    throw failure("SOURCE_MUTATED", "source", 1, records, state.version, state.sourceCommit);
  }
  return { sourceCommit, version };
}

function validateDevelopmentReport(result, version) {
  const value = oneJsonLine(result.stdout);
  const expectedStatus = new Map([
    ["source", "passed"], ["node", "passed"], ["php", "partial"], ["java", "partial"],
    ["conformance", "passed"], ["skills", "passed"], ["dashboard", "passed"], ["image", "passed"],
    ["compose", "passed"], ["helm", "passed"], ["security", "partial"], ["packages", "partial"],
    ["inventory", "not-run"], ["documentation", "partial"],
  ]);
  if (result.stderr !== "" || value.schemaVersion !== 1 || value.mode !== "development"
      || value.scope !== "source-only" || value.status !== "partial" || value.ok !== false
      || value.sourceChecksOk !== true || value.releaseReady !== false || value.version !== version
      || !Array.isArray(value.phases) || value.phases.length !== PHASES.length
      || value.phases.some((phase, index) => phase?.name !== PHASES[index]
        || phase.status !== expectedStatus.get(phase.name))) throw new Error();
  return value;
}

function validateStageOutput(result, root, releaseRoot, version, sourceCommit) {
  const value = oneJsonLine(result.stdout);
  const output = exactObject(value, ["artifacts", "outputDirectory", "sourceCommit", "version"]);
  if (result.stderr !== "" || output === undefined || output.artifacts !== RELEASE_STAGE_ARTIFACT_COUNT
      || output.outputDirectory !== releaseRoot || output.sourceCommit !== sourceCommit || output.version !== version
      || releaseRoot !== resolve(root, ".artifacts", "release", version)) throw new Error();
}

function validateSecurityOutput(result, sourceCommit) {
  const value = oneJsonLine(result.stdout);
  const checks = [
    "source-snapshot", "composer-audit", "credential-material", "pnpm-audit", "production-defaults",
    "trivy-filesystem", "trivy-image",
  ];
  const reports = [
    "composer-audit.json",
    "credential-material.json",
    "pnpm-audit.json",
    "production-defaults.json",
    "source-snapshot.json",
    "trivy-filesystem.json",
    "trivy-image.json",
  ];
  if (result.stderr !== "" || value.schemaVersion !== 1 || value.mode !== "release"
      || value.scope !== "exact-commit-and-staged-image" || value.sourceCommit !== sourceCommit
      || value.sourceChecksOk !== true || value.ok !== true || !Array.isArray(value.checks)
      || value.checks.length !== checks.length || value.checks.some((check, index) =>
        check?.name !== checks[index] || check.required !== true || check.status !== "passed")
      || JSON.stringify(value.reports) !== JSON.stringify(reports)) throw new Error();
}

function exactArtifactEvidence(value, expectedPath) {
  const artifact = exactObject(value, ["path", "sha256"]);
  if (artifact === undefined || artifact.path !== expectedPath
      || typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) throw new Error();
  return Object.freeze(artifact);
}

function validateInventoryOutput(result, version, sourceCommit) {
  const value = oneJsonLine(result.stdout);
  const report = exactObject(value, [
    "schemaVersion", "ok", "version", "sourceCommit", "artifacts", "manifestSha256", "checksumsSha256",
    "nativeImage", "multiPlatformOci", "helmChart",
  ]);
  if (result.stderr !== "" || report === undefined || report.schemaVersion !== 1 || report.ok !== true
      || report.version !== version || report.sourceCommit !== sourceCommit
      || report.artifacts !== RELEASE_STAGE_ARTIFACT_COUNT
      || typeof report.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(report.manifestSha256)
      || typeof report.checksumsSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(report.checksumsSha256)) throw new Error();
  const nativeImage = exactArtifactEvidence(report.nativeImage, `image/gauntlet-${version}.docker.tar`);
  const helmChart = exactArtifactEvidence(report.helmChart, `helm/gauntlet-${version}.tgz`);
  const oci = exactObject(report.multiPlatformOci, ["path", "sha256", "platforms", "verification"]);
  if (oci === undefined || oci.path !== `image/gauntlet-${version}.oci.tar`
      || typeof oci.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(oci.sha256)
      || JSON.stringify(oci.platforms) !== JSON.stringify(["linux/amd64", "linux/arm64"])
      || oci.verification !== "deeply-validated-during-staging") throw new Error();
  return Object.freeze({
    artifacts: RELEASE_STAGE_ARTIFACT_COUNT,
    manifestSha256: report.manifestSha256,
    checksumsSha256: report.checksumsSha256,
    nativeImage,
    multiPlatformOci: Object.freeze({
      path: oci.path,
      sha256: oci.sha256,
      platforms: Object.freeze([...oci.platforms]),
      verification: oci.verification,
    }),
    helmChart,
  });
}

function validateDocumentationOutput(result, releaseRoot) {
  const value = oneJsonLine(result.stdout);
  const expectedStderr = `$ node scripts/docs/verify-documented-commands.mjs --release-root ${releaseRoot}\n`;
  if (result.stderr !== expectedStderr || Object.keys(value).sort().join(",") !== "exitCode,ok"
      || value.exitCode !== 0 || value.ok !== true) throw new Error();
}

function absentResultIsValid(result, kind) {
  return result.status === 1 && ["", "\n", "[]\n"].includes(result.stdout)
    && new RegExp(`No such (?:${kind}|object)`, "iu").test(result.stderr);
}

function imageId(result) {
  if (result.status !== 0 || result.stderr !== "" || !SHA256.test(result.stdout.slice(0, -1))
      || result.stdout !== `${result.stdout.slice(0, -1)}\n`) throw new Error();
  return result.stdout.slice(0, -1);
}

function verifiedRuntimeImageIds(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 3 || !keys.includes("0") || !keys.includes("1") || !keys.includes("length")
      || descriptors["0"].enumerable !== true || !("value" in descriptors["0"])
      || descriptors["1"].enumerable !== true || !("value" in descriptors["1"])
      || descriptors.length.enumerable !== false || !("value" in descriptors.length)
      || descriptors.length.value !== 2) throw new TypeError();
  const ids = [descriptors["0"].value, descriptors["1"].value];
  if (ids.some((id) => typeof id !== "string" || !SHA256.test(id)) || ids[0] === ids[1]) throw new TypeError();
  return Object.freeze(ids);
}

function parsePort(result) {
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})\n$/u.exec(result.stdout);
  const port = Number(match?.[1]);
  if (result.status !== 0 || result.stderr !== "" || match === null || port > 65_535) throw new Error();
  return port;
}

function validateDockerContext(result) {
  let endpoint;
  try { endpoint = JSON.parse(result.stdout.trim()); } catch { throw new Error(); }
  if (result.stderr !== "" || typeof endpoint !== "string"
      || !/^unix:\/\/\/[^\u0000-\u0020\u007f]+$/u.test(endpoint)) throw new Error();
}

function localImagePlatform() {
  if (process.arch === "x64") return "linux/amd64";
  if (process.arch === "arm64") return "linux/arm64";
  throw new Error();
}

function parsePushDigest(result, imageTag) {
  const escapedVersion = imageTag.slice(imageTag.lastIndexOf(":") + 1).replaceAll(".", "\\.");
  const matches = [...result.stdout.matchAll(new RegExp(`^${escapedVersion}: digest: (sha256:[0-9a-f]{64}) size: [1-9][0-9]*$`, "gmu"))];
  if (result.stderr !== "" || matches.length !== 1) throw new Error();
  return matches[0][1];
}

function validateImageRemoval(result, reference) {
  if (result.status !== 0 || result.stderr !== "" || !result.stdout.split("\n").some((line) => line === `Untagged: ${reference}`)) {
    throw new Error();
  }
}

function validateImagePull(result, reference, digest) {
  if (result.stderr !== "" || !result.stdout.includes(`Digest: ${digest}\n`)
      || !result.stdout.includes(reference)) throw new Error();
}

function helmStatusOutput(result) {
  const outputs = [result.stdout, result.stderr].filter((output) => output !== "");
  if (outputs.length !== 1) throw new Error();
  return outputs[0];
}

function validateChartPush(result, plan) {
  const output = helmStatusOutput(result);
  const prefix = `Pushed: ${plan.host}/gauntlet-charts/gauntlet:${plan.version}\nDigest: `;
  if (!output.startsWith(prefix)) throw new Error();
  const digest = output.slice(prefix.length).trimEnd();
  if (!SHA256.test(digest) || output !== `${prefix}${digest}\n`) throw new Error();
  return digest;
}

function validateChartPull(result, plan, digest) {
  const expected = `Pulled: ${plan.host}/gauntlet-charts/gauntlet:${plan.version}\nDigest: ${digest}\n`;
  if (helmStatusOutput(result) !== expected) throw new Error();
}

function validateChart(result, version) {
  try {
    if (result.stderr !== "" || result.stdout === "" || result.stdout.includes("\r")) throw new Error();
    const metadata = parse(result.stdout);
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)
        || metadata.apiVersion !== "v2" || metadata.name !== "gauntlet"
        || metadata.version !== version || `${metadata.appVersion}` !== version) throw new Error();
  } catch {
    throw new Error();
  }
}

async function cleanupCommand(runner, call, phase) {
  try {
    return closeCommandResult(await runner({ ...call, phase, timeoutMs: 30 * 60_000 }));
  } catch {
    return undefined;
  }
}

async function removeOwnedImage({ reference, expectedIds, plan, runner }) {
  const inspect = invocation("docker", ["image", "inspect", reference, "--format", "{{.Id}}"], plan.root);
  assertLocalRegistryInvocation(inspect, plan);
  const current = await cleanupCommand(runner, inspect, "image");
  if (current === undefined) return false;
  if (absentResultIsValid(current, "image")) return true;
  let id;
  try { id = imageId(current); } catch { return false; }
  if (!expectedIds.includes(id)) return false;
  const remove = invocation("docker", ["image", "rm", reference], plan.root);
  assertLocalRegistryInvocation(remove, plan);
  await cleanupCommand(runner, remove, "image");
  const after = await cleanupCommand(runner, inspect, "image");
  return after !== undefined && absentResultIsValid(after, "image");
}

async function cleanupRegistry(resources, runner, workspaceLifecycle, records, state) {
  let clean = true;
  if (resources.plan !== undefined) {
    for (const [reference, expectedIds] of [...resources.images.entries()].toReversed()) {
      try {
        clean = await removeOwnedImage({ reference, expectedIds, plan: resources.plan, runner }) && clean;
      } catch {
        clean = false;
      }
    }
    if (resources.containerAttempted) {
      try {
        assertLocalRegistryInvocation(resources.plan.ownerInspect, resources.plan);
        const ownership = await executeRaw(runner, resources.plan.ownerInspect, "image", records, state);
        if (ownership.status === 0 && ownership.stderr === "" && ownership.stdout === `${resources.plan.workspace.token}\n`) {
          assertLocalRegistryInvocation(resources.plan.containerRemove, resources.plan);
          const removed = await executeRaw(runner, resources.plan.containerRemove, "image", records, state);
          clean = removed.status === 0 && removed.stderr === ""
            && removed.stdout === `${resources.plan.containerName}\n` && clean;
        } else if (!(ownership.status === 1 && !resources.containerStarted
            && absentResultIsValid(ownership, "container"))) {
          clean = false;
        }
      } catch {
        clean = false;
      }
    }
  }
  if (resources.workspace !== undefined) {
    try { await workspaceLifecycle.remove(resources.workspace); } catch { clean = false; }
  }
  return clean;
}

async function rehearseRegistry({
  root, releaseRoot, version, runner, workspaceLifecycle, records, state, inventory, archive,
}) {
  let rawWorkspace;
  try {
    rawWorkspace = await workspaceLifecycle.create();
  } catch {
    throw failure("EXECUTION_FAILED", "image", 1, records, version, state.sourceCommit);
  }
  let workspace;
  try {
    workspace = validateWorkspace(rawWorkspace);
  } catch {
    try {
      await workspaceLifecycle.remove(rawWorkspace);
    } catch {
      throw failure("CLEANUP_FAILED", "image", 1, records, version, state.sourceCommit);
    }
    throw failure("MALFORMED_RESULT", "image", 1, records, version, state.sourceCommit);
  }
  const resources = {
    workspace,
    plan: createLocalRegistryPlan({ root, releaseRoot, version, workspace, port: 1 }),
    containerAttempted: false,
    containerStarted: false,
    images: new Map(),
  };
  let primary;
  try {
    let result;
    assertLocalRegistryInvocation(resources.plan.dockerContext, resources.plan);
    result = await execute(runner, resources.plan.dockerContext, "image", records, state);
    try { validateDockerContext(result); } catch {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }
    assertLocalRegistryInvocation(resources.plan.containerAbsent, resources.plan);
    result = await executeRaw(runner, resources.plan.containerAbsent, "image", records, state);
    if (result.status === 0) throw failure("RESOURCE_OCCUPIED", "image", 1, records, version, state.sourceCommit);
    if (!absentResultIsValid(result, "container")) throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);

    resources.containerAttempted = true;
    assertLocalRegistryInvocation(resources.plan.start, resources.plan);
    result = await execute(runner, resources.plan.start, "image", records, state);
    resources.containerStarted = true;
    // A cold local cache makes Docker pull the pinned registry digest and emit progress on stderr.
    // The exact container id, local-daemon check, ownership label, and readiness probe remain authoritative.
    if (!/^[0-9a-f]{64}\n$/u.test(result.stdout)) {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }
    assertLocalRegistryInvocation(resources.plan.portCommand, resources.plan);
    result = await execute(runner, resources.plan.portCommand, "image", records, state);
    let port;
    try { port = parsePort(result); } catch {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }
    resources.plan = createLocalRegistryPlan({ root, releaseRoot, version, workspace, port });

    let ready = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assertLocalRegistryInvocation(resources.plan.ready, resources.plan);
      const readiness = await executeRaw(runner, resources.plan.ready, "image", records, state);
      if (readiness.status === 0) {
        if (readiness.stderr !== "" || !/^\{\}\n?$/u.test(readiness.stdout)) {
          throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
        }
        ready = true;
        break;
      }
      if (attempt < 19) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (!ready) throw failure("PHASE_FAILED", "image", 1, records, version, state.sourceCommit);

    for (const absent of [resources.plan.sourceAbsent, resources.plan.tagAbsent]) {
      assertLocalRegistryInvocation(absent, resources.plan);
      result = await executeRaw(runner, absent, "image", records, state);
      if (result.status === 0) throw failure("RESOURCE_OCCUPIED", "image", 1, records, version, state.sourceCommit);
      if (!absentResultIsValid(result, "image")) {
        throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
      }
    }

    resources.images.set(resources.plan.sourceImage, archive.runtimeImageIds);
    assertLocalRegistryInvocation(resources.plan.load, resources.plan);
    const loaded = await execute(runner, resources.plan.load, "image", records, state);
    assertLocalRegistryInvocation(resources.plan.sourceInspect, resources.plan);
    result = await execute(runner, resources.plan.sourceInspect, "image", records, state);
    let sourceId;
    try { sourceId = imageId(result); } catch {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }
    if (!archive.runtimeImageIds.includes(sourceId)) {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }
    resources.images.set(resources.plan.sourceImage, Object.freeze([sourceId]));
    if (loaded.stderr !== "" || loaded.stdout !== `Loaded image: ${resources.plan.sourceImage}\n`) {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }

    resources.images.set(resources.plan.imageTag, Object.freeze([sourceId]));
    assertLocalRegistryInvocation(resources.plan.tag, resources.plan);
    const tagged = await execute(runner, resources.plan.tag, "image", records, state);
    assertLocalRegistryInvocation(resources.plan.tagInspect, resources.plan);
    result = await execute(runner, resources.plan.tagInspect, "image", records, state);
    let tagId;
    try { tagId = imageId(result); } catch {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }
    if (tagged.stdout !== "" || tagged.stderr !== "" || tagId !== sourceId) {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }

    assertLocalRegistryInvocation(resources.plan.imagePush, resources.plan);
    const pushed = await execute(runner, resources.plan.imagePush, "image", records, state);
    let digest;
    try { digest = parsePushDigest(pushed, resources.plan.imageTag); } catch {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }
    if (!await removeOwnedImage({
      reference: resources.plan.imageTag,
      expectedIds: Object.freeze([sourceId]),
      plan: resources.plan,
      runner,
    })) throw failure("CLEANUP_FAILED", "image", 1, records, version, state.sourceCommit);
    resources.images.delete(resources.plan.imageTag);

    const digestReference = `${resources.plan.host}/gauntlet@${digest}`;
    const digestInspect = invocation("docker", ["image", "inspect", digestReference, "--format", "{{.Id}}"], root);
    assertLocalRegistryInvocation(digestInspect, resources.plan);
    result = await executeRaw(runner, digestInspect, "image", records, state);
    if (result.status === 0) throw failure("RESOURCE_OCCUPIED", "image", 1, records, version, state.sourceCommit);
    if (!absentResultIsValid(result, "image")) throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    const pull = invocation("docker", ["image", "pull", digestReference], root);
    resources.images.set(digestReference, Object.freeze([sourceId]));
    assertLocalRegistryInvocation(pull, resources.plan);
    const pulled = await execute(runner, pull, "image", records, state);
    result = await execute(runner, digestInspect, "image", records, state);
    let pulledId;
    try { pulledId = imageId(result); validateImagePull(pulled, digestReference, digest); } catch {
      throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    }
    if (pulledId !== sourceId) throw failure("OUTPUT_INVALID", "image", 1, records, version, state.sourceCommit);
    records[PHASES.indexOf("image")] = { name: "image", status: "passed" };
    assertLocalRegistryInvocation(resources.plan.chartPush, resources.plan);
    result = await execute(runner, resources.plan.chartPush, "helm", records, state);
    let chartDigest;
    try { chartDigest = validateChartPush(result, resources.plan); } catch {
      throw failure("OUTPUT_INVALID", "helm", 1, records, version, state.sourceCommit);
    }
    assertLocalRegistryInvocation(resources.plan.chartPull, resources.plan);
    result = await execute(runner, resources.plan.chartPull, "helm", records, state);
    try { validateChartPull(result, resources.plan, chartDigest); } catch {
      throw failure("OUTPUT_INVALID", "helm", 1, records, version, state.sourceCommit);
    }
    assertLocalRegistryInvocation(resources.plan.chartInspect, resources.plan);
    result = await execute(runner, resources.plan.chartInspect, "helm", records, state);
    try { validateChart(result, version); } catch {
      throw failure("OUTPUT_INVALID", "helm", 1, records, version, state.sourceCommit);
    }
    records[PHASES.indexOf("helm")] = { name: "helm", status: "passed" };
    return Object.freeze({
      scope: "host-platform-native-image-and-version-bound-helm-chart",
      nativeImage: Object.freeze({
        ...inventory.nativeImage,
        platform: archive.platform,
        pushedDigest: digest,
        pulledDigest: digest,
      }),
      multiPlatformOci: Object.freeze({
        ...inventory.multiPlatformOci,
        registryRehearsal: "not-pushed-or-pulled-locally",
      }),
      helmChart: Object.freeze({
        ...inventory.helmChart,
        pushedDigest: chartDigest,
        pulledBy: `version:${version}`,
      }),
    });
  } catch (error) {
    primary = error instanceof DryRunFailure
      ? error
      : failure("EXECUTION_FAILED", "image", 1, records, version, state.sourceCommit);
  } finally {
    const clean = await cleanupRegistry(resources, runner, workspaceLifecycle, records, state);
    if (!clean) throw failure("CLEANUP_FAILED", "image", 1, records, version, state.sourceCommit);
  }
  if (primary !== undefined) throw primary;
}

export async function runDryRun(options = {}) {
  const records = freshRecords();
  const state = { version: null, sourceCommit: null };
  let values;
  try { values = optionsValues(options); } catch {
    throw failure("INVALID_OPTIONS", null, 1, records, state.version, state.sourceCommit);
  }
  const { root, runner, workspace, archiveInspector } = values;
  let observed = await observeSource(root, runner, records, state, true);
  state.version = observed.version;
  state.sourceCommit = observed.sourceCommit;
  const releaseRoot = resolve(root, ".artifacts", "release", state.version);
  let occupied;
  try { occupied = await workspace.outputExists(releaseRoot); } catch {
    throw failure("EXECUTION_FAILED", "source", 1, records, state.version, state.sourceCommit);
  }
  if (typeof occupied !== "boolean") {
    throw failure("MALFORMED_RESULT", "source", 1, records, state.version, state.sourceCommit);
  }
  if (occupied) throw failure("OUTPUT_OCCUPIED", "source", 1, records, state.version, state.sourceCommit);

  const verifyCall = invocation(process.execPath, [resolve(root, "scripts/release/verify.mjs")], root);
  const verifyResult = await execute(runner, verifyCall, "source", records, state);
  let development;
  try { development = validateDevelopmentReport(verifyResult, state.version); } catch {
    throw failure("OUTPUT_INVALID", "source", 1, records, state.version, state.sourceCommit);
  }
  for (const [index, phase] of development.phases.entries()) {
    records[index] = { name: phase.name, status: phase.status };
  }
  records[0] = { name: "source", status: "passed" };
  for (const phase of ["image", "helm"]) {
    records[PHASES.indexOf(phase)] = { name: phase, status: "not-run", reason: "release-rehearsal-not-reached" };
  }

  observed = await observeSource(root, runner, records, state, false);
  if (observed.sourceCommit !== state.sourceCommit || observed.version !== state.version) {
    throw failure("SOURCE_MUTATED", "source", 1, records, state.version, state.sourceCommit);
  }

  const composer = invocation("pnpm", ["test:composer:consumer"], root);
  await execute(runner, composer, "php", records, state);
  records[PHASES.indexOf("php")] = { name: "php", status: "passed" };

  const java = invocation("pnpm", ["test:java:release"], root);
  await execute(runner, java, "java", records, state);
  records[PHASES.indexOf("java")] = { name: "java", status: "passed" };

  const stage = invocation(process.execPath, [resolve(root, "scripts/release/stage.mjs"), "--output", releaseRoot], root);
  const staged = await execute(runner, stage, "packages", records, state);
  try { validateStageOutput(staged, root, releaseRoot, state.version, state.sourceCommit); } catch {
    throw failure("OUTPUT_INVALID", "packages", 1, records, state.version, state.sourceCommit);
  }
  records[PHASES.indexOf("packages")] = { name: "packages", status: "passed" };

  const relativeReleaseRoot = `.artifacts/release/${state.version}`;
  const imageArchive = `${relativeReleaseRoot}/image/gauntlet-${state.version}.docker.tar`;
  const security = invocation(process.execPath, [
    resolve(root, "scripts/release/security.mjs"), "--image-archive", imageArchive,
  ], root);
  const secured = await execute(runner, security, "security", records, state);
  try { validateSecurityOutput(secured, state.sourceCommit); } catch {
    throw failure("OUTPUT_INVALID", "security", 1, records, state.version, state.sourceCommit);
  }
  records[PHASES.indexOf("security")] = { name: "security", status: "passed" };

  const inventoryCall = invocation(process.execPath, [
    resolve(root, "scripts/release/verify-inventory.mjs"), "--release-root", releaseRoot,
  ], root);
  const checked = await execute(runner, inventoryCall, "inventory", records, state);
  let inventory;
  try { inventory = validateInventoryOutput(checked, state.version, state.sourceCommit); } catch {
    throw failure("OUTPUT_INVALID", "inventory", 1, records, state.version, state.sourceCommit);
  }
  records[PHASES.indexOf("inventory")] = { name: "inventory", status: "passed" };

  const documentation = invocation("pnpm", [
    "docs:verify-commands", "--release-root", relativeReleaseRoot,
  ], root);
  const documented = await execute(runner, documentation, "documentation", records, state);
  try { validateDocumentationOutput(documented, relativeReleaseRoot); } catch {
    throw failure("OUTPUT_INVALID", "documentation", 1, records, state.version, state.sourceCommit);
  }
  records[PHASES.indexOf("documentation")] = { name: "documentation", status: "passed" };

  let archive;
  try {
    archive = archiveInspector({
      archivePath: resolve(releaseRoot, inventory.nativeImage.path),
      platform: localImagePlatform(),
      sourceCommit: state.sourceCommit,
      version: state.version,
    });
    const expectedArchive = exactObject(archive, ["platform", "runtimeImageIds", "tag"]);
    const expectedPlatform = localImagePlatform();
    const runtimeImageIds = verifiedRuntimeImageIds(expectedArchive?.runtimeImageIds);
    if (expectedArchive === undefined || expectedArchive.platform !== expectedPlatform
        || expectedArchive.tag !== `gauntlet.local/gauntlet:${state.version}`
        || runtimeImageIds === undefined) throw new Error();
    archive = Object.freeze({ ...expectedArchive, runtimeImageIds });
  } catch {
    throw failure("OUTPUT_INVALID", "image", 1, records, state.version, state.sourceCommit);
  }

  const registryEvidence = await rehearseRegistry({
    root,
    releaseRoot,
    version: state.version,
    runner,
    workspaceLifecycle: workspace,
    records,
    state,
    inventory,
    archive,
  });

  observed = await observeSource(root, runner, records, state, false);
  if (observed.sourceCommit !== state.sourceCommit || observed.version !== state.version) {
    throw failure("SOURCE_MUTATED", "source", 1, records, state.version, state.sourceCommit);
  }
  if (!records.every(({ status }) => status === "passed")) {
    throw failure("EVIDENCE_INCOMPLETE", null, 1, records, state.version, state.sourceCommit);
  }
  return dryReport(records, {
    ok: true,
    sourceChecksOk: true,
    status: "passed",
    version: state.version,
    sourceCommit: state.sourceCommit,
    evidence: {
      inventory: {
        artifacts: inventory.artifacts,
        manifestSha256: inventory.manifestSha256,
        checksumsSha256: inventory.checksumsSha256,
      },
      localRegistryRehearsal: registryEvidence,
    },
  });
}

export async function runDryRunCli(argv, options = {}) {
  try { parseDryRunArguments(argv); } catch {
    return {
      exitCode: 2,
      stdout: "",
      stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false, releaseReady: false }),
    };
  }
  try {
    const result = await runDryRun(options);
    return { exitCode: 0, stdout: jsonLine(result), stderr: "" };
  } catch (error) {
    const code = error instanceof DryRunFailure ? error.code : "EXECUTION_FAILED";
    const phase = error instanceof DryRunFailure ? error.phase : null;
    const exitCode = error instanceof DryRunFailure ? error.exitCode : 1;
    const failureReport = error instanceof DryRunFailure ? error.report : undefined;
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
  const result = await runDryRunCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
