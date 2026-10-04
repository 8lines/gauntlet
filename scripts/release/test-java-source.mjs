#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import { parseReleaseVersion } from "./release-model.mjs";
import { MAVEN_TOOLCHAIN, MAVEN_UNIT_IDS } from "./stage-maven.mjs";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const PLAN_FAILURE = "Java source plan is invalid";
const ENDPOINT_FAILURE = "Java source verification requires a local Docker daemon";
const FAILURE = "Java source verification failed safely";
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const JAVA_VERSION_PATHS = Object.freeze({
  "java-core": "packages/java/core/VERSION",
  "spring-boot-starter": "packages/java/spring-boot-starter/VERSION",
});
const TOKEN = /^[0-9a-f]{32}$/u;
const LOCAL_DOCKER = /^unix:\/\/\/[^\u0000-\u0020\u007f]+$/u;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const PRIVATE_MODE = 0o700;
const MARKER_MODE = 0o600;
const WORKSPACE_MARKER = ".gauntlet-workspace-owner";
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SOURCE_INPUTS = Object.freeze([
  "LICENSE",
  "NOTICE",
  "packages/java",
  "packages/protocol/fixtures/v1",
]);
const GENERATED_INPUTS = Object.freeze([
  "packages/java/.gradle",
  "packages/java/.gradle-user",
  "packages/java/build",
  "packages/java/core/build",
  "packages/java/spring-boot-starter/build",
  "packages/java/spring-example/build",
  "packages/java/starter-api-consumer-test/build",
]);
const SOURCE_TASKS = Object.freeze([
  ":core:check",
  ":spring-boot-starter:check",
  ":spring-example:bootJar",
  ":starter-api-consumer-test:check",
]);

function invalidPlan() {
  throw new TypeError(PLAN_FAILURE);
}

function closedPlanOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) invalidPlan();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const expected = ["root", "sandbox", "versions", "uid", "gid", "token", "dockerHost", "executablePath"];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) invalidPlan();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function canonicalPath(value) {
  return typeof value === "string" && value.length > 1 && value.length <= 4096
    && isAbsolute(value) && resolve(value) === value && value !== sep
    && !/[\u0000-\u001f\u007f,]/u.test(value);
}

function invocation(command, args, workingDirectory) {
  return Object.freeze({ command, args: Object.freeze(args), workingDirectory });
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

function safeRead(path) {
  let descriptor;
  try {
    if (realpathSync(path) !== path) throw new Error();
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size < 0n || before.size > BigInt(MAX_FILE_BYTES)) throw new Error();
    const mode = Number(before.mode & 0o777n);
    if (![0o644, 0o755].includes(mode)) throw new Error();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, opened)) throw new Error();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error();
      offset += count;
    }
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameFile(before, afterDescriptor) || !sameFile(before, afterPath)) throw new Error();
    return Object.freeze({ bytes, mode, stat: before });
  } catch {
    throw new Error(FAILURE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function excludedSource(relativePath) {
  return GENERATED_INPUTS.some((excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`));
}

function captureWorkingSource(root) {
  const records = [];
  let totalBytes = 0;
  const visit = (relativePath) => {
    if (excludedSource(relativePath)) return;
    const path = resolve(root, ...relativePath.split("/"));
    if (!path.startsWith(`${root}${sep}`) || realpathSync(path) !== path) throw new Error(FAILURE);
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(FAILURE);
    if (stat.isDirectory()) {
      const names = readdirSync(path).sort(binaryCompare);
      for (const name of names) {
        if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")
            || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error(FAILURE);
        visit(`${relativePath}/${name}`);
      }
      return;
    }
    const captured = safeRead(path);
    totalBytes += captured.bytes.length;
    if (records.length >= MAX_FILES || totalBytes > MAX_SOURCE_BYTES) throw new Error(FAILURE);
    records.push(Object.freeze({ relativePath, ...captured }));
  };
  for (const relativePath of SOURCE_INPUTS) visit(relativePath);
  if (records.length < SOURCE_INPUTS.length) throw new Error(FAILURE);
  return Object.freeze({ records: Object.freeze(records), totalBytes });
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_MODE });
  chmodSync(path, PRIVATE_MODE);
}

function materializeSource(destination, capture) {
  ensurePrivateDirectory(destination);
  for (const record of capture.records) {
    const path = resolve(destination, ...record.relativePath.split("/"));
    if (!path.startsWith(`${destination}${sep}`)) throw new Error(FAILURE);
    ensurePrivateDirectory(dirname(path));
    writeFileSync(path, record.bytes, { flag: "wx", mode: record.mode });
    chmodSync(path, record.mode);
  }
}

function capturesMatch(left, right) {
  if (left.records.length !== right.records.length || left.totalBytes !== right.totalBytes) return false;
  return left.records.every((record, index) => {
    const current = right.records[index];
    return current !== undefined && record.relativePath === current.relativePath && record.mode === current.mode
      && record.bytes.equals(current.bytes) && sameFile(record.stat, current.stat);
  });
}

function closeResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(FAILURE);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ["status", "signal", "stdout", "stderr"];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) throw new Error(FAILURE);
  const result = Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
  if (!Number.isInteger(result.status) || result.status < 0 || result.status > 255 || result.signal !== null
      || typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) {
    throw new Error(FAILURE);
  }
  return result;
}

function createProcessRunner() {
  return async ({ command, args, workingDirectory, environment, timeoutMs }) => {
    const child = spawnSync(command, args, {
      cwd: workingDirectory,
      env: environment,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    });
    if (child.error !== undefined) throw new Error(FAILURE);
    return {
      status: child.status,
      signal: child.signal,
      stdout: child.stdout,
      stderr: child.stderr,
    };
  };
}

async function execute(runner, candidate) {
  return closeResult(await runner(candidate));
}

function safeDiscoveryEnvironment(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source) || utilTypes.isProxy(source)) {
    throw new Error(FAILURE);
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const path = descriptors.PATH;
  if (path === undefined || !("value" in path) || typeof path.value !== "string"
      || path.value === "" || path.value.includes("\0")) throw new Error(FAILURE);
  const environment = { PATH: path.value, LANG: "C", LC_ALL: "C", TZ: "UTC", NO_COLOR: "1" };
  for (const name of [
    "HOME", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
    "XDG_RUNTIME_DIR", "TMPDIR", "__CF_USER_TEXT_ENCODING",
  ]) {
    const descriptor = descriptors[name];
    if (descriptor !== undefined && !("value" in descriptor)) throw new Error(FAILURE);
    const value = descriptor?.value;
    if (typeof value === "string" && value !== "" && !value.includes("\0")) {
      environment[name] = value;
    }
  }
  return Object.freeze(environment);
}

function runOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new Error(FAILURE);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const allowed = ["root", "temporaryDirectory", "token", "environment", "runner"];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)
      || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) throw new Error(FAILURE);
  const root = descriptors.root?.value ?? ROOT;
  const temporaryDirectory = descriptors.temporaryDirectory?.value ?? realpathSync(tmpdir());
  const token = descriptors.token?.value ?? randomBytes(16).toString("hex");
  const environment = descriptors.environment?.value ?? process.env;
  const runner = descriptors.runner?.value ?? createProcessRunner();
  try {
    if (!canonicalPath(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()
        || !canonicalPath(temporaryDirectory) || realpathSync(temporaryDirectory) !== temporaryDirectory
        || !lstatSync(temporaryDirectory).isDirectory() || !TOKEN.test(token) || typeof runner !== "function") {
      throw new Error();
    }
  } catch {
    throw new Error(FAILURE);
  }
  return Object.freeze({ root, temporaryDirectory, token, environment, runner });
}

function writeWorkspaceMarker(root) {
  const owner = randomBytes(32).toString("hex");
  const descriptor = openSync(
    join(root, WORKSPACE_MARKER),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    MARKER_MODE,
  );
  try {
    writeFileSync(descriptor, `${owner}\n`);
    fchmodSync(descriptor, MARKER_MODE);
  } finally {
    closeSync(descriptor);
  }
  return owner;
}

// A directory's dev/ino pair alone is not an identity: ext4 hands a deleted directory's inode number to
// the next directory created in its place. The random owner marker written at creation proves that the
// directory at the workspace path is still the one this process created.
function ownsWorkspace(workspace) {
  let descriptor;
  try {
    const stat = lstatSync(workspace.root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(workspace.root) !== workspace.root
        || stat.dev !== workspace.dev || stat.ino !== workspace.ino || stat.uid !== workspace.uid) return false;
    descriptor = openSync(
      join(workspace.root, WORKSPACE_MARKER),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const marker = fstatSync(descriptor, { bigint: true });
    const expected = Buffer.from(`${workspace.owner}\n`);
    if (!marker.isFile() || marker.nlink !== 1n || marker.dev !== workspace.dev || marker.uid !== workspace.uid
        || Number(marker.mode & 0o777n) !== MARKER_MODE || marker.size !== BigInt(expected.length)) return false;
    const actual = Buffer.alloc(expected.length);
    if (readSync(descriptor, actual, 0, actual.length, 0) !== actual.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function createWorkspace(temporaryDirectory) {
  const root = realpathSync(mkdtempSync(join(temporaryDirectory, "gauntlet-java-source-")));
  chmodSync(root, PRIVATE_MODE);
  const stat = lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) throw new Error(FAILURE);
  const owner = writeWorkspaceMarker(root);
  const workspace = Object.freeze({ root, dev: stat.dev, ino: stat.ino, uid: stat.uid, owner });
  if (!ownsWorkspace(workspace)) throw new Error(FAILURE);
  return workspace;
}

export async function removeWorkspace(workspace, removeDirectory = rmSync) {
  if (typeof removeDirectory !== "function") return false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (!ownsWorkspace(workspace)) return false;
      // The owner marker is removed last so that a retry after a partial removal can still prove ownership.
      for (const entry of readdirSync(workspace.root)) {
        if (entry !== WORKSPACE_MARKER) removeDirectory(join(workspace.root, entry), { recursive: true, force: false });
      }
      if (!ownsWorkspace(workspace)) return false;
      unlinkSync(join(workspace.root, WORKSPACE_MARKER));
      rmdirSync(workspace.root);
      return !existsSync(workspace.root);
    } catch (error) {
      if (!existsSync(workspace.root)) return true;
      if (error?.code !== "ENOTEMPTY") return false;
      if (attempt < 4) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  return false;
}

export function parseLocalDockerEndpoint(result) {
  try {
    const closed = closeResult(result);
    if (closed.status !== 0 || closed.signal !== null || closed.stderr !== ""
        || !closed.stdout.endsWith("\n") || closed.stdout.includes("\r")
        || closed.stdout.slice(0, -1).includes("\n")) throw new Error();
    const endpoint = JSON.parse(closed.stdout.slice(0, -1));
    if (typeof endpoint !== "string" || !LOCAL_DOCKER.test(endpoint)) throw new Error();
    return endpoint;
  } catch {
    throw new Error(ENDPOINT_FAILURE);
  }
}

function validJavaVersions(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === MAVEN_UNIT_IDS.length
      && keys.every((key) => typeof key === "string" && MAVEN_UNIT_IDS.includes(key)
        && descriptors[key].enumerable === true && "value" in descriptors[key]
        && typeof descriptors[key].value === "string" && STABLE_VERSION.test(descriptors[key].value));
  } catch {
    return false;
  }
}

// Each Java unit is checked at the version in its own VERSION file; the versions may diverge.
function javaUnitVersions(records) {
  return Object.freeze(Object.fromEntries(MAVEN_UNIT_IDS.map((id) => {
    const record = records.find(({ relativePath }) => relativePath === JAVA_VERSION_PATHS[id]);
    if (record === undefined) throw new Error(FAILURE);
    return [id, parseReleaseVersion(record.bytes)];
  })));
}

export function createJavaSourcePlan(options) {
  const { root, sandbox, versions, uid, gid, token, dockerHost, executablePath } = closedPlanOptions(options);
  if (!canonicalPath(root) || !canonicalPath(sandbox) || root === sandbox
      || !validJavaVersions(versions) || !Number.isSafeInteger(uid) || uid < 0 || uid > 2_147_483_647
      || !Number.isSafeInteger(gid) || gid < 0 || gid > 2_147_483_647 || !TOKEN.test(token)
      || !LOCAL_DOCKER.test(dockerHost) || typeof executablePath !== "string" || executablePath === ""
      || executablePath.includes("\0")) invalidPlan();

  const source = resolve(sandbox, "source");
  const gradleHome = resolve(sandbox, "gradle-home");
  const projectCache = resolve(sandbox, "project-cache");
  const containerHome = resolve(sandbox, "container-home");
  const hostHome = resolve(sandbox, "host-home");
  const dockerConfig = resolve(sandbox, "docker-config");
  const hostTmp = resolve(sandbox, "host-tmp");
  const ownerLabel = "dev.8lines.gauntlet.java-source-owner";
  const containerName = `gauntlet-java-source-${token.slice(0, 24)}`;
  const environment = Object.freeze({
    PATH: executablePath,
    HOME: hostHome,
    DOCKER_CONFIG: dockerConfig,
    DOCKER_HOST: dockerHost,
    TMPDIR: hostTmp,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
  });
  const args = [
    "run", "--rm", "--name", containerName,
    "--label", `${ownerLabel}=${token}`,
    "--platform", MAVEN_TOOLCHAIN.platform,
    "--user", `${uid}:${gid}`,
    "--network", "bridge",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "1024",
    "--env", "GRADLE_USER_HOME=/gradle-home",
    "--env", "HOME=/container-home",
    "--env", "LANG=C.UTF-8",
    "--env", "LC_ALL=C.UTF-8",
    "--env", "TZ=UTC",
    "--env", "CI=1",
    "--env", "SOURCE_DATE_EPOCH=946684800",
    "--mount", `type=bind,src=${source},dst=/workspace`,
    "--mount", `type=bind,src=${gradleHome},dst=/gradle-home`,
    "--mount", `type=bind,src=${projectCache},dst=/project-cache`,
    "--mount", `type=bind,src=${containerHome},dst=/container-home`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--workdir", "/workspace/packages/java",
    MAVEN_TOOLCHAIN.image,
    "gradle", "--no-daemon", "--console=plain", "--quiet", "--warning-mode=fail",
    "--dependency-verification=strict",
    "--project-cache-dir", "/project-cache",
    "-DgauntletProtocolFixtures=/workspace/packages/protocol/fixtures/v1",
    ...SOURCE_TASKS,
  ];
  const ownerInspect = invocation("docker", [
    "container", "inspect", "--format",
    `{{.Id}}\t{{.Name}}\t{{ index .Config.Labels "${ownerLabel}" }}`,
    containerName,
  ], root);
  return Object.freeze({
    image: MAVEN_TOOLCHAIN.image,
    platform: MAVEN_TOOLCHAIN.platform,
    root,
    sandbox,
    source,
    token,
    ownerLabel,
    containerName,
    tasks: SOURCE_TASKS,
    environment,
    run: invocation("docker", args, root),
    ownerInspect,
  });
}

function absentContainer(result, containerName) {
  if (result.status !== 1 || result.signal !== null || !["", "\n"].includes(result.stdout)
      || typeof result.stderr !== "string" || result.stderr.includes("\r")) return false;
  const escaped = containerName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^Error(?::| response from daemon:).*No such (?:object|container): ${escaped}\\n$`, "u")
    .test(result.stderr);
}

async function cleanupOwnedContainer(plan, runner) {
  let inspected;
  try {
    inspected = await execute(runner, {
      ...plan.ownerInspect,
      environment: plan.environment,
      timeoutMs: 60_000,
    });
  } catch {
    return false;
  }
  if (absentContainer(inspected, plan.containerName)) return true;
  const match = /^([0-9a-f]{64})\t\/([^\t\r\n]+)\t([0-9a-f]{32})\n$/u.exec(inspected.stdout);
  if (inspected.status !== 0 || inspected.signal !== null || inspected.stderr !== "" || match === null
      || !CONTAINER_ID.test(match[1]) || match[2] !== plan.containerName || match[3] !== plan.token) return false;
  let removed;
  try {
    removed = await execute(runner, {
      command: "docker",
      args: ["rm", "--force", match[1]],
      workingDirectory: plan.root,
      environment: plan.environment,
      timeoutMs: 60_000,
    });
  } catch {
    return false;
  }
  return removed.status === 0 && removed.signal === null && removed.stderr === ""
    && [ `${match[1]}\n`, `${plan.containerName}\n` ].includes(removed.stdout);
}

export async function runJavaSourceCheck(options = {}) {
  const { root, temporaryDirectory, token, environment: sourceEnvironment, runner } = runOptions(options);
  let workspace;
  let plan;
  let containerAttempted = false;
  let primaryFailed = false;
  let cleanupFailed = false;
  let report;
  try {
    workspace = createWorkspace(temporaryDirectory);
    const capture = captureWorkingSource(root);
    const versions = javaUnitVersions(capture.records);
    const source = resolve(workspace.root, "source");
    materializeSource(source, capture);
    for (const directory of [
      "gradle-home", "project-cache", "container-home", "host-home", "docker-config", "host-tmp",
    ]) ensurePrivateDirectory(resolve(workspace.root, directory));

    const discoveryEnvironment = safeDiscoveryEnvironment(sourceEnvironment);
    const contextResult = await execute(runner, {
      command: "docker",
      args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      workingDirectory: root,
      environment: discoveryEnvironment,
      timeoutMs: 60_000,
    });
    const dockerHost = parseLocalDockerEndpoint(contextResult);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    plan = createJavaSourcePlan({
      root,
      sandbox: workspace.root,
      versions,
      uid,
      gid,
      token,
      dockerHost,
      executablePath: discoveryEnvironment.PATH,
    });
    containerAttempted = true;
    const execution = await execute(runner, {
      ...plan.run,
      environment: plan.environment,
      timeoutMs: 30 * 60_000,
    });
    if (execution.status !== 0) throw new Error(FAILURE);
    const after = captureWorkingSource(root);
    if (!capturesMatch(capture, after)) throw new Error(FAILURE);
    report = Object.freeze({ ok: true, versions, sourceChecks: SOURCE_TASKS.length });
  } catch {
    primaryFailed = true;
  } finally {
    if (containerAttempted) cleanupFailed = !(await cleanupOwnedContainer(plan, runner));
    if (workspace !== undefined) cleanupFailed = !(await removeWorkspace(workspace)) || cleanupFailed;
  }
  if (primaryFailed || cleanupFailed || report === undefined) throw new Error(FAILURE);
  return report;
}

export async function runJavaSourceCli(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    return { exitCode: 2, stdout: "", stderr: `${FAILURE}\n` };
  }
  try {
    const report = await runJavaSourceCheck(options);
    return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
  } catch {
    return { exitCode: 1, stdout: "", stderr: `${FAILURE}\n` };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runJavaSourceCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
