#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const MAX_INPUT_FILE = 16 * 1024 * 1024;
const MAX_INPUT_TOTAL = 128 * 1024 * 1024;
const MINIMUM_INITIAL_BYTES = 4n * 1024n * 1024n * 1024n;
const MINIMUM_RUNNING_BYTES = 2n * 1024n * 1024n * 1024n;

export function runtimePlatformForArchitecture(architecture) {
  if (architecture === "arm64") return "linux/arm64";
  if (architecture === "x64") return "linux/amd64";
  throw new Error("PHP compatibility host architecture is unsupported");
}

const PHP_PLATFORM = runtimePlatformForArchitecture(process.arch);

export const PHP_IMAGES = Object.freeze({
  "8.3": "php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4",
  "8.4": "php:8.4.24-cli-bookworm@sha256:6003a0607eea6dc61d04723d3e60347c8481ffb2f09dbf85bf427b9ce0c25629",
  "8.5": "php:8.5.10-cli-bookworm@sha256:b80dfc7d2bc0fc97755620a0dfb3d5e8e9cbf70a2970ea2d5c9dc64154b31422",
});
export const COMPOSER_IMAGE = "composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584";
// Each tested Symfony minor maps to the lowest PHP minor that Symfony line supports.
export const SYMFONY_MINIMUM_PHP = Object.freeze({ "7.4": "8.3", "8.1": "8.4" });
export const SYMFONY_MINORS = Object.freeze(Object.keys(SYMFONY_MINIMUM_PHP));
export const SYMFONY_CONSTRAINT = "^7.4 || ^8.0";

function phpSupportsSymfony(php, minor) {
  const [major, patch] = php.split(".").map(Number);
  const [minimumMajor, minimumPatch] = SYMFONY_MINIMUM_PHP[minor].split(".").map(Number);
  return major > minimumMajor || (major === minimumMajor && patch >= minimumPatch);
}

export function createPhpCompatibilityPlan(taskIdentifier) {
  if (typeof taskIdentifier !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskIdentifier)) {
    throw new TypeError("Compatibility task identifier must be safe ASCII");
  }
  const builds = Object.entries(PHP_IMAGES).map(([php, image]) => Object.freeze({
    php,
    platform: PHP_PLATFORM,
    image,
    tag: `gauntlet-php-compatibility:${taskIdentifier}-php${php.replace(".", "")}`,
  }));
  const core = builds.map(({ php, tag }) => Object.freeze({ php, tag, suite: "unit" }));
  const symfony = builds.flatMap(({ php, tag }) => SYMFONY_MINORS
    .filter((minor) => phpSupportsSymfony(php, minor))
    .map((minor) => Object.freeze({
      php,
      tag,
      symfony: minor,
      packages: Object.freeze(["bundle", "example"]),
    })));
  return Object.freeze({
    builds: Object.freeze(builds),
    core: Object.freeze(core),
    symfony: Object.freeze(symfony),
  });
}

function validAbsolutePath(value, { mount = false } = {}) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value
    && !/[\0-\x1f\x7f]/u.test(value) && (!mount || !value.includes(","));
}

function invalidInvocation() {
  throw new TypeError("PHP compatibility invocation is invalid");
}

function validateEnvironment(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)
      || Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        || typeof value !== "string" || value.includes("\0"))) invalidInvocation();
}

export function createDockerBuildInvocation({ build, composerImage, root, environment }) {
  if (build === null || typeof build !== "object" || !Object.values(PHP_IMAGES).includes(build.image)
      || build.platform !== PHP_PLATFORM || typeof build.tag !== "string"
      || !/^gauntlet-php-compatibility:[a-z0-9-]+-php(?:83|84|85)$/.test(build.tag)
      || composerImage !== COMPOSER_IMAGE || !validAbsolutePath(root)) invalidInvocation();
  validateEnvironment(environment);
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      "build", "--pull", "--platform", PHP_PLATFORM,
      "--file", resolve(root, "packages/php/Dockerfile"),
      "--build-arg", `PHP_IMAGE=${build.image}`,
      "--build-arg", `COMPOSER_IMAGE=${composerImage}`,
      "--tag", build.tag,
      root,
    ]),
    environment,
  });
}

export function createDockerRunInvocation({
  tag,
  workspace,
  cache,
  workingDirectory,
  command,
  environment,
  uid,
  gid,
}) {
  if (typeof tag !== "string" || !/^gauntlet-php-compatibility:[a-z0-9-]+-php(?:83|84|85)$/.test(tag)
      || !validAbsolutePath(workspace, { mount: true }) || !validAbsolutePath(cache, { mount: true })
      || typeof workingDirectory !== "string" || !workingDirectory.startsWith("/workspace/")
      || resolve(workingDirectory) !== workingDirectory || !Array.isArray(command) || command.length === 0
      || command.length > 32 || command.some((value) => typeof value !== "string" || value === "" || value.includes("\0"))
      || !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) invalidInvocation();
  validateEnvironment(environment);
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      "run", "--rm", "--platform", PHP_PLATFORM, "--user", `${uid}:${gid}`,
      "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
      "--env", "COMPOSER_CACHE_DIR=/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
      "--env", "COMPOSER_PROCESS_TIMEOUT=300", "--env", "CI=1",
      "--mount", `type=bind,src=${workspace},dst=/workspace`,
      "--mount", `type=bind,src=${cache},dst=/composer-cache`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
      "--workdir", workingDirectory,
      tag,
      ...command,
    ]),
    environment,
  });
}

export function createPackageCommands(kind, symfonyMinor) {
  if (!["core", "bundle", "example"].includes(kind)
      || (kind === "core" ? symfonyMinor !== undefined : !SYMFONY_MINORS.includes(symfonyMinor))) {
    throw new TypeError("PHP compatibility package command is invalid");
  }
  const suite = kind === "core" ? "unit" : "all";
  return Object.freeze([
    Object.freeze([
      "composer", "validate", "--strict", "--no-check-version", "--no-check-all", "--no-interaction",
    ]),
    Object.freeze([
      "composer", "update",
      ...(symfonyMinor === undefined ? [] : [`symfony/*:${symfonyMinor}.*`]),
      "--no-interaction", "--prefer-dist", "--with-all-dependencies",
    ]),
    Object.freeze([
      "sh", "-ec",
      "test ! -e .gauntlet-vendor-after-update && test ! -L .gauntlet-vendor-after-update && mv vendor .gauntlet-vendor-after-update && test ! -e vendor && test ! -L vendor && exec composer install --no-interaction --prefer-dist",
    ]),
    Object.freeze(["vendor/bin/phpunit", "--testsuite", suite, "--do-not-cache-result"]),
    Object.freeze(["composer", "check-platform-reqs"]),
    Object.freeze(["composer", "audit", "--locked", "--no-interaction"]),
  ]);
}

function commandEnvironment(sandbox) {
  const path = process.env.PATH;
  if (typeof path !== "string" || path === "" || path.includes("\0")) throw new Error();
  const home = join(sandbox, "home");
  const docker = join(sandbox, "docker-config");
  const temporary = join(sandbox, "tmp");
  for (const directory of [home, docker, temporary]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  return Object.freeze({
    PATH: path,
    HOME: home,
    DOCKER_CONFIG: docker,
    TMPDIR: temporary,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
    ...(typeof process.env.DOCKER_HOST === "string" && process.env.DOCKER_HOST !== ""
      ? { DOCKER_HOST: process.env.DOCKER_HOST }
      : {}),
  });
}

function execute(invocation, { timeout = 300_000, allowFailure = false, phase = "command" } = {}) {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd ?? ROOT,
    env: invocation.environment,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_COMMAND_OUTPUT,
    windowsHide: true,
  });
  if (!allowFailure && (result.error !== undefined || result.signal !== null || result.status !== 0)) {
    if (typeof phase !== "string" || !/^[a-z0-9 .:-]{1,96}$/u.test(phase)) throw new Error("PHP compatibility command failed safely");
    throw new Error(`PHP compatibility ${phase} failed safely`);
  }
  return result;
}

function availableBytes(path) {
  const stat = statfsSync(path, { bigint: true });
  return stat.bavail * stat.bsize;
}

function safeTrackedPath(path) {
  return path === "conformance/scenarios/adapter-v1.json"
    || path.startsWith("packages/php/core/")
    || path.startsWith("packages/php/symfony-bundle/")
    || path.startsWith("examples/symfony/")
    || path.startsWith("packages/protocol/fixtures/v1/");
}

function captureInputs(root, environment) {
  const result = execute({
    command: "git",
    args: [
      "-c", "core.quotepath=false", "-C", root, "ls-files", "-z", "--",
      "packages/php/core", "packages/php/symfony-bundle", "examples/symfony",
      "packages/protocol/fixtures/v1", "conformance/scenarios/adapter-v1.json",
    ],
    cwd: root,
    environment: Object.freeze({
      PATH: environment.PATH,
      HOME: environment.HOME,
      TMPDIR: environment.TMPDIR,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }),
  }, { timeout: 30_000 });
  const bytes = Buffer.from(result.stdout, "utf8");
  if (bytes.length === 0 || bytes.at(-1) !== 0) throw new Error("PHP compatibility input capture failed safely");
  const paths = bytes.subarray(0, -1).toString("utf8").split("\0").sort();
  if (paths.length === 0 || new Set(paths).size !== paths.length || paths.some((path) => !safeTrackedPath(path)
      || path.split("/").some((part) => part === "" || part === "." || part === "..")
      || /(?:^|\/)(?:vendor|\.git|\.env|auth\.json)(?:\/|$)/i.test(path))) {
    throw new Error("PHP compatibility input capture failed safely");
  }
  let total = 0;
  const records = paths.map((relativePath) => {
    const path = resolve(root, relativePath);
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_INPUT_FILE)
        || realpathSync(path) !== path || (before.mode & 0o111n) !== 0n) throw new Error("PHP compatibility input capture failed safely");
    const content = readFileSync(path);
    const after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || content.length !== Number(before.size)) throw new Error("PHP compatibility input capture failed safely");
    total += content.length;
    if (total > MAX_INPUT_TOTAL) throw new Error("PHP compatibility input capture failed safely");
    return Object.freeze({
      relativePath,
      content,
      signature: Object.freeze({
        dev: before.dev,
        ino: before.ino,
        mode: before.mode,
        size: before.size,
        mtimeNs: before.mtimeNs,
        sha256: createHash("sha256").update(content).digest("hex"),
      }),
    });
  });
  return Object.freeze(records);
}

function assertInputsUnchanged(root, records) {
  for (const record of records) {
    const path = resolve(root, record.relativePath);
    const stat = lstatSync(path, { bigint: true });
    const bytes = readFileSync(path);
    const expected = record.signature;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino
        || stat.mode !== expected.mode || stat.size !== expected.size || stat.mtimeNs !== expected.mtimeNs
        || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error("PHP compatibility source changed during verification");
    }
  }
}

function materializeCell(directory, records) {
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const record of records) {
    const destination = resolve(directory, record.relativePath);
    if (!destination.startsWith(`${directory}${sep}`)) throw new Error();
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, record.content, { flag: "wx", mode: 0o600 });
    chmodSync(destination, 0o600);
  }
}

export function verifySymfonyDependencyLine(manifest, lock, minor) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
      || lock === null || typeof lock !== "object" || Array.isArray(lock)
      || !SYMFONY_MINORS.includes(minor)) throw new Error("Symfony dependency verification failed safely");
  const requirements = [manifest.require, manifest["require-dev"]]
    .flatMap((section) => section !== null && typeof section === "object" && !Array.isArray(section)
      ? Object.entries(section) : [])
    .filter(([name]) => typeof name === "string" && name.startsWith("symfony/"));
  if (requirements.length === 0 || requirements.some(([, constraint]) => constraint !== SYMFONY_CONSTRAINT)) {
    throw new Error(`Direct Symfony dependency constraints do not match ${SYMFONY_CONSTRAINT}`);
  }
  const packages = [...(Array.isArray(lock.packages) ? lock.packages : []),
    ...(Array.isArray(lock["packages-dev"]) ? lock["packages-dev"] : [])];
  const resolved = new Map();
  for (const dependency of packages) {
    if (dependency === null || typeof dependency !== "object" || Array.isArray(dependency)
        || typeof dependency.name !== "string" || typeof dependency.version !== "string") continue;
    if (resolved.has(dependency.name)) throw new Error("Symfony dependency verification failed safely");
    resolved.set(dependency.name, dependency.version);
  }
  const versionPattern = new RegExp(`^v?${minor.replace(".", "\\.")}\\.`);
  if (requirements.some(([name]) => !versionPattern.test(resolved.get(name) ?? ""))) {
    throw new Error(`Resolved direct Symfony dependency does not match ${minor}`);
  }
}

function verifySymfonyLock(directory, minor) {
  const manifestPath = resolve(directory, "composer.json");
  const lockPath = resolve(directory, "composer.lock");
  const manifestStat = lstatSync(manifestPath, { bigint: true });
  const lockStat = lstatSync(lockPath, { bigint: true });
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024n * 1024n
      || !lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size > 16n * 1024n * 1024n) throw new Error();
  verifySymfonyDependencyLine(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    JSON.parse(readFileSync(lockPath, "utf8")),
    minor,
  );
}

function runPackage({ kind, minor, php, tag, cellRoot, cache, environment, uid, gid }) {
  const relativeDirectory = kind === "core" ? "packages/php/core"
    : kind === "bundle" ? "packages/php/symfony-bundle" : "examples/symfony";
  const hostDirectory = resolve(cellRoot, relativeDirectory);
  const commands = createPackageCommands(kind, minor);
  for (const [index, command] of commands.entries()) {
    if (index === 2) {
      const vendor = resolve(hostDirectory, "vendor");
      const stat = lstatSync(vendor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(vendor) !== vendor) {
        throw new Error("PHP compatibility update did not produce a safe vendor directory");
      }
    }
    execute(createDockerRunInvocation({
      tag,
      workspace: cellRoot,
      cache,
      workingDirectory: `/workspace/${relativeDirectory}`,
      command,
      environment,
      uid,
      gid,
    }), { phase: `${kind}${minor === undefined ? "" : `-${minor}`} php-${php} step-${index + 1}` });
    if (index === 1 && minor !== undefined) verifySymfonyLock(hostDirectory, minor);
  }
}

export async function runPhpCompatibility({ root = ROOT } = {}) {
  if (typeof root !== "string" || !isAbsolute(root) || realpathSync(root) !== root) {
    throw new TypeError("PHP compatibility root must be canonical");
  }
  if (availableBytes(root) < MINIMUM_INITIAL_BYTES) throw new Error("Insufficient disk space for PHP compatibility verification");
  const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-php-compatibility-")));
  const taskIdentifier = `run-${randomBytes(8).toString("hex")}`;
  const plan = createPhpCompatibilityPlan(taskIdentifier);
  const environment = commandEnvironment(sandbox);
  const cache = resolve(sandbox, "composer-cache");
  mkdirSync(cache, { mode: 0o700 });
  chmodSync(cache, 0o700);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const builtTags = [];
  const beforeBytes = availableBytes(root);
  let inputs;
  try {
    inputs = captureInputs(root, environment);
    for (const build of plan.builds) {
      execute(createDockerBuildInvocation({ build, composerImage: COMPOSER_IMAGE, root, environment }), {
        timeout: 600_000,
        phase: `build php-${build.php}`,
      });
      builtTags.push(build.tag);
      if (availableBytes(root) < MINIMUM_RUNNING_BYTES) throw new Error("Insufficient disk space for PHP compatibility verification");
    }
    for (const cell of plan.core) {
      const cellRoot = resolve(sandbox, `core-php${cell.php.replace(".", "")}`);
      materializeCell(cellRoot, inputs);
      runPackage({ kind: "core", php: cell.php, tag: cell.tag, cellRoot, cache, environment, uid, gid });
      rmSync(cellRoot, { recursive: true, force: true });
    }
    for (const cell of plan.symfony) {
      const cellRoot = resolve(sandbox, `symfony-php${cell.php.replace(".", "")}-${cell.symfony.replace(".", "")}`);
      materializeCell(cellRoot, inputs);
      runPackage({ kind: "bundle", minor: cell.symfony, php: cell.php, tag: cell.tag, cellRoot, cache, environment, uid, gid });
      runPackage({ kind: "example", minor: cell.symfony, php: cell.php, tag: cell.tag, cellRoot, cache, environment, uid, gid });
      rmSync(cellRoot, { recursive: true, force: true });
    }
    assertInputsUnchanged(root, inputs);
    return Object.freeze({
      beforeBytes,
      afterBytes: availableBytes(root),
      builds: plan.builds.length,
      coreCells: plan.core.length,
      symfonyCells: plan.symfony.length,
    });
  } finally {
    for (const tag of builtTags.toReversed()) {
      execute({ command: "docker", args: ["image", "rm", tag], environment }, { timeout: 60_000, allowFailure: true });
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  await runPhpCompatibility();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) {
    process.stderr.write("PHP compatibility verification failed safely\n");
    process.exitCode = 2;
  } else {
    main().catch((error) => {
      const phase = error instanceof Error
        ? /^PHP compatibility ([a-z0-9 .:-]{1,96}) failed safely$/u.exec(error.message)?.[1]
        : undefined;
      process.stderr.write(phase === undefined
        ? "PHP compatibility verification failed safely\n"
        : `PHP compatibility ${phase} failed safely\n`);
      process.exitCode = 1;
    });
  }
}
