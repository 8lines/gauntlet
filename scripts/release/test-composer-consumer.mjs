#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseVersion, readReleaseVersion } from "./release-model.mjs";
import { stageComposerPackages } from "./stage-composer.mjs";
import {
  COMPOSER_IMAGE,
  createDockerBuildInvocation,
  PHP_IMAGES,
  runtimePlatformForArchitecture,
} from "./test-php-compatibility.mjs";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MINIMUM_BYTES = 2n * 1024n * 1024n * 1024n;
const INTERNAL_PACKAGES = Object.freeze([
  "8lines/gauntlet-php-core",
  "8lines/gauntlet-symfony-bundle",
]);
export const COMPOSER_CONSUMER_COMMITTED_INPUTS = Object.freeze([
  "LICENSE",
  "VERSION",
  "packages/php/Dockerfile",
  "packages/php/core",
  "packages/php/symfony-bundle",
  "tests/consumers/php-core",
  "tests/consumers/php-symfony",
]);

function invalidPlan() {
  throw new TypeError("Composer consumer plan is invalid");
}

export function createComposerConsumerPlan({ version, taskIdentifier, sandbox, imageTag, uid, gid }) {
  try {
    if (parseReleaseVersion(`${version}\n`) !== version) invalidPlan();
  } catch {
    invalidPlan();
  }
  if (typeof taskIdentifier !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskIdentifier)
      || typeof sandbox !== "string" || !isAbsolute(sandbox) || resolve(sandbox) !== sandbox
      || /[\0-\x1f\x7f,]/u.test(sandbox)
      || typeof imageTag !== "string"
      || !/^gauntlet-php-compatibility:[a-z0-9-]+-php83$/.test(imageTag)
      || !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) invalidPlan();
  const repositories = Object.freeze([
    Object.freeze({
      name: "8lines/gauntlet-php-core",
      staged: resolve(sandbox, "staged/8lines/gauntlet-php-core"),
      bare: resolve(sandbox, "repositories/gauntlet-php-core.git"),
      tag: `v${version}`,
    }),
    Object.freeze({
      name: "8lines/gauntlet-symfony-bundle",
      staged: resolve(sandbox, "staged/8lines/gauntlet-symfony-bundle"),
      bare: resolve(sandbox, "repositories/gauntlet-symfony-bundle.git"),
      tag: `v${version}`,
    }),
  ]);
  const environment = Object.freeze({});
  const consumers = Object.freeze(["php-core", "php-symfony"].map((name) => Object.freeze({
    name,
    path: resolve(sandbox, "consumers", name),
    offlinePath: resolve(sandbox, "offline-consumers", name),
    validate: Object.freeze([
      "composer", "validate", "--strict", "--no-check-all", "--no-interaction",
    ]),
    online: Object.freeze(["composer", "install", "--no-interaction", "--prefer-dist"]),
    check: Object.freeze(["php", "check.php"]),
    offline: Object.freeze(["composer", "install", "--no-interaction", "--prefer-dist"]),
    offlineNetwork: "none",
    environment,
  })));
  return Object.freeze({
    version,
    taskIdentifier,
    sandbox,
    imageTag,
    uid,
    gid,
    repositories,
    consumers,
  });
}

export function composerLockSourceFor(repository) {
  const name = repository?.bare?.split("/").at(-1);
  if (typeof name !== "string" || !/^gauntlet-(?:php-core|symfony-bundle)\.git$/u.test(name)) {
    throw new TypeError("Composer repository source is invalid");
  }
  return `/task/repositories/${name}`;
}

function availableBytes(path) {
  const stat = statfsSync(path, { bigint: true });
  return stat.bavail * stat.bsize;
}

function createEnvironment(sandbox) {
  const path = process.env.PATH;
  if (typeof path !== "string" || path === "" || path.includes("\0")) throw new Error();
  const home = resolve(sandbox, "home");
  const dockerConfig = resolve(sandbox, "docker-config");
  const temporary = resolve(sandbox, "tmp");
  for (const directory of [home, dockerConfig, temporary]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  return Object.freeze({
    PATH: path,
    HOME: home,
    DOCKER_CONFIG: dockerConfig,
    TMPDIR: temporary,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...(typeof process.env.DOCKER_HOST === "string" && process.env.DOCKER_HOST !== ""
      ? { DOCKER_HOST: process.env.DOCKER_HOST }
      : {}),
  });
}

function execute(command, args, { cwd, environment, timeout = 300_000, allowFailure = false, encoding = "utf8" }) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (!allowFailure && (result.error !== undefined || result.signal !== null || result.status !== 0)) {
    throw new Error("Composer consumer verification failed safely");
  }
  return result;
}

function exactHead(root, environment) {
  const head = execute("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    environment,
    timeout: 30_000,
  }).stdout;
  if (typeof head !== "string" || !/^[0-9a-f]{40}\n$/.test(head)) throw new Error();
  const cleanInputs = execute("git", [
    "-C", root, "diff", "--quiet", "HEAD", "--", ...COMPOSER_CONSUMER_COMMITTED_INPUTS,
  ], { cwd: root, environment, timeout: 30_000, allowFailure: true });
  if (cleanInputs.error !== undefined || cleanInputs.signal !== null || cleanInputs.status !== 0) {
    throw new Error("Composer consumer requires committed release inputs");
  }
  return head.trimEnd();
}

function gitBytes(root, commit, relativePath, environment) {
  const result = execute("git", ["-C", root, "show", `${commit}:${relativePath}`], {
    cwd: root,
    environment,
    timeout: 30_000,
    encoding: "buffer",
  });
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0 || result.stdout.length > 1024 * 1024
      || result.stderr.length !== 0) throw new Error();
  return result.stdout;
}

function materializeConsumers(root, commit, plan, environment) {
  for (const consumer of plan.consumers) {
    mkdirSync(consumer.path, { recursive: true, mode: 0o700 });
    chmodSync(consumer.path, 0o700);
    for (const filename of ["check.php", "composer.json"]) {
      const bytes = gitBytes(root, commit, `tests/consumers/${consumer.name}/${filename}`, environment);
      writeFileSync(resolve(consumer.path, filename), bytes, { flag: "wx", mode: 0o600 });
    }
    const manifestPath = resolve(consumer.path, "composer.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const wanted = consumer.name === "php-core" ? plan.repositories.slice(0, 1) : plan.repositories;
    manifest.repositories = wanted.map(({ bare }) => ({
      type: "vcs",
      url: `file:///task/repositories/${bare.split("/").at(-1)}`,
      canonical: true,
    }));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }
}

function materializeOfflineConsumer(consumer) {
  mkdirSync(consumer.offlinePath, { recursive: true, mode: 0o700 });
  chmodSync(consumer.offlinePath, 0o700);
  for (const filename of ["check.php", "composer.json", "composer.lock"]) {
    const source = resolve(consumer.path, filename);
    const stat = lstatSync(source, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 16n * 1024n * 1024n) {
      throw new Error();
    }
    writeFileSync(resolve(consumer.offlinePath, filename), readFileSync(source), { flag: "wx", mode: 0o600 });
  }
  return Object.freeze({ ...consumer, path: consumer.offlinePath });
}

function gitEnvironment(environment) {
  return Object.freeze({
    ...environment,
    GIT_AUTHOR_NAME: "8lines Release",
    GIT_AUTHOR_EMAIL: "release@8lines.dev",
    GIT_COMMITTER_NAME: "8lines Release",
    GIT_COMMITTER_EMAIL: "release@8lines.dev",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  });
}

function createBareRepository(repository, environment, version) {
  mkdirSync(dirname(repository.bare), { recursive: true, mode: 0o700 });
  execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: repository.staged, environment, timeout: 30_000,
  });
  execute("git", ["add", "--all", "--"], { cwd: repository.staged, environment, timeout: 30_000 });
  execute("git", ["commit", "--quiet", "--message", `Release ${version}`], {
    cwd: repository.staged, environment, timeout: 30_000,
  });
  execute("git", ["tag", "--annotate", repository.tag, "--message", `Release ${version}`], {
    cwd: repository.staged, environment, timeout: 30_000,
  });
  execute("git", ["init", "--bare", "--quiet", "--initial-branch=main", repository.bare], {
    cwd: dirname(repository.bare), environment, timeout: 30_000,
  });
  execute("git", ["push", "--quiet", repository.bare, "refs/heads/main:refs/heads/main", `refs/tags/${repository.tag}:refs/tags/${repository.tag}`], {
    cwd: repository.staged, environment, timeout: 30_000,
  });
  const tagType = execute("git", ["--git-dir", repository.bare, "cat-file", "-t", `refs/tags/${repository.tag}`], {
    cwd: repository.staged, environment, timeout: 30_000,
  }).stdout;
  if (tagType !== "tag\n") throw new Error();
  return execute("git", ["--git-dir", repository.bare, "rev-parse", `${repository.tag}^{commit}`], {
    cwd: repository.staged, environment, timeout: 30_000,
  }).stdout.trimEnd();
}

function dockerRun(plan, consumer, command, environment, platform, { network = "bridge" } = {}) {
  const onlinePath = resolve(plan.sandbox, "consumers", consumer.name);
  const offlinePath = resolve(plan.sandbox, "offline-consumers", consumer.name);
  if (consumer.path !== onlinePath && consumer.path !== offlinePath) throw new TypeError("Composer consumer path is invalid");
  const workdir = consumer.path === offlinePath ? `offline-consumers/${consumer.name}` : `consumers/${consumer.name}`;
  execute("docker", [
    "run", "--rm", "--platform", platform, "--user", `${plan.uid}:${plan.gid}`,
    "--network", network,
    "--env", "HOME=/tmp/home",
    "--env", "COMPOSER_HOME=/tmp/composer",
    "--env", "COMPOSER_CACHE_DIR=/task/composer-cache",
    "--env", "COMPOSER_NO_INTERACTION=1",
    "--env", "COMPOSER_PROCESS_TIMEOUT=300",
    "--mount", `type=bind,src=${plan.sandbox},dst=/task`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--workdir", `/task/${workdir}`,
    plan.imageTag,
    ...command,
  ], { cwd: ROOT, environment, timeout: 600_000 });
}

export function validateComposerLockPackageVersions(lock) {
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new Error("Composer consumer lock is not release-stable");
  }
  const sections = [lock.packages ?? [], lock["packages-dev"] ?? []];
  if (sections.some((section) => !Array.isArray(section))) {
    throw new Error("Composer consumer lock is not release-stable");
  }
  const packages = sections.flat();
  if (packages.length === 0 || packages.some((dependency) => dependency === null
      || typeof dependency !== "object" || Array.isArray(dependency)
      || typeof dependency.name !== "string" || dependency.name === ""
      || typeof dependency.version !== "string" || dependency.version === ""
      || /(?:dev|snapshot)/i.test(dependency.version))) {
    throw new Error("Composer consumer lock is not release-stable");
  }
}

function validateConsumerLock(consumer, plan, commits) {
  const path = resolve(consumer.path, "composer.lock");
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 16n * 1024n * 1024n) throw new Error();
  const lock = JSON.parse(readFileSync(path, "utf8"));
  const packages = [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])];
  validateComposerLockPackageVersions(lock);
  const expected = consumer.name === "php-core" ? INTERNAL_PACKAGES.slice(0, 1) : INTERNAL_PACKAGES;
  for (const name of expected) {
    const dependency = packages.find((candidate) => candidate.name === name);
    const repository = plan.repositories.find((candidate) => candidate.name === name);
    if (dependency?.version !== plan.version || dependency.source?.type !== "git"
        || dependency.source?.url !== composerLockSourceFor(repository)
        || dependency.source?.reference !== commits.get(name) || dependency.dist !== undefined) throw new Error();
  }
  if (packages.some(({ name, version }) => INTERNAL_PACKAGES.includes(name) && version !== plan.version)) throw new Error();
  if (consumer.name === "php-symfony") {
    const framework = packages.find(({ name }) => name === "symfony/framework-bundle");
    if (framework === undefined || !/^v?7\.4\./.test(framework.version)) throw new Error();
  }
}

export async function runComposerConsumer({ root = ROOT } = {}) {
  if (typeof root !== "string" || !isAbsolute(root) || realpathSync(root) !== root) {
    throw new TypeError("Composer consumer root must be canonical");
  }
  if (availableBytes(root) < MINIMUM_BYTES) throw new Error("Composer consumer verification failed safely");
  const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-composer-consumer-")));
  chmodSync(sandbox, 0o700);
  const taskIdentifier = `run-${randomBytes(8).toString("hex")}`;
  const imageTag = `gauntlet-php-compatibility:${taskIdentifier}-php83`;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const plan = createComposerConsumerPlan({
    version: readReleaseVersion(root),
    taskIdentifier,
    sandbox,
    imageTag,
    uid,
    gid,
  });
  const environment = createEnvironment(sandbox);
  const platform = runtimePlatformForArchitecture(process.arch);
  let imageBuilt = false;
  try {
    const commit = exactHead(root, environment);
    if (readReleaseVersion(root) !== plan.version) throw new Error();
    for (const directory of [resolve(sandbox, "staged"), resolve(sandbox, "repositories"), resolve(sandbox, "consumers"), resolve(sandbox, "offline-consumers"), resolve(sandbox, "composer-cache")]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    await stageComposerPackages({ root, outputDirectory: resolve(sandbox, "staged"), sourceCommit: commit });
    materializeConsumers(root, commit, plan, environment);
    const commits = new Map();
    const gitEnv = gitEnvironment(environment);
    for (const repository of plan.repositories) {
      commits.set(repository.name, createBareRepository(repository, gitEnv, plan.version));
    }

    const build = Object.freeze({ php: "8.3", platform, image: PHP_IMAGES["8.3"], tag: imageTag });
    const invocation = createDockerBuildInvocation({ build, composerImage: COMPOSER_IMAGE, root, environment });
    execute(invocation.command, invocation.args, { cwd: root, environment, timeout: 600_000 });
    imageBuilt = true;

    for (const consumer of plan.consumers) {
      dockerRun(plan, consumer, consumer.validate, environment, platform);
      dockerRun(plan, consumer, consumer.online, environment, platform);
      validateConsumerLock(consumer, plan, commits);
      dockerRun(plan, consumer, ["composer", "check-platform-reqs"], environment, platform, { network: "none" });
      dockerRun(plan, consumer, ["composer", "audit", "--locked", "--no-interaction"], environment, platform);
      dockerRun(plan, consumer, consumer.check, environment, platform, { network: "none" });
      const offlineConsumer = materializeOfflineConsumer(consumer);
      dockerRun(plan, offlineConsumer, consumer.offline, environment, platform, { network: "none" });
      validateConsumerLock(offlineConsumer, plan, commits);
      dockerRun(plan, offlineConsumer, consumer.check, environment, platform, { network: "none" });
    }
    return Object.freeze({ version: plan.version, packages: plan.repositories.length, consumers: plan.consumers.length });
  } catch (error) {
    if (error instanceof TypeError || error?.message === "Composer consumer requires committed release inputs") throw error;
    throw new Error("Composer consumer verification failed safely");
  } finally {
    if (imageBuilt) {
      execute("docker", ["image", "rm", imageTag], {
        cwd: root, environment, timeout: 60_000, allowFailure: true,
      });
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) {
    process.stderr.write("Composer consumer verification failed safely\n");
    process.exitCode = 2;
  } else {
    runComposerConsumer().catch(() => {
      process.stderr.write("Composer consumer verification failed safely\n");
      process.exitCode = 1;
    });
  }
}
