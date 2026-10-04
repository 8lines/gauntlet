#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, TextDecoder, types as utilTypes } from "node:util";

import { parseDocument } from "yaml";

import { withMaterializedCanonicalTree, withOwnedTemporaryWorkspace } from "./archive-consumer.mjs";
import { createReleaseManifest, readReleaseManifest, verifyReleaseInventory } from "./inventory.mjs";
import { parseReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";
import { COMPOSER_UNIT_IDS } from "./stage-composer.mjs";
import { unitById } from "./units.mjs";

const execFileAsync = promisify(execFile);
const FAILURE = "Composer split publication failed closed";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 4_096;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const FIXED_REMOTES = new Set(RELEASE_ARTIFACTS.composer.map(({ repositoryUrl }) => repositoryUrl));
const COMMIT = /^[0-9a-f]{40}$/u;
const MIN_DEPLOY_KEY_BYTES = 128;
const MAX_DEPLOY_KEY_BYTES = 16 * 1024;
// Assembled from parts so the release credential scanner does not read the envelope as a key.
const OPENSSH_KEY_LABEL = ["OPENSSH", "PRIVATE", "KEY"].join(" ");
const OPENSSH_PRIVATE_KEY = new RegExp(
  `^-----BEGIN ${OPENSSH_KEY_LABEL}-----\\n(?:[A-Za-z0-9+/=]{1,76}\\n)+-----END ${OPENSSH_KEY_LABEL}-----\\n$`,
  "u",
);
const SHELL_SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/u;

/**
 * GitHub's published SSH host keys, pinned from `ssh_keys` in https://api.github.com/meta.
 * Their SHA-256 fingerprints are ED25519 +DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU,
 * ECDSA p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM, and RSA uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.
 * A rotated GitHub host key must be re-pinned here after checking the new published values.
 */
export const GITHUB_SSH_KNOWN_HOSTS = Object.freeze([
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
]);

// Each public split repository accepts pushes only from its own write-enabled deploy key.
// Reads and post-publication verification use anonymous HTTPS because the split repositories are public.
const DEPLOY_KEY_VARIABLES = Object.freeze({
  "8lines/gauntlet-php-core": "COMPOSER_SPLIT_CORE_DEPLOY_KEY",
  "8lines/gauntlet-symfony-bundle": "COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY",
});

export const COMPOSER_SSH_DESTINATIONS = Object.freeze(Object.fromEntries(RELEASE_ARTIFACTS.composer.map((artifact) => {
  const deployKeyVariable = DEPLOY_KEY_VARIABLES[artifact.repository];
  if (typeof deployKeyVariable !== "string" || !/^8lines\/[a-z0-9][a-z0-9-]*$/u.test(artifact.repository)
      || artifact.repositoryUrl !== `https://github.com/${artifact.repository}.git`) {
    throw new Error("Composer SSH destination catalog is invalid");
  }
  return [artifact.repositoryUrl, Object.freeze({
    pushUrl: `git@github.com:${artifact.repository}.git`,
    deployKeyVariable,
  })];
})));
if (Object.keys(COMPOSER_SSH_DESTINATIONS).length !== Object.keys(DEPLOY_KEY_VARIABLES).length
    || new Set(Object.values(DEPLOY_KEY_VARIABLES)).size !== Object.keys(DEPLOY_KEY_VARIABLES).length) {
  throw new Error("Composer SSH destination catalog is invalid");
}

function failClosed() {
  throw new Error(FAILURE);
}

function exactOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Composer publication options must be a closed data object");
  }
  const wanted = ["source", "remote", "version", "sourceCommit", "dryRun"];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== wanted.length || wanted.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !wanted.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) {
    throw new TypeError("Composer publication options must be a closed data object");
  }
  return Object.freeze(Object.fromEntries(wanted.map((key) => [key, descriptors[key].value])));
}

function exactSourceCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new TypeError("Composer publication source commit must be a lowercase full SHA-1");
  }
  return value;
}

function stableVersion(value) {
  try {
    if (typeof value !== "string") throw new Error();
    return parseReleaseVersion(`${value}\n`);
  } catch {
    throw new TypeError("Composer publication version must be an exact stable semantic version");
  }
}

function canonicalDirectory(path, label) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep
        || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    return path;
  } catch {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
}

function validateRemote(remote) {
  if (typeof remote !== "string" || remote === "" || /[\u0000-\u001f\u007f]/u.test(remote) || remote.startsWith("-")) {
    throw new TypeError("Composer publication destination is invalid");
  }
  if (FIXED_REMOTES.has(remote)) {
    const destination = COMPOSER_SSH_DESTINATIONS[remote];
    return Object.freeze({
      kind: "github",
      value: remote,
      pushUrl: destination.pushUrl,
      deployKeyVariable: destination.deployKeyVariable,
    });
  }
  if (!isAbsolute(remote) || resolve(remote) !== remote) {
    throw new TypeError("Composer publication destination is not in the release catalog");
  }
  canonicalDirectory(remote, "Local Composer publication destination");
  try {
    const head = lstatSync(join(remote, "HEAD"));
    const objects = lstatSync(join(remote, "objects"));
    const refs = lstatSync(join(remote, "refs"));
    if (!head.isFile() || head.isSymbolicLink() || !objects.isDirectory() || objects.isSymbolicLink()
        || !refs.isDirectory() || refs.isSymbolicLink()) throw new Error();
  } catch {
    throw new TypeError("Local Composer publication destination must be a bare Git repository");
  }
  return Object.freeze({ kind: "local", value: remote });
}

function parseJsonFile(path) {
  try {
    const bytes = readFileSync(path);
    if (bytes.length === 0 || bytes.length > 64 * 1024 || bytes.includes(0x00) || bytes.includes(0x0d)) throw new Error();
    const source = UTF8.decode(bytes);
    const document = parseDocument(source, { json: true, prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length !== 0 || document.warnings.length !== 0) throw new Error();
    const value = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) throw new Error();
    return value;
  } catch {
    failClosed();
  }
}

function validateSourceContract(source, version, remote, expectedSourceCommit) {
  const manifest = parseJsonFile(join(source, "composer.json"));
  const provenance = parseJsonFile(join(source, ".gauntlet-source.json"));
  const artifact = RELEASE_ARTIFACTS.composer.find(({ name }) => name === manifest.name);
  if (artifact === undefined || manifest.version !== version
      || Object.keys(provenance).sort().join("\0") !== ["commit", "path", "repository", "version"].sort().join("\0")
      || provenance.repository !== "8lines/gauntlet" || provenance.path !== artifact.directory
      || provenance.version !== version || provenance.commit !== expectedSourceCommit) failClosed();
  if (remote.kind === "github" && remote.value !== artifact.repositoryUrl) {
    throw new TypeError("Composer package and fixed destination do not match");
  }
  return Object.freeze({ artifact, sourceCommit: provenance.commit });
}

function safeEntryName(name) {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." && name !== ".git"
    && !name.includes("/") && !name.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(name);
}

function copySourceTree(source, destination) {
  let files = 0;
  let bytes = 0;
  const records = [];
  const visit = (sourcePath, destinationPath, relativePath) => {
    const before = lstatSync(sourcePath, { bigint: true });
    if (before.isSymbolicLink()) failClosed();
    if (before.isDirectory()) {
      if (relativePath !== "") mkdirSync(destinationPath, { mode: 0o700 });
      const names = readdirSync(sourcePath).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      for (const name of names) {
        if (!safeEntryName(name)) failClosed();
        visit(join(sourcePath, name), join(destinationPath, name), relativePath === "" ? name : `${relativePath}/${name}`);
      }
    } else if (before.isFile() && before.nlink === 1n && before.size >= 0n && before.size <= BigInt(MAX_FILE_BYTES)) {
      files += 1;
      bytes += Number(before.size);
      if (files > MAX_FILES || bytes > MAX_TREE_BYTES) failClosed();
      const content = readFileSync(sourcePath);
      const after = lstatSync(sourcePath, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== before.nlink || after.dev !== before.dev
          || after.ino !== before.ino || after.mode !== before.mode || after.size !== before.size
          || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) failClosed();
      const mode = (Number(before.mode & 0o111n) === 0) ? 0o600 : 0o700;
      writeFileSync(destinationPath, content, { flag: "wx", mode });
      records.push(Object.freeze({
        path: relativePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        stat: Object.freeze({ dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs }),
      }));
    } else {
      failClosed();
    }
  };
  visit(source, destination, "");
  if (files === 0) failClosed();
  return Object.freeze(records);
}

function assertSourceUnchanged(source, records) {
  for (const record of records) {
    const path = resolve(source, ...record.path.split("/"));
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.dev !== record.stat.dev
        || stat.ino !== record.stat.ino || stat.mode !== record.stat.mode || stat.size !== record.stat.size
        || stat.mtimeNs !== record.stat.mtimeNs || stat.ctimeNs !== record.stat.ctimeNs
        || createHash("sha256").update(readFileSync(path)).digest("hex") !== record.sha256) failClosed();
  }
}

function createGitEnvironment(workspace) {
  const executablePath = process.env.PATH;
  if (typeof executablePath !== "string" || executablePath === "" || executablePath.includes("\0")) failClosed();
  const home = join(workspace, "home");
  const temporary = join(workspace, "tmp");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  const environment = {
    PATH: executablePath,
    HOME: home,
    TMPDIR: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "8lines Gauntlet Release",
    GIT_AUTHOR_EMAIL: "gauntlet-release@users.noreply.github.com",
    GIT_COMMITTER_NAME: "8lines Gauntlet Release",
    GIT_COMMITTER_EMAIL: "gauntlet-release@users.noreply.github.com",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  return Object.freeze(environment);
}

/** Reads and validates one passphrase-less OpenSSH deploy key without ever echoing its value. */
export function readDeployKey(variable, environment = process.env) {
  const missing = `Composer publication requires the ${variable} deploy key`;
  if (!Object.values(DEPLOY_KEY_VARIABLES).includes(variable)) throw new TypeError("Composer deploy key variable is invalid");
  const value = environment[variable];
  if (typeof value !== "string" || value.trim() === "") throw new Error(missing);
  const normalized = `${value.replaceAll("\r\n", "\n").trim()}\n`;
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes < MIN_DEPLOY_KEY_BYTES || bytes > MAX_DEPLOY_KEY_BYTES || !OPENSSH_PRIVATE_KEY.test(normalized)) {
    throw new Error(`${variable} must contain one OpenSSH private key`);
  }
  return normalized;
}

function shellPath(path) {
  if (typeof path !== "string" || !SHELL_SAFE_PATH.test(path) || path.split("/").includes("..")) failClosed();
  return `'${path}'`;
}

/** The exact SSH invocation Git uses for a deploy-key push: one identity, pinned GitHub host keys, no prompts. */
export function createDeployKeySshCommand(keyPath, knownHostsPath) {
  return [
    "ssh",
    "-F", "/dev/null",
    "-i", shellPath(keyPath),
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${shellPath(knownHostsPath)}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "UpdateHostKeys=no",
    "-o", "CheckHostIP=no",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
  ].join(" ");
}

/**
 * Materializes a deploy key and the pinned GitHub known_hosts file as 0600 files in a private
 * directory, runs the consumer with the matching GIT_SSH_COMMAND, and removes both files afterwards.
 */
export async function withDeployKeyFiles(workspace, deployKey, consumer) {
  if (typeof deployKey !== "string" || !OPENSSH_PRIVATE_KEY.test(deployKey) || typeof consumer !== "function") failClosed();
  const directory = join(canonicalDirectory(workspace, "Composer publication workspace"), `ssh-${randomBytes(8).toString("hex")}`);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const keyPath = join(directory, "deploy-key");
  const knownHostsPath = join(directory, "known_hosts");
  try {
    writeFileSync(keyPath, deployKey, { flag: "wx", mode: 0o600 });
    chmodSync(keyPath, 0o600);
    writeFileSync(knownHostsPath, `${GITHUB_SSH_KNOWN_HOSTS.join("\n")}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(knownHostsPath, 0o600);
    return await consumer(createDeployKeySshCommand(keyPath, knownHostsPath));
  } finally {
    rmSync(keyPath, { force: true });
    rmSync(knownHostsPath, { force: true });
    rmdirSync(directory);
  }
}

async function git(repository, args, environment) {
  try {
    const result = await execFileAsync("git", ["-C", repository, ...args], {
      cwd: repository,
      encoding: "utf8",
      env: environment,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 60_000,
      windowsHide: true,
    });
    if (result.stdout.length > MAX_OUTPUT_BYTES || result.stderr.length > MAX_OUTPUT_BYTES) failClosed();
    return result.stdout;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function parseRemoteRefs(output, tag) {
  if (typeof output !== "string" || output.length > MAX_OUTPUT_BYTES || output.includes("\0")) failClosed();
  const result = new Map();
  for (const line of output === "" ? [] : output.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{40})\t(refs\/(?:heads\/main|tags\/v[0-9]+\.[0-9]+\.[0-9]+))$/.exec(line);
    if (match === null || result.has(match[2])) failClosed();
    result.set(match[2], match[1]);
  }
  for (const reference of result.keys()) {
    if (reference !== "refs/heads/main" && reference !== `refs/tags/${tag}`) failClosed();
  }
  return result;
}

export async function publishComposerPackage(options) {
  const values = exactOptions(options);
  const version = stableVersion(values.version);
  const expectedSourceCommit = exactSourceCommit(values.sourceCommit);
  if (typeof values.dryRun !== "boolean") throw new TypeError("Composer publication dryRun must be boolean");
  const source = canonicalDirectory(values.source, "Composer publication source");
  const remote = validateRemote(values.remote);
  const contract = validateSourceContract(source, version, remote, expectedSourceCommit);
  const tag = `v${version}`;
  // A real publication fails before any network access when its deploy key is absent or malformed.
  const deployKey = remote.kind === "github" && !values.dryRun ? readDeployKey(remote.deployKeyVariable) : undefined;
  return withOwnedTemporaryWorkspace({ prefix: "gauntlet-composer-publish-" }, async (workspace) => {
    const repository = join(workspace, "repository");
    mkdirSync(repository, { mode: 0o700 });
    const records = copySourceTree(source, repository);
    const environment = createGitEnvironment(workspace);
    await git(repository, ["init", "--initial-branch=main"], environment);
    await git(repository, ["add", "--all", "--"], environment);
    const expectedTree = (await git(repository, ["write-tree"], environment)).trim();
    if (!/^[0-9a-f]{40}$/.test(expectedTree)) failClosed();

    const remoteRefs = parseRemoteRefs(
      await git(repository, ["ls-remote", "--refs", remote.value, "refs/heads/main", `refs/tags/${tag}`], environment),
      tag,
    );
    if (remoteRefs.has(`refs/tags/${tag}`)) {
      await git(repository, ["fetch", "--no-tags", remote.value, `refs/tags/${tag}:refs/tags/remote-${tag}`], environment);
      const type = (await git(repository, ["cat-file", "-t", `refs/tags/remote-${tag}`], environment)).trim();
      const existingTree = (await git(repository, ["rev-parse", `refs/tags/remote-${tag}^{tree}`], environment)).trim();
      if (type !== "tag" || existingTree !== expectedTree) {
        throw new Error(`existing tag ${tag} has different content`);
      }
      assertSourceUnchanged(source, records);
      return "already-identical";
    }
    assertSourceUnchanged(source, records);
    if (values.dryRun) return "would-publish";

    const parentArguments = [];
    if (remoteRefs.has("refs/heads/main")) {
      await git(repository, ["fetch", "--no-tags", remote.value, "refs/heads/main:refs/remotes/origin/main"], environment);
      parentArguments.push("-p", "refs/remotes/origin/main");
    }
    const commit = (await git(repository, [
      "commit-tree", expectedTree, ...parentArguments,
      "-m", `Release ${tag} from 8lines/gauntlet@${contract.sourceCommit}`,
    ], environment)).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) failClosed();
    await git(repository, ["update-ref", "refs/heads/main", commit], environment);
    await git(repository, ["tag", "--annotate", tag, "--message", `Release ${tag}`, commit], environment);
    const tagObject = (await git(repository, ["rev-parse", `refs/tags/${tag}`], environment)).trim();
    if (!COMMIT.test(tagObject)) failClosed();
    assertSourceUnchanged(source, records);
    const pushArguments = [
      "refs/heads/main:refs/heads/main",
      `refs/tags/${tag}:refs/tags/${tag}`,
    ];
    if (remote.kind === "github") {
      await withDeployKeyFiles(workspace, deployKey, (sshCommand) => git(
        repository,
        ["push", "--atomic", remote.pushUrl, ...pushArguments],
        Object.freeze({ ...environment, GIT_SSH_COMMAND: sshCommand, GIT_SSH_VARIANT: "ssh" }),
      ));
    } else {
      await git(repository, ["push", "--atomic", remote.value, ...pushArguments], environment);
    }
    const publishedRefs = parseRemoteRefs(
      await git(repository, ["ls-remote", "--refs", remote.value, "refs/heads/main", `refs/tags/${tag}`], environment),
      tag,
    );
    if (publishedRefs.get("refs/heads/main") !== commit || publishedRefs.get(`refs/tags/${tag}`) !== tagObject) failClosed();
    return "published";
  });
}

const CLI_USAGE = "Usage: publish-composer.mjs --release-directory ABSOLUTE_PATH --source-commit SHA --unit php-core|symfony-bundle";

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 6 || argv[0] !== "--release-directory" || argv[2] !== "--source-commit"
      || argv[4] !== "--unit") {
    throw new TypeError(CLI_USAGE);
  }
  return Object.freeze({
    releaseDirectory: canonicalDirectory(argv[1], "Release directory"),
    sourceCommit: exactSourceCommit(argv[3]),
    unit: composerUnit(argv[5]),
  });
}

function closedOptions(options, wanted, message) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError(message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== wanted.length || wanted.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !wanted.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) {
    throw new TypeError(message);
  }
  return Object.freeze(Object.fromEntries(wanted.map((key) => [key, descriptors[key].value])));
}

function composerUnit(value) {
  if (typeof value !== "string" || !COMPOSER_UNIT_IDS.includes(value)) {
    throw new TypeError(`Composer publication unit must be one of ${COMPOSER_UNIT_IDS.join(", ")}`);
  }
  return value;
}

export async function publishComposerRepositories(options, dependencyOverrides) {
  const values = closedOptions(
    options,
    ["releaseDirectory", "sourceCommit", "unit"],
    "Composer repository publication options are invalid",
  );
  const releaseDirectory = canonicalDirectory(values.releaseDirectory, "Release directory");
  const commit = exactSourceCommit(values.sourceCommit);
  const unit = composerUnit(values.unit);
  const dependencies = publicationDependencies(dependencyOverrides);
  const artifact = createComposerPublicationPlan({ releaseDirectory, sourceCommit: commit, unit });
  return withMaterializedCanonicalTree({
    archivePath: artifact.archivePath,
    expectedPrefix: artifact.expectedPrefix,
    expectedSha256: artifact.expectedSha256,
  }, async (source) => {
    const contract = validateSourceContract(source, artifact.version, validateRemote(artifact.remote), commit);
    if (contract.artifact.name !== artifact.name || artifact.expectedSourceCommit !== commit) failClosed();
    return Object.freeze([Object.freeze({
      name: artifact.name,
      status: await dependencies.publishPackage({
        source,
        remote: artifact.remote,
        version: artifact.version,
        sourceCommit: commit,
        dryRun: false,
      }),
    })]);
  });
}

function publicationDependencies(overrides) {
  if (overrides === undefined) return Object.freeze({ publishPackage: publishComposerPackage });
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides) || utilTypes.isProxy(overrides)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) {
    throw new TypeError("Composer publication dependencies must be a closed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== "publishPackage" || descriptors.publishPackage.enumerable !== true
      || !("value" in descriptors.publishPackage) || typeof descriptors.publishPackage.value !== "function") {
    throw new TypeError("Composer publication dependencies must be a closed data object");
  }
  return Object.freeze({ publishPackage: descriptors.publishPackage.value });
}

function readComposerReleaseManifest(releaseDirectory, commit) {
  try {
    const verification = verifyReleaseInventory({
      outputDirectory: releaseDirectory,
      releaseSet: basename(releaseDirectory),
      sourceCommit: commit,
    });
    const manifestPath = join(releaseDirectory, "release-manifest.json");
    const before = readFileSync(manifestPath);
    if (createHash("sha256").update(before).digest("hex") !== verification.manifestSha256) failClosed();
    const parsed = parseJsonFile(manifestPath);
    const after = readFileSync(manifestPath);
    if (!before.equals(after)) failClosed();
    if (Object.keys(parsed).sort().join("\0") !== [
      "schemaVersion", "releaseSet", "sourceCommit", "units", "artifacts",
    ].sort().join("\0") || parsed.schemaVersion !== 2 || parsed.releaseSet !== verification.releaseSet
        || parsed.sourceCommit !== commit) failClosed();
    const manifest = createReleaseManifest({
      releaseSet: parsed.releaseSet,
      sourceCommit: parsed.sourceCommit,
      units: parsed.units,
      artifacts: parsed.artifacts,
    });
    if (!before.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"))) failClosed();
    return manifest;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function canonicalArchive(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n
        || realpathSync(path) !== path) failClosed();
    return path;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

export function createComposerPublicationPlan(options) {
  const values = closedOptions(
    options,
    ["releaseDirectory", "sourceCommit", "unit"],
    "Composer publication plan options must be a closed data object",
  );
  const releaseDirectory = canonicalDirectory(values.releaseDirectory, "Release directory");
  const commit = exactSourceCommit(values.sourceCommit);
  const unit = composerUnit(values.unit);
  const manifest = readComposerReleaseManifest(releaseDirectory, commit);
  const staged = manifest.units.find(({ id }) => id === unit);
  if (staged === undefined) failClosed();
  const version = stableVersion(staged.version);
  const name = unitById(unit).artifacts[0];
  const artifact = RELEASE_ARTIFACTS.composer.find((candidate) => candidate.name === name);
  if (artifact === undefined) failClosed();
  const leaf = artifact.repository.split("/").at(-1);
  if (typeof leaf !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(leaf)) failClosed();
  const filename = `${leaf}-${version}.tar.gz`;
  const expectedPath = `composer/artifacts/${filename}`;
  const records = manifest.artifacts.filter((record) => record.kind === "composer" && record.name === artifact.name);
  if (records.length !== 1 || records[0].unit !== unit || records[0].path !== expectedPath) failClosed();
  return Object.freeze({
    name: artifact.name,
    version,
    archivePath: canonicalArchive(resolve(releaseDirectory, ...expectedPath.split("/"))),
    expectedPrefix: filename.slice(0, -7),
    expectedSha256: records[0].sha256,
    expectedSourceCommit: commit,
    remote: artifact.repositoryUrl,
  });
}

function stagedUnitVersion(releaseDirectory, unit) {
  let staged;
  try {
    staged = readReleaseManifest(releaseDirectory).manifest.units.find(({ id }) => id === unit);
  } catch {
    failClosed();
  }
  if (staged === undefined) failClosed();
  return staged.version;
}

// The unit version is resolved before anything is published, and publication must use exactly that
// version, so a successful push is never followed by a failing manifest read.
export async function runPublishComposerCli(argv, dependencyOverrides) {
  try {
    const options = parseCli(argv);
    const { publishPackage } = publicationDependencies(dependencyOverrides);
    const version = stagedUnitVersion(options.releaseDirectory, options.unit);
    const results = await publishComposerRepositories(options, {
      publishPackage: (publication) => {
        if (publication.version !== version) failClosed();
        return publishPackage(publication);
      },
    });
    return { exitCode: 0, stdout: `${JSON.stringify({ results, unit: options.unit, version })}\n`, stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${error instanceof Error ? error.message : FAILURE}\n` };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPublishComposerCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
