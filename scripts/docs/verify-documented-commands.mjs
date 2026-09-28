#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { parseDockerEndpoint } from "../run-compose-smoke.mjs";
import { readReleaseVersion, RELEASE_STAGE_ARTIFACT_COUNT } from "../release/release-model.mjs";
import { inspectDockerArchive } from "../release/stage-image.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const FAILURE = "Documented command verification failed closed";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const USAGE = "Usage: node scripts/docs/verify-documented-commands.mjs --release-root .artifacts/release/<VERSION>";
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;

function failClosed() {
  throw new Error(FAILURE);
}

function canonicalDirectory(path) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep) throw new Error();
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    return path;
  } catch {
    failClosed();
  }
}

function regularFile(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n
        || realpathSync(path) !== path) throw new Error();
    return path;
  } catch {
    failClosed();
  }
}

function command(phase, executable, args, workingDirectory, expectedStatus = 0) {
  return Object.freeze({
    phase,
    command: executable,
    args: Object.freeze([...args]),
    workingDirectory,
    expectedStatus,
  });
}

function deepFreezePlan(plan) {
  Object.freeze(plan.composeFiles);
  Object.freeze(plan.commands);
  return Object.freeze(plan);
}

export function planDocumentedCommandChecks({ root: rawRoot, releaseRoot: rawReleaseRoot, temporaryRoot: rawTemporaryRoot }) {
  try {
    const root = canonicalDirectory(rawRoot);
    const releaseRoot = canonicalDirectory(rawReleaseRoot);
    const temporaryRoot = canonicalDirectory(rawTemporaryRoot);
    const version = readReleaseVersion(root);
    if (releaseRoot !== resolve(root, ".artifacts/release", version)
        || temporaryRoot === root || temporaryRoot === releaseRoot
        || temporaryRoot.startsWith(`${releaseRoot}${sep}`)) failClosed();

    const imageArchive = regularFile(resolve(releaseRoot, "image", `gauntlet-${version}.docker.tar`));
    const chartArchive = regularFile(resolve(releaseRoot, "helm", `gauntlet-${version}.tgz`));
    const manifest = regularFile(resolve(releaseRoot, "release-manifest.json"));
    const checksums = regularFile(resolve(releaseRoot, "SHA256SUMS"));
    const composeFile = regularFile(resolve(root, "deploy/compose/compose.yaml"));
    const chartValues = regularFile(resolve(root, "deploy/helm/ci/staging-values.yaml"));
    const composeOverride = resolve(temporaryRoot, "compose.local-image.yaml");
    const renderedChart = resolve(temporaryRoot, "helm-rendered.yaml");
    const localImage = `gauntlet.local/gauntlet:${version}`;

    return deepFreezePlan({
      version,
      root,
      releaseRoot,
      temporaryRoot,
      imageArchive,
      localImage,
      chartArchive,
      chartValues,
      manifest,
      checksums,
      composeFiles: [composeFile, composeOverride],
      renderedChart,
      commands: [
        command(
          "inventory",
          process.execPath,
          [resolve(root, "scripts/release/verify-inventory.mjs"), "--release-root", releaseRoot],
          root,
        ),
        command("docker-context", "docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], root),
        command("docker-info", "docker", ["info", "--format", "{{json .ServerVersion}}"], root),
        command("image-absence", "docker", ["image", "inspect", localImage], root, 1),
        command("image-load", "docker", ["load", "--input", imageArchive], root),
        command(
          "image-label",
          "docker",
          ["image", "inspect", localImage, "--format", '{{ index .Config.Labels "org.opencontainers.image.version" }}'],
          root,
        ),
        command("helm-metadata", "helm", ["show", "chart", chartArchive], root),
        command(
          "helm-render",
          "helm",
          [
            "template", "gauntlet-docs", chartArchive,
            "--values", chartValues,
            "--kube-version", "1.35.0",
          ],
          root,
        ),
      ],
      imageReconcileCommand: command(
        "image-reconcile",
        "docker",
        ["image", "inspect", localImage, "--format", "{{.Id}}"],
        root,
      ),
      cleanupCommand: command("image-cleanup", "docker", ["image", "rm", localImage], root),
      cleanupAbsenceCommand: command(
        "image-cleanup-absence",
        "docker",
        ["image", "inspect", localImage, "--format", "{{.Id}}"],
        root,
        1,
      ),
    });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function defaultEnvironment(temporaryRoot) {
  if (typeof process.env.PATH !== "string" || process.env.PATH === "") failClosed();
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
    HELM_CACHE_HOME: resolve(temporaryRoot, "helm-cache"),
    HELM_CONFIG_HOME: resolve(temporaryRoot, "helm-config"),
    HELM_DATA_HOME: resolve(temporaryRoot, "helm-data"),
  };
}

export async function createDocumentedCommandRunner(environment = process.env) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)
      || typeof environment.PATH !== "string" || environment.PATH === "") failClosed();
  return async ({ command: executable, args, workingDirectory, temporaryRoot }) => spawnSync(executable, args, {
    cwd: workingDirectory,
    encoding: "utf8",
    env: {
      PATH: environment.PATH,
      HOME: environment.HOME,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      NO_COLOR: "1",
      HELM_CACHE_HOME: resolve(temporaryRoot, "helm-cache"),
      HELM_CONFIG_HOME: resolve(temporaryRoot, "helm-config"),
      HELM_DATA_HOME: resolve(temporaryRoot, "helm-data"),
    },
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    stdio: "pipe",
    timeout: 10 * 60_000,
    windowsHide: true,
  });
}

function validResult(value) {
  return value !== null && typeof value === "object" && value.error === undefined
    && Number.isInteger(value.status) && value.status >= 0 && value.status <= 255
    && value.signal === null && typeof value.stdout === "string" && typeof value.stderr === "string";
}

function parseHelmMetadata(source, version) {
  try {
    const value = parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || value.apiVersion !== "v2" || value.name !== "gauntlet"
        || value.version !== version || `${value.appVersion}` !== version) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function oneJsonLine(source) {
  if (typeof source !== "string" || !source.endsWith("\n") || source.includes("\r")
      || source.slice(0, -1).includes("\n")) failClosed();
  try {
    const value = JSON.parse(source.slice(0, -1));
    if (!hasExactKeys(value, [
      "schemaVersion", "ok", "version", "sourceCommit", "artifacts", "manifestSha256",
      "checksumsSha256", "nativeImage", "multiPlatformOci", "helmChart",
    ])) failClosed();
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function validArtifactEvidence(value, path) {
  return hasExactKeys(value, ["path", "sha256"])
    && value.path === path && typeof value.sha256 === "string" && SHA256.test(value.sha256);
}

function validateInventoryReport(result, version) {
  const value = oneJsonLine(result.stdout);
  if (result.stderr !== "" || value.schemaVersion !== 1 || value.ok !== true || value.version !== version
      || typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)
      || value.artifacts !== RELEASE_STAGE_ARTIFACT_COUNT
      || typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)
      || typeof value.checksumsSha256 !== "string" || !SHA256.test(value.checksumsSha256)
      || !validArtifactEvidence(value.nativeImage, `image/gauntlet-${version}.docker.tar`)
      || !validArtifactEvidence(value.helmChart, `helm/gauntlet-${version}.tgz`)
      || !hasExactKeys(value.multiPlatformOci, ["path", "sha256", "platforms", "verification"])
      || value.multiPlatformOci.path !== `image/gauntlet-${version}.oci.tar`
      || typeof value.multiPlatformOci.sha256 !== "string" || !SHA256.test(value.multiPlatformOci.sha256)
      || JSON.stringify(value.multiPlatformOci.platforms) !== JSON.stringify(["linux/amd64", "linux/arm64"])
      || value.multiPlatformOci.verification !== "deeply-validated-during-staging") failClosed();
  return value;
}

function hostDockerPlatform() {
  if (process.arch === "x64") return "linux/amd64";
  if (process.arch === "arm64") return "linux/arm64";
  failClosed();
}

function archiveRuntimeImageIds(value, plan, platform) {
  if (!hasExactKeys(value, ["platform", "runtimeImageIds", "tag"])
      || !Array.isArray(value.runtimeImageIds) || value.runtimeImageIds.length !== 2
      || !value.runtimeImageIds.every((imageId) => typeof imageId === "string" && IMAGE_ID.test(imageId))
      || value.runtimeImageIds[0] === value.runtimeImageIds[1]
      || value.platform !== platform || value.tag !== plan.localImage) failClosed();
  return Object.freeze([...value.runtimeImageIds]);
}

function validateRenderedChart(source, version) {
  try {
    if (typeof source !== "string" || source.length < 1 || Buffer.byteLength(source) > MAX_OUTPUT_BYTES) failClosed();
    const documents = source.split(/^---\s*$/mu)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => parse(part));
    const resources = documents.filter((value) => value !== null && typeof value === "object" && !Array.isArray(value));
    const deployment = resources.find(({ kind }) => kind === "Deployment");
    const service = resources.find(({ kind }) => kind === "Service");
    if (deployment?.spec?.replicas !== 1 || service?.spec?.type !== "ClusterIP"
        || resources.some(({ kind }) => ["Ingress", "ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding"].includes(kind))) {
      failClosed();
    }
    const containers = deployment?.spec?.template?.spec?.containers;
    if (!Array.isArray(containers) || containers.length !== 1
        || containers[0]?.image !== `ghcr.io/8lines/gauntlet:${version}`) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function validatePhaseOutput(phase, result, plan) {
  if (phase === "inventory") return validateInventoryReport(result, plan.version);
  if (phase === "docker-context") parseDockerEndpoint(result.stdout);
  if (phase === "docker-info" && !/^"[^"\r\n]+"\n?$/u.test(result.stdout)) failClosed();
  if (phase === "image-absence" && !/(?:No such image|No such object)/iu.test(result.stderr)) failClosed();
  if (phase === "image-load" && !result.stdout.includes(`Loaded image: ${plan.localImage}`)) failClosed();
  if (phase === "image-label" && result.stdout !== `${plan.version}\n`) failClosed();
  if (phase === "helm-metadata") parseHelmMetadata(result.stdout, plan.version);
  if (phase === "helm-render") validateRenderedChart(result.stdout, plan.version);
}

function failure(code, phase, exitCode = 1) {
  return Object.freeze({ code, exitCode, ok: false, phase });
}

function imageIsAbsent(result) {
  return validResult(result) && result.status === 1 && ["", "\n", "[]\n"].includes(result.stdout)
    && /(?:No such image|No such object)/iu.test(result.stderr);
}

function imageIdFromResult(result) {
  if (!validResult(result) || result.status !== 0 || result.stderr !== ""
      || !result.stdout.endsWith("\n") || result.stdout.slice(0, -1).includes("\n")
      || !IMAGE_ID.test(result.stdout.slice(0, -1))) failClosed();
  return result.stdout.slice(0, -1);
}

async function reconcileLoadedImage(execute, plan, expectedImageIds) {
  let current;
  try {
    current = await execute({ ...plan.imageReconcileCommand, temporaryRoot: plan.temporaryRoot });
  } catch {
    return false;
  }
  if (imageIsAbsent(current)) return true;
  let currentImageId;
  try {
    currentImageId = imageIdFromResult(current);
  } catch {
    return false;
  }
  if (!expectedImageIds.includes(currentImageId)) return false;

  try {
    await execute({ ...plan.cleanupCommand, temporaryRoot: plan.temporaryRoot });
  } catch { /* Reconcile the final state even if Docker's observation is unavailable. */ }

  let absent;
  try {
    absent = await execute({ ...plan.cleanupAbsenceCommand, temporaryRoot: plan.temporaryRoot });
  } catch {
    return false;
  }
  return imageIsAbsent(absent);
}

export async function runDocumentedCommandChecks(options) {
  let plan;
  try {
    const { archiveInspector, runner, ...paths } = options ?? {};
    plan = planDocumentedCommandChecks(paths);
    const execute = runner ?? await createDocumentedCommandRunner(defaultEnvironment(plan.temporaryRoot));
    const inspectArchive = archiveInspector ?? inspectDockerArchive;
    if (typeof execute !== "function" || typeof inspectArchive !== "function") {
      return failure("EXECUTION_FAILED", null);
    }
    const platform = hostDockerPlatform();
    let inventory;
    let expectedImageIds;
    let loadAttempted = false;
    let primary;
    try {
      for (const invocation of plan.commands) {
        if (invocation.phase === "image-load") {
          try {
            expectedImageIds = archiveRuntimeImageIds(await inspectArchive({
              archivePath: plan.imageArchive,
              platform,
              sourceCommit: inventory.sourceCommit,
              version: plan.version,
            }), plan, platform);
          } catch {
            primary = failure("OUTPUT_INVALID", "image-archive");
            break;
          }
          loadAttempted = true;
        }
        let result;
        try {
          result = await execute({ ...invocation, temporaryRoot: plan.temporaryRoot });
        } catch {
          primary = failure("EXECUTION_FAILED", invocation.phase);
          break;
        }
        if (!validResult(result)) {
          primary = failure("EXECUTION_FAILED", invocation.phase);
          break;
        }
        if (result.status !== invocation.expectedStatus) {
          primary = failure("PHASE_FAILED", invocation.phase, result.status);
          break;
        }
        try {
          const output = validatePhaseOutput(invocation.phase, result, plan);
          if (invocation.phase === "inventory") inventory = output;
        } catch {
          primary = failure("OUTPUT_INVALID", invocation.phase);
          break;
        }
      }
    } finally {
      if (loadAttempted && !await reconcileLoadedImage(execute, plan, expectedImageIds)) {
        primary = failure("CLEANUP_FAILED", "image-cleanup");
      }
    }
    return primary ?? Object.freeze({ exitCode: 0, ok: true });
  } catch {
    return failure("SETUP_FAILED", null);
  }
}

export function parseDocumentedCommandArguments(argv, root = ROOT) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--release-root"
      || typeof argv[1] !== "string" || argv[1] === "" || argv[1].includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(argv[1])) throw new TypeError(USAGE);
  const releaseRoot = isAbsolute(argv[1]) ? resolve(argv[1]) : resolve(root, argv[1]);
  let version;
  try {
    version = readReleaseVersion(root);
  } catch {
    throw new TypeError(USAGE);
  }
  if (releaseRoot !== resolve(root, ".artifacts/release", version)) throw new TypeError(USAGE);
  return { releaseRoot };
}

async function main() {
  let temporaryRoot;
  try {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { releaseRoot } = parseDocumentedCommandArguments(process.argv.slice(2));
    temporaryRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-doc-commands-")));
    for (const name of ["helm-cache", "helm-config", "helm-data"]) {
      mkdirSync(resolve(temporaryRoot, name), { mode: 0o700 });
    }
    const result = await runDocumentedCommandChecks({ root: ROOT, releaseRoot, temporaryRoot });
    if (result.ok) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stderr.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.exitCode;
    }
    try { rmSync(temporaryRoot, { recursive: true, force: false }); } catch { process.exitCode = 1; }
  } catch (error) {
    process.stderr.write(`${error instanceof TypeError ? USAGE : FAILURE}\n`);
    process.exitCode = error instanceof TypeError ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
