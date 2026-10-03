#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, types as utilTypes } from "node:util";

import { stageSkills } from "../skills/release-artifact.mjs";
import { writeReleaseInventory } from "./inventory.mjs";
import { packageComposeBundle } from "./package-compose.mjs";
import {
  readReleaseVersion,
  parseReleaseVersion,
  RELEASE_ARTIFACTS,
  RELEASE_STAGE_ARTIFACT_COUNT,
} from "./release-model.mjs";
import { COMPOSER_UNIT_IDS, stageComposerPackages } from "./stage-composer.mjs";
import { packageHelmChart } from "./stage-helm.mjs";
import { exportImageAndAttestations } from "./stage-image.mjs";
import { publishMavenLocally } from "./stage-maven.mjs";
import { NPM_UNIT_IDS, stageNpmPackages } from "./stage-npm.mjs";
import { generateSpdxSbom } from "./stage-sbom.mjs";
import { packageCanonicalTree } from "./tree-archive.mjs";

const execFileAsync = promisify(execFile);
const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const FAILURE = "Release staging failed closed";
const USAGE = "Usage: stage.mjs --output PATH";
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const QUARANTINE_TOKEN = /^[0-9a-f]{32}$/;
const RELEASE_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);

export const RELEASE_STAGE_PHASES = Object.freeze([
  "npm",
  "composer",
  "maven",
  "skills",
  "compose",
  "helm",
  "image",
  "sbom",
  "inventory",
]);

const DEFAULT_DEPENDENCIES = Object.freeze({
  exportImageAndAttestations,
  generateSpdxSbom,
  packageComposeBundle,
  packageCanonicalTree,
  packageHelmChart,
  publishMavenLocally,
  stageComposerPackages,
  stageNpmPackages,
  stageSkills,
  writeReleaseInventory,
});

function failClosed() {
  throw new Error(FAILURE);
}

function exactDataObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a closed data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))
      || actual.some((key) => typeof key !== "string" || !keys.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) {
    throw new TypeError(`${label} must be a closed data object`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function canonicalDirectory(path, label, privateDirectory = false) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep
        || path.includes(",") || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    if (privateDirectory) {
      const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
      if (stat.uid !== uid || (stat.mode & 0o077n) !== 0n) throw new Error();
    }
    return stat;
  } catch {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
}

function stableVersion(value) {
  try { return parseReleaseVersion(`${value}\n`); } catch { throw new TypeError("Release staging version is invalid"); }
}

function fullCommit(value) {
  if (typeof value !== "string" || !FULL_COMMIT.test(value)) {
    throw new TypeError("Release staging source commit must be a lowercase full SHA-1");
  }
  return value;
}

function makePrivateDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  canonicalDirectory(path, "Release staging directory", true);
  return path;
}

function sameDirectoryIdentity(stat, { dev, ino, uid }) {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && stat.dev === dev && stat.ino === ino && stat.uid === uid;
}

function sameSupportEntryIdentity(stat, entry, requireLinkCount = true) {
  const expectedType = entry.type === "directory" ? stat.isDirectory() : stat.isFile();
  return expectedType && !stat.isSymbolicLink()
    && stat.dev === entry.dev && stat.ino === entry.ino && stat.uid === entry.uid
    && stat.mode === entry.mode && (!requireLinkCount || stat.nlink === entry.nlink)
    && (entry.type !== "file" || stat.nlink === 1n);
}

function allowedSupportTree(workDirectory, path) {
  return path === join(workDirectory, "composer", "repositories")
    || path === join(workDirectory, "maven", "repository");
}

function ownedSupportTree(workDirectory, path) {
  if (!allowedSupportTree(workDirectory, path)) failClosed();
  const work = canonicalDirectory(workDirectory, "Release staging work directory", true);
  const stat = canonicalDirectory(path, "Release staging support tree", true);
  return Object.freeze({
    workDirectory,
    path,
    workDev: work.dev,
    workIno: work.ino,
    workUid: work.uid,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
  });
}

function supportTreeRecord(value) {
  const record = exactDataObject(
    value,
    ["workDirectory", "path", "workDev", "workIno", "workUid", "dev", "ino", "uid"],
    "Release staging support tree identity",
  );
  if (typeof record.workDirectory !== "string" || typeof record.path !== "string"
      || !allowedSupportTree(record.workDirectory, record.path)
      || [record.workDev, record.workIno, record.workUid, record.dev, record.ino, record.uid]
        .some((entry) => typeof entry !== "bigint" || entry < 0n)) failClosed();
  return record;
}

function assertOwnedDirectory(path, identity, privateDirectory = true) {
  const stat = canonicalDirectory(path, "Release staging owned directory", privateDirectory);
  if (!sameDirectoryIdentity(stat, identity)) failClosed();
  return stat;
}

function assertPathAbsent(path) {
  try {
    lstatSync(path);
    failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    if (error?.code !== "ENOENT") failClosed();
  }
}

function cleanupOptions(overrides) {
  if (overrides === undefined) {
    return Object.freeze({
      quarantineToken: randomBytes(16).toString("hex"),
      moveTree: renameSync,
      removeDirectory: rmdirSync,
      wait: () => new Promise((resolvePromise) => setTimeout(resolvePromise, 100)),
    });
  }
  const values = exactDataObject(
    overrides,
    ["quarantineToken", "moveTree", "wait", "removeDirectory"],
    "Release staging support cleanup options",
  );
  if (typeof values.quarantineToken !== "string" || !QUARANTINE_TOKEN.test(values.quarantineToken)
      || typeof values.moveTree !== "function" || typeof values.wait !== "function"
      || typeof values.removeDirectory !== "function") failClosed();
  return values;
}

function byteSortedNames(path) {
  return readdirSync(path)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function sameNames(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function supportEntry(relativePath, stat) {
  const type = stat.isDirectory() && !stat.isSymbolicLink()
    ? "directory"
    : stat.isFile() && !stat.isSymbolicLink() ? "file" : undefined;
  const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
  if (type === undefined || stat.uid !== uid || (type === "file" && stat.nlink !== 1n)) failClosed();
  return Object.freeze({
    relativePath,
    type,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
  });
}

function snapshotSupportTree(root, rootIdentity) {
  assertOwnedDirectory(root, rootIdentity);
  const journal = [];
  const visit = (path, relativePath) => {
    const before = lstatSync(path, { bigint: true });
    const entry = supportEntry(relativePath, before);
    if (entry.type !== "directory" || realpathSync(path) !== path) failClosed();
    journal.push(entry);
    const names = byteSortedNames(path);
    for (const name of names) {
      const childPath = join(path, name);
      const childRelativePath = relativePath === "" ? name : `${relativePath}/${name}`;
      const child = supportEntry(childRelativePath, lstatSync(childPath, { bigint: true }));
      if (child.type === "directory") visit(childPath, childRelativePath);
      else journal.push(child);
    }
    if (!sameNames(names, byteSortedNames(path))) failClosed();
    const after = lstatSync(path, { bigint: true });
    if (!sameSupportEntryIdentity(after, entry)) failClosed();
  };
  visit(root, "");
  if (!sameDirectoryIdentity(lstatSync(root, { bigint: true }), rootIdentity)) failClosed();
  return Object.freeze(journal);
}

function sameSupportJournal(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const actual = right[index];
    return actual !== undefined && entry.relativePath === actual.relativePath && entry.type === actual.type
      && entry.dev === actual.dev && entry.ino === actual.ino && entry.uid === actual.uid
      && entry.mode === actual.mode && entry.nlink === actual.nlink;
  });
}

function assertCleanupContext(record, workIdentity, quarantineRoot, quarantineIdentity) {
  assertOwnedDirectory(record.workDirectory, workIdentity);
  assertOwnedDirectory(quarantineRoot, quarantineIdentity);
  assertPathAbsent(record.path);
}

function journalPath(root, relativePath) {
  const path = relativePath === "" ? root : join(root, ...relativePath.split("/"));
  if (path !== root && !path.startsWith(`${root}${sep}`)) failClosed();
  return path;
}

function removeOwnedFile(path, entry) {
  const stat = lstatSync(path, { bigint: true });
  if (entry.type !== "file" || !sameSupportEntryIdentity(stat, entry)) failClosed();
  unlinkSync(path);
  assertPathAbsent(path);
}

async function removeOwnedDirectory(path, entry, assertContext, removeDirectory, wait) {
  if (entry.type !== "directory") failClosed();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assertContext();
    const stat = lstatSync(path, { bigint: true });
    if (!sameSupportEntryIdentity(stat, entry, false)) failClosed();
    try {
      removeDirectory(path);
      assertPathAbsent(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY") failClosed();
      assertContext();
      const current = lstatSync(path, { bigint: true });
      if (!sameSupportEntryIdentity(current, entry, false) || attempt === 4) failClosed();
      await wait();
    }
  }
  failClosed();
}

function removeEmptyOwnedDirectory(path, identity) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (sameDirectoryIdentity(stat, identity)) rmdirSync(path);
  } catch {
    // The caller fails closed; never broaden cleanup to a replacement path.
  }
}

export async function removeOwnedSupportTree(value, overrides) {
  const record = supportTreeRecord(value);
  const { quarantineToken, moveTree, removeDirectory, wait } = cleanupOptions(overrides);
  const workIdentity = { dev: record.workDev, ino: record.workIno, uid: record.workUid };
  const treeIdentity = { dev: record.dev, ino: record.ino, uid: record.uid };
  const quarantineRoot = join(record.workDirectory, `.gauntlet-retired-support-${quarantineToken}`);
  const quarantinedTree = join(quarantineRoot, "tree");
  let quarantineIdentity;
  let quarantineEntry;
  try {
    assertOwnedDirectory(record.workDirectory, workIdentity);
    assertOwnedDirectory(record.path, treeIdentity);
    const journal = snapshotSupportTree(record.path, treeIdentity);
    assertPathAbsent(quarantineRoot);
    mkdirSync(quarantineRoot, { mode: 0o700 });
    quarantineIdentity = canonicalDirectory(quarantineRoot, "Release staging cleanup quarantine", true);
    quarantineEntry = supportEntry("", quarantineIdentity);
    assertOwnedDirectory(record.workDirectory, workIdentity);
    assertOwnedDirectory(record.path, treeIdentity);
    assertPathAbsent(quarantinedTree);
    moveTree(record.path, quarantinedTree);
    assertOwnedDirectory(quarantinedTree, treeIdentity);
    assertPathAbsent(record.path);

    const quarantinedJournal = snapshotSupportTree(quarantinedTree, treeIdentity);
    if (!sameSupportJournal(journal, quarantinedJournal)) failClosed();
    const assertContext = () => {
      assertCleanupContext(record, workIdentity, quarantineRoot, quarantineIdentity);
      assertOwnedDirectory(quarantinedTree, treeIdentity);
    };
    for (const entry of journal.toReversed()) {
      assertContext();
      const path = journalPath(quarantinedTree, entry.relativePath);
      if (entry.type === "file") removeOwnedFile(path, entry);
      else await removeOwnedDirectory(path, entry, assertContext, removeDirectory, wait);
    }
    await removeOwnedDirectory(
      quarantineRoot,
      quarantineEntry,
      () => {
        assertOwnedDirectory(record.workDirectory, workIdentity);
        assertPathAbsent(record.path);
      },
      removeDirectory,
      wait,
    );
    assertPathAbsent(quarantineRoot);
    assertPathAbsent(record.path);
  } catch (error) {
    if (quarantineIdentity !== undefined) removeEmptyOwnedDirectory(quarantineRoot, quarantineIdentity);
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function dependencySet(overrides) {
  if (overrides === undefined) return DEFAULT_DEPENDENCIES;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides) || utilTypes.isProxy(overrides)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) {
    throw new TypeError("Release staging dependencies must be a closed data object");
  }
  const expected = Object.keys(DEFAULT_DEPENDENCIES);
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key])
        || typeof descriptors[key].value !== "function")) {
    throw new TypeError("Release staging dependencies must be a closed data object");
  }
  return Object.freeze(Object.fromEntries(expected.map((key) => [key, descriptors[key].value])));
}

function relativeArtifactPath(workDirectory, path) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) failClosed();
    const relativePath = relative(workDirectory, path);
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)
        || isAbsolute(relativePath) || relativePath.includes("\\")) failClosed();
    const segments = relativePath.split(sep);
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".."
        || !/^[A-Za-z0-9@._+:-]+$/.test(segment))) failClosed();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n) failClosed();
    return segments.join("/");
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function validateVersionedRecord(record, kind, expected, version, directory = false, expectedParent) {
  if (record === null || typeof record !== "object" || Array.isArray(record)
      || record.kind !== kind || record.name !== expected.name || record.version !== version
      || typeof record.path !== "string") failClosed();
  try {
    const stat = lstatSync(record.path, { bigint: true });
    if ((directory && (!stat.isDirectory() || stat.isSymbolicLink()))
        || (!directory && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n))) failClosed();
    if (realpathSync(record.path) !== record.path) failClosed();
    if (expectedParent !== undefined && record.path !== expectedParent
        && !record.path.startsWith(`${expectedParent}${sep}`)) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
  return record;
}

function validateRecordArray(records, kind, expected, version, directory = false, expectedParent) {
  if (!Array.isArray(records) || records.length !== expected.length) failClosed();
  const byName = new Map(records.map((record) => [record?.name, record]));
  if (byName.size !== expected.length) failClosed();
  return expected.map((artifact) => validateVersionedRecord(
    byName.get(artifact.name), kind, artifact, version, directory, expectedParent,
  ));
}

function artifactDescriptor(workDirectory, record) {
  return Object.freeze({
    kind: record.kind,
    name: record.name,
    path: relativeArtifactPath(workDirectory, record.path),
  });
}

function archiveTrees(workDirectory, kind, records, outputDirectory, version, packager) {
  return records.map((record) => {
    const leaf = kind === "composer" ? record.repository.split("/").at(-1) : record.name.split(":")[1];
    if (typeof leaf !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(leaf)) failClosed();
    const filename = kind === "composer"
      ? `${leaf}-${version}.tar.gz`
      : `gauntlet-${leaf}-${version}.tar.gz`;
    const receipt = packager({
      archivePrefix: filename.slice(0, -7),
      filename,
      outputDirectory,
      sourceDirectory: record.path,
    });
    return Object.freeze({ kind, name: record.name, path: receipt.path, version });
  });
}

function assertDistinctDescriptors(records) {
  const paths = new Set();
  const identities = new Set();
  for (const record of records) {
    const identity = `${record.kind}\0${record.name}`;
    if (paths.has(record.path) || identities.has(identity)) failClosed();
    paths.add(record.path);
    identities.add(identity);
  }
}

export async function executeReleaseStage(options, dependencyOverrides) {
  const values = exactDataObject(
    options,
    ["root", "sourceCommit", "version", "workDirectory"],
    "Release staging execution options",
  );
  const root = values.root;
  const workDirectory = values.workDirectory;
  canonicalDirectory(root, "Release staging root");
  canonicalDirectory(workDirectory, "Release staging work directory", true);
  if (workDirectory.startsWith(`${root}${sep}`) || root.startsWith(`${workDirectory}${sep}`)
      || readdirSync(workDirectory).length !== 0) failClosed();
  const sourceCommit = fullCommit(values.sourceCommit);
  const version = stableVersion(values.version);
  const dependencies = dependencySet(dependencyOverrides);
  const descriptors = [];

  const npmDirectory = makePrivateDirectory(join(workDirectory, "npm"));
  const npm = validateRecordArray(
    await dependencies.stageNpmPackages({
      root,
      outputDirectory: npmDirectory,
      versions: Object.fromEntries(NPM_UNIT_IDS.map((id) => [id, version])),
      include: NPM_UNIT_IDS,
    }),
    "npm",
    RELEASE_ARTIFACTS.npm,
    version,
    false,
    npmDirectory,
  );
  descriptors.push(...npm.map((record) => artifactDescriptor(workDirectory, record)));

  const composerRoot = makePrivateDirectory(join(workDirectory, "composer"));
  const composerRepositories = makePrivateDirectory(join(composerRoot, "repositories"));
  const composer = validateRecordArray(
    await dependencies.stageComposerPackages({
      root,
      outputDirectory: composerRepositories,
      sourceCommit,
      versions: Object.fromEntries(COMPOSER_UNIT_IDS.map((id) => [id, version])),
      include: COMPOSER_UNIT_IDS,
    }),
    "composer",
    RELEASE_ARTIFACTS.composer,
    version,
    true,
    composerRepositories,
  );
  for (const [index, expected] of RELEASE_ARTIFACTS.composer.entries()) {
    if (composer[index].repository !== expected.repository || composer[index].repositoryUrl !== expected.repositoryUrl
        || composer[index].sourceCommit !== sourceCommit) failClosed();
  }
  const composerSupportTree = ownedSupportTree(workDirectory, composerRepositories);
  const composerArchives = makePrivateDirectory(join(composerRoot, "artifacts"));
  descriptors.push(...archiveTrees(
    workDirectory, "composer", composer, composerArchives, version, dependencies.packageCanonicalTree,
  )
    .map((record) => artifactDescriptor(workDirectory, record)));
  await removeOwnedSupportTree(composerSupportTree);

  const mavenRoot = makePrivateDirectory(join(workDirectory, "maven"));
  const mavenRepository = makePrivateDirectory(join(mavenRoot, "repository"));
  const maven = validateRecordArray(
    await dependencies.publishMavenLocally({ root, outputDirectory: mavenRepository }),
    "maven",
    RELEASE_ARTIFACTS.maven,
    version,
    true,
    mavenRepository,
  );
  const mavenSupportTree = ownedSupportTree(workDirectory, mavenRepository);
  const mavenArchives = makePrivateDirectory(join(mavenRoot, "artifacts"));
  descriptors.push(...archiveTrees(
    workDirectory, "maven", maven, mavenArchives, version, dependencies.packageCanonicalTree,
  )
    .map((record) => artifactDescriptor(workDirectory, record)));
  await removeOwnedSupportTree(mavenSupportTree);

  const skillsDirectory = makePrivateDirectory(join(workDirectory, "skills"));
  const skills = validateVersionedRecord(
    await dependencies.stageSkills({ root, outputDirectory: skillsDirectory, version }),
    "skills",
    RELEASE_ARTIFACTS.skills,
    version,
    false,
    skillsDirectory,
  );
  descriptors.push(artifactDescriptor(workDirectory, skills));

  const composeDirectory = makePrivateDirectory(join(workDirectory, "compose"));
  const compose = validateVersionedRecord(
    dependencies.packageComposeBundle({ root, outputDirectory: composeDirectory }),
    "compose",
    RELEASE_ARTIFACTS.compose,
    version,
    false,
    composeDirectory,
  );
  descriptors.push(artifactDescriptor(workDirectory, compose));

  const helmDirectory = makePrivateDirectory(join(workDirectory, "helm"));
  const helm = validateVersionedRecord(
    dependencies.packageHelmChart({ root, outputDirectory: helmDirectory }),
    "helm",
    RELEASE_ARTIFACTS.chart,
    version,
    false,
    helmDirectory,
  );
  descriptors.push(artifactDescriptor(workDirectory, helm));

  const imageDirectory = makePrivateDirectory(join(workDirectory, "image"));
  const image = await dependencies.exportImageAndAttestations({ root, outputDirectory: imageDirectory, sourceCommit, version });
  if (image === null || typeof image !== "object" || !Array.isArray(image.artifacts)
      || image.artifacts.length !== 3 || !RELEASE_PLATFORMS.includes(image.hostPlatform)) failClosed();
  const imageKinds = new Map(image.artifacts.map((record) => [record?.kind, record]));
  if (imageKinds.size !== 3) failClosed();
  const docker = validateVersionedRecord(
    imageKinds.get("docker"),
    "docker",
    { name: "gauntlet.local/gauntlet" },
    version,
    false,
    imageDirectory,
  );
  const oci = validateVersionedRecord(
    imageKinds.get("oci"), "oci", RELEASE_ARTIFACTS.image, version, false, imageDirectory,
  );
  const provenance = validateVersionedRecord(
    imageKinds.get("provenance"),
    "provenance",
    { name: `${RELEASE_ARTIFACTS.image.name}@buildkit-unsigned` },
    version,
    false,
    imageDirectory,
  );
  descriptors.push(
    artifactDescriptor(workDirectory, docker),
    artifactDescriptor(workDirectory, oci),
    artifactDescriptor(workDirectory, provenance),
  );

  const sbomDirectory = makePrivateDirectory(join(workDirectory, "sbom"));
  for (const platform of RELEASE_PLATFORMS) {
    const platformName = platform.replace("/", "-");
    const sbom = validateVersionedRecord(
      dependencies.generateSpdxSbom({
        imageInspection: image.inspection,
        outputPath: join(sbomDirectory, `gauntlet-${platformName}.spdx.json`),
        platform,
        version,
      }),
      "sbom",
      { name: `${RELEASE_ARTIFACTS.image.name}@${platform}` },
      version,
      false,
      sbomDirectory,
    );
    descriptors.push(artifactDescriptor(workDirectory, sbom));
  }

  if (descriptors.length !== RELEASE_STAGE_ARTIFACT_COUNT) failClosed();
  assertDistinctDescriptors(descriptors);
  const manifest = await dependencies.writeReleaseInventory({
    outputDirectory: workDirectory,
    version,
    sourceCommit,
    artifacts: descriptors,
  });
  if (manifest === null || typeof manifest !== "object" || manifest.version !== version
      || manifest.sourceCommit !== sourceCommit || manifest.sourceTag !== `v${version}`
      || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== descriptors.length) failClosed();
  return manifest;
}

function commandEnvironment() {
  const path = process.env.PATH;
  if (typeof path !== "string" || path === "" || path.includes("\0")) failClosed();
  return Object.freeze({
    PATH: path,
    HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  });
}

async function runExact(command, args, root) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: commandEnvironment(),
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: 60_000,
      windowsHide: true,
    });
    if (result.stderr !== "") failClosed();
    return result.stdout;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

async function verifySource(root, sourceCommit) {
  const topLevel = await runExact("git", ["-C", root, "rev-parse", "--show-toplevel"], root);
  const head = await runExact("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], root);
  const status = await runExact("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], root);
  if (topLevel !== `${root}\n` || head !== `${sourceCommit}\n` || status !== "") failClosed();
  const versionOutput = await runExact(process.execPath, [join(root, "scripts/release/version.mjs"), "--check"], root);
  try {
    const report = JSON.parse(versionOutput);
    if (report.ok !== true || report.command !== "check" || report.version !== readReleaseVersion(root)
        || !Array.isArray(report.mismatches) || report.mismatches.length !== 0) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function stageLifecycle(overrides) {
  const defaults = { executeReleaseStage, verifySource };
  if (overrides === undefined) return defaults;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides) || utilTypes.isProxy(overrides)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) {
    throw new TypeError("Release staging lifecycle must be a closed data object");
  }
  const expected = Object.keys(defaults);
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key])
        || typeof descriptors[key].value !== "function")) {
    throw new TypeError("Release staging lifecycle must be a closed data object");
  }
  return Object.freeze(Object.fromEntries(expected.map((key) => [key, descriptors[key].value])));
}

function nearestExistingParent(path) {
  let cursor = path;
  const pending = [];
  while (true) {
    try {
      canonicalDirectory(cursor, "Release staging output ancestor");
      return { existing: cursor, pending: pending.toReversed() };
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) failClosed();
      pending.push(cursor);
      cursor = parent;
    }
  }
}

function ensureOutputParent(outputDirectory) {
  const parent = dirname(outputDirectory);
  const { existing, pending } = nearestExistingParent(parent);
  let cursor = existing;
  for (const path of pending) {
    if (dirname(path) !== cursor) failClosed();
    makePrivateDirectory(path);
    cursor = path;
  }
  canonicalDirectory(parent, "Release staging output parent");
  return parent;
}

function assertAbsent(path) {
  try {
    lstatSync(path);
    failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    if (error?.code !== "ENOENT") failClosed();
  }
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory()) failClosed();
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function stageRelease(options, lifecycleOverrides) {
  const values = exactDataObject(options, ["root", "outputDirectory", "sourceCommit"], "Release staging options");
  const lifecycle = stageLifecycle(lifecycleOverrides);
  const root = values.root;
  const outputDirectory = values.outputDirectory;
  canonicalDirectory(root, "Release staging root");
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory) || resolve(outputDirectory) !== outputDirectory
      || outputDirectory === sep || outputDirectory.includes(",") || /[\u0000-\u001f\u007f]/u.test(outputDirectory)
      || outputDirectory === root || root.startsWith(`${outputDirectory}${sep}`)) {
    throw new TypeError("Release staging output must be an absolute safe path outside the source ancestry");
  }
  const sourceCommit = fullCommit(values.sourceCommit);
  assertAbsent(outputDirectory);
  await lifecycle.verifySource(root, sourceCommit);
  const version = readReleaseVersion(root);
  const outputParent = ensureOutputParent(outputDirectory);
  const scratchParent = outputDirectory.startsWith(`${root}${sep}`) ? dirname(root) : outputParent;
  canonicalDirectory(scratchParent, "Release staging scratch parent");
  const workDirectory = realpathSync(mkdtempSync(join(scratchParent, ".gauntlet-release-stage-")));
  chmodSync(workDirectory, 0o700);
  const manifest = await lifecycle.executeReleaseStage({ root, sourceCommit, version, workDirectory });
  await lifecycle.verifySource(root, sourceCommit);
  assertAbsent(outputDirectory);
  renameSync(workDirectory, outputDirectory);
  canonicalDirectory(outputDirectory, "Release staging output", true);
  fsyncDirectory(outputParent);
  return manifest;
}

export function parseStageArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--output"
      || typeof argv[1] !== "string" || argv[1] === "" || argv[1].includes("\\")
      || /[\u0000-\u001f\u007f,]/u.test(argv[1])) throw new TypeError(USAGE);
  if (!isAbsolute(argv[1]) && argv[1].split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(USAGE);
  }
  const outputDirectory = isAbsolute(argv[1]) ? argv[1] : resolve(ROOT, argv[1]);
  if (resolve(outputDirectory) !== outputDirectory || outputDirectory === sep) throw new TypeError(USAGE);
  return { outputDirectory };
}

export async function readHeadCommit(root = ROOT) {
  canonicalDirectory(root, "Release staging root");
  const value = await runExact("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], root);
  const commit = value.endsWith("\n") ? value.slice(0, -1) : value;
  return fullCommit(commit);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { outputDirectory } = parseStageArguments(process.argv.slice(2));
    const sourceCommit = await readHeadCommit(ROOT);
    const manifest = await stageRelease({ root: ROOT, outputDirectory, sourceCommit });
    process.stdout.write(`${JSON.stringify({
      artifacts: manifest.artifacts.length,
      outputDirectory,
      sourceCommit: manifest.sourceCommit,
      version: manifest.version,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : FAILURE}\n`);
    process.exitCode = 1;
  }
}
