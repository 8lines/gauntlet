import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify, TextDecoder, types as utilTypes } from "node:util";

import { parseDocument } from "yaml";

import { unitIdForArtifact } from "./plan.mjs";
import { parseReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";
import { RELEASE_UNITS, dependencyOrder } from "./units.mjs";

const execFileAsync = promisify(execFile);
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_TREE_BYTES = 2 * 1024 * 1024;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 1_024;
export const COMPOSER_UNIT_IDS = Object.freeze(
  RELEASE_UNITS.filter(({ kind }) => kind === "composer").map(({ id }) => id),
);
const SYMFONY_CONSTRAINT = "^7.4 || ^8.0";
const CONTRACTS = Object.freeze({
  "8lines/gauntlet-php-core": Object.freeze({
    required: Object.freeze(["LICENSE", "README.md", "composer.json", "phpunit.xml.dist"]),
    optional: Object.freeze(["CHANGELOG.md"]),
    roots: Object.freeze(["src", "tests"]),
  }),
  "8lines/gauntlet-symfony-bundle": Object.freeze({
    required: Object.freeze(["LICENSE", "README.md", "composer.json", "phpunit.xml.dist"]),
    optional: Object.freeze(["CHANGELOG.md"]),
    roots: Object.freeze(["config", "src", "tests"]),
  }),
});

function fixedFailure() {
  throw new Error("Composer package staging failed closed");
}

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError("Composer staging options must be a closed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  const wanted = ["root", "outputDirectory", "sourceCommit", "versions", "include"];
  if (keys.length !== wanted.length || wanted.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !wanted.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) {
    throw new TypeError("Composer staging options must be a closed data object");
  }
  return Object.freeze({
    root: descriptors.root.value,
    outputDirectory: descriptors.outputDirectory.value,
    sourceCommit: descriptors.sourceCommit.value,
    versions: validateUnitVersions(descriptors.versions.value),
    include: validateInclude(descriptors.include.value),
  });
}

function validateUnitVersions(versions) {
  try {
    if (versions === null || typeof versions !== "object" || Array.isArray(versions) || utilTypes.isProxy(versions)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(versions))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(versions);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== COMPOSER_UNIT_IDS.length
        || keys.some((key) => typeof key !== "string" || !COMPOSER_UNIT_IDS.includes(key)
          || descriptors[key].enumerable !== true || !("value" in descriptors[key])
          || typeof descriptors[key].value !== "string"
          || parseReleaseVersion(`${descriptors[key].value}\n`) !== descriptors[key].value)) throw new Error();
    return Object.freeze(Object.fromEntries(COMPOSER_UNIT_IDS.map((id) => [id, descriptors[id].value])));
  } catch {
    return fixedFailure();
  }
}

function validateInclude(include) {
  try {
    if (!Array.isArray(include) || utilTypes.isProxy(include) || include.length === 0
        || Object.getPrototypeOf(include) !== Array.prototype
        || Reflect.ownKeys(include).length !== include.length + 1) throw new Error();
    const ids = [];
    for (let index = 0; index < include.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(include, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !COMPOSER_UNIT_IDS.includes(descriptor.value)) throw new Error();
      ids.push(descriptor.value);
    }
    if (new Set(ids).size !== ids.length
        || JSON.stringify(dependencyOrder(ids)) !== JSON.stringify(ids)) throw new Error();
    return Object.freeze(ids);
  } catch {
    return fixedFailure();
  }
}

function validateDirectory(path, label, { privateDirectory = false } = {}) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep
        || /[\0-\x1f\x7f]/u.test(path)) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    if (privateDirectory) {
      const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
      if (stat.uid !== uid || (stat.mode & 0o077n) !== 0n) throw new Error();
    }
  } catch {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
}

function openDirectoryGuard(path) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!opened.isDirectory() || !pathname.isDirectory() || pathname.isSymbolicLink()
        || opened.dev !== pathname.dev || opened.ino !== pathname.ino || opened.mode !== pathname.mode
        || opened.uid !== pathname.uid || opened.gid !== pathname.gid || realpathSync(path) !== path) throw new Error();
    return Object.freeze({
      descriptor,
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode,
      uid: opened.uid,
      gid: opened.gid,
    });
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    fixedFailure();
  }
}

function assertDirectoryGuard(path, guard) {
  try {
    const opened = fstatSync(guard.descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    for (const current of [opened, pathname]) {
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== guard.dev || current.ino !== guard.ino
          || current.mode !== guard.mode || current.uid !== guard.uid || current.gid !== guard.gid) throw new Error();
    }
    if (realpathSync(path) !== path) throw new Error();
  } catch {
    fixedFailure();
  }
}

function openAncestorGuards(path) {
  const result = [];
  let current = path;
  try {
    while (true) {
      result.push(Object.freeze({ path: current, guard: openDirectoryGuard(current) }));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return Object.freeze(result);
  } catch (error) {
    for (const { guard } of result) closeSync(guard.descriptor);
    throw error;
  }
}

function assertAncestors(guards) {
  for (const { path, guard } of guards.toReversed()) assertDirectoryGuard(path, guard);
}

function closeGuards(guards) {
  for (const { guard } of guards) closeSync(guard.descriptor);
}

function gitEnvironment(workspace) {
  const path = process.env.PATH;
  if (typeof path !== "string" || path === "" || path.includes("\0")) fixedFailure();
  const home = join(workspace, "home");
  const config = join(workspace, "config");
  const temporary = join(workspace, "tmp");
  for (const directory of [home, config, temporary]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const globalConfig = join(config, "gitconfig");
  writeFileSync(globalConfig, "", { flag: "wx", mode: 0o600 });
  return Object.freeze({
    PATH: path,
    HOME: home,
    XDG_CONFIG_HOME: config,
    TMPDIR: temporary,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0",
  });
}

async function runGit(root, args, environment, guards, maximumBytes = MAX_TREE_BYTES) {
  try {
    assertAncestors(guards);
    const result = await execFileAsync("git", ["-C", root, ...args], {
      cwd: root,
      env: environment,
      encoding: "buffer",
      timeout: 30_000,
      maxBuffer: maximumBytes,
      windowsHide: true,
    });
    assertAncestors(guards);
    if (result.stderr.length !== 0 || result.stdout.length > maximumBytes) throw new Error();
    return result.stdout;
  } catch {
    fixedFailure();
  }
}

function parseTree(bytes, prefix) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_TREE_BYTES || bytes.at(-1) !== 0) fixedFailure();
  const entries = [];
  for (const raw of bytes.subarray(0, -1).toString("binary").split("\0")) {
    const tab = raw.indexOf("\t");
    if (tab === -1) fixedFailure();
    const header = raw.slice(0, tab);
    const pathBytes = Buffer.from(raw.slice(tab + 1), "binary");
    let path;
    try { path = UTF8.decode(pathBytes); } catch { fixedFailure(); }
    const match = /^(100644) blob ([0-9a-f]{40})$/.exec(header);
    if (match === null || (prefix !== "" && !path.startsWith(`${prefix}/`)) || /[\0-\x1f\x7f\\]/u.test(path)) fixedFailure();
    const relativePath = prefix === "" ? path : path.slice(prefix.length + 1);
    if (relativePath.split("/").some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) fixedFailure();
    entries.push(Object.freeze({ oid: match[2], path, relativePath }));
  }
  entries.sort((left, right) => binaryCompare(left.relativePath, right.relativePath));
  if (entries.length === 0 || entries.length > MAX_FILES
      || new Set(entries.map(({ relativePath }) => relativePath)).size !== entries.length) fixedFailure();
  return Object.freeze(entries);
}

function validateAllowedPath(contract, path) {
  if (path === "composer.lock") return false;
  if (contract.required.includes(path)) return true;
  if (contract.optional.includes(path)) return true;
  const [root, ...rest] = path.split("/");
  return contract.roots.includes(root) && rest.length > 0 && path.endsWith(".php");
}

function verifyGitBlob(oid, bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  if (createHash("sha1").update(header).update(bytes).digest("hex") !== oid) fixedFailure();
}

async function readBlob(root, oid, environment, guards) {
  const bytes = await runGit(root, ["cat-file", "blob", oid], environment, guards, MAX_BLOB_BYTES);
  verifyGitBlob(oid, bytes);
  return bytes;
}

function parseJson(bytes) {
  try {
    const source = UTF8.decode(bytes);
    if (source.includes("\r") || source.includes("\0")) throw new Error();
    const document = parseDocument(source, { json: true, prettyErrors: false, strict: true, uniqueKeys: true });
    const value = JSON.parse(source);
    if (document.errors.length !== 0 || value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    fixedFailure();
  }
}

function validateManifest(manifest, artifact, version, coreVersion) {
  try {
    if (manifest.name !== artifact.name || manifest.version !== version || manifest.license !== "Apache-2.0"
        || manifest.require?.php !== ">=8.3" || manifest.config?.["allow-plugins"] !== false) throw new Error();
    if (artifact.name === "8lines/gauntlet-php-core") {
      if (Object.hasOwn(manifest, "repositories")) throw new Error();
    } else {
      if (!Array.isArray(manifest.repositories) || manifest.repositories.length !== 1
          || !exactJson(manifest.repositories[0], { type: "path", url: "../core", options: { symlink: false } })
          || manifest.require["8lines/gauntlet-php-core"] !== `^${coreVersion}`) throw new Error();
      for (const [name, constraint] of [
        ...Object.entries(manifest.require ?? {}),
        ...Object.entries(manifest["require-dev"] ?? {}),
      ]) {
        if (name.startsWith("symfony/") && constraint !== SYMFONY_CONSTRAINT) throw new Error();
      }
    }
  } catch {
    fixedFailure();
  }
}

function projectManifest(bytes, artifact, version, coreVersion) {
  const manifest = parseJson(bytes);
  validateManifest(manifest, artifact, version, coreVersion);
  if (artifact.name === "8lines/gauntlet-symfony-bundle") delete manifest.repositories;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function frameTree(records) {
  const hash = createHash("sha256").update("gauntlet-composer-tree-v1\0");
  for (const record of records.toSorted((left, right) => binaryCompare(left.path, right.path))) {
    const path = Buffer.from(record.path);
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(path.length);
    const mode = Buffer.alloc(4);
    mode.writeUInt32BE(0o100644);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(record.bytes.length));
    hash.update(pathLength).update(path).update(mode).update(length).update(record.bytes);
  }
  return hash.digest("hex");
}

function writeProjection(root, records) {
  for (const record of records) {
    const segments = record.path.split("/");
    const parent = join(root, ...segments.slice(0, -1));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    writeFileSync(join(root, ...segments), record.bytes, { flag: "wx", mode: 0o644 });
    chmodSync(join(root, ...segments), 0o644);
  }
}

function snapshotProjection(root, records) {
  const expected = new Map(records.map((record) => [record.path, record]));
  const found = [];
  const visit = (directory, prefix) => {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) fixedFailure();
    for (const name of readdirSync(directory).sort(binaryCompare)) {
      if (name === "" || name.startsWith(".") && name !== ".gauntlet-source.json" || /[\0-\x1f\x7f\\/]/u.test(name)) fixedFailure();
      const path = join(directory, name);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const entry = lstatSync(path, { bigint: true });
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path, relativePath);
      else {
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || (entry.mode & 0o777n) !== 0o644n) fixedFailure();
        const bytes = readFileSync(path);
        const wanted = expected.get(relativePath);
        if (wanted === undefined || !bytes.equals(wanted.bytes)) fixedFailure();
        found.push(relativePath);
      }
    }
  };
  visit(root, "");
  if (!exactJson(found.sort(binaryCompare), [...expected.keys()].sort(binaryCompare))) fixedFailure();
}

async function capturePackage(root, artifact, version, coreVersion, commit, environment, guards, rootLicense) {
  const contract = CONTRACTS[artifact.name];
  if (contract === undefined) fixedFailure();
  const treeBytes = await runGit(root, ["ls-tree", "-rz", "--full-tree", commit, "--", artifact.directory], environment, guards);
  const entries = parseTree(treeBytes, artifact.directory);
  const paths = new Set(entries.map(({ relativePath }) => relativePath));
  if (contract.required.some((path) => !paths.has(path)) || contract.roots.some((path) => ![...paths].some((item) => item.startsWith(`${path}/`)))) fixedFailure();
  if (entries.some(({ relativePath }) => relativePath !== "composer.lock" && !validateAllowedPath(contract, relativePath))) fixedFailure();
  const records = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.relativePath === "composer.lock") continue;
    const bytes = await readBlob(root, entry.oid, environment, guards);
    totalBytes += bytes.length;
    if (totalBytes > MAX_PACKAGE_BYTES) fixedFailure();
    records.push(Object.freeze({ path: entry.relativePath, bytes }));
  }
  const license = records.find(({ path }) => path === "LICENSE");
  const manifest = records.find(({ path }) => path === "composer.json");
  if (license === undefined || manifest === undefined || !license.bytes.equals(rootLicense)) fixedFailure();
  const projectedManifest = projectManifest(manifest.bytes, artifact, version, coreVersion);
  const projected = records.map((record) => record.path === "composer.json"
    ? Object.freeze({ path: record.path, bytes: projectedManifest })
    : record);
  const provenance = Buffer.from(`${JSON.stringify({
    repository: "8lines/gauntlet",
    commit,
    path: artifact.directory,
    version,
  }, null, 2)}\n`);
  projected.push(Object.freeze({ path: ".gauntlet-source.json", bytes: provenance }));
  projected.sort((left, right) => binaryCompare(left.path, right.path));
  return Object.freeze({ artifact, records: Object.freeze(projected), sha256: frameTree(projected) });
}

export async function stageComposerPackages(options) {
  const { root, outputDirectory, sourceCommit, versions, include } = validateOptions(options);
  validateDirectory(root, "Composer staging root");
  validateDirectory(outputDirectory, "Composer staging output", { privateDirectory: true });
  if (typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit)
      || outputDirectory.startsWith(`${root}${sep}`) || root.startsWith(`${outputDirectory}${sep}`)
      || readdirSync(outputDirectory).length !== 0) fixedFailure();

  const rootGuards = openAncestorGuards(root);
  const outputAncestors = openAncestorGuards(dirname(outputDirectory));
  let outputGuard;
  let readyGuard;
  const ready = mkdtempSync(join(dirname(outputDirectory), ".gauntlet-composer-ready-"));
  chmodSync(ready, 0o700);
  const workspace = join(ready, ".workspace");
  mkdirSync(workspace, { mode: 0o700 });
  let promoted = false;
  try {
    outputGuard = openDirectoryGuard(outputDirectory);
    readyGuard = openDirectoryGuard(ready);
    assertAncestors(rootGuards);
    assertAncestors(outputAncestors);
    assertDirectoryGuard(outputDirectory, outputGuard);
    if (readdirSync(outputDirectory).length !== 0) fixedFailure();
    const environment = gitEnvironment(workspace);
    const topLevel = await runGit(root, ["rev-parse", "--show-toplevel"], environment, rootGuards);
    if (!topLevel.equals(Buffer.from(`${root}\n`))) fixedFailure();
    await runGit(root, ["cat-file", "-e", `${sourceCommit}^{commit}`], environment, rootGuards, 1024);
    const licenseTree = parseTree(
      await runGit(root, ["ls-tree", "-z", "--full-tree", sourceCommit, "--", "LICENSE"], environment, rootGuards, 4096),
      "",
    );
    if (licenseTree.length !== 1 || licenseTree[0].relativePath !== "LICENSE") fixedFailure();
    const rootLicense = await readBlob(root, licenseTree[0].oid, environment, rootGuards);
    const captures = [];
    for (const id of include) {
      const artifact = RELEASE_ARTIFACTS.composer.find(({ name }) => unitIdForArtifact(name) === id);
      if (artifact === undefined) fixedFailure();
      captures.push(await capturePackage(
        root, artifact, versions[id], versions["php-core"], sourceCommit, environment, rootGuards, rootLicense,
      ));
    }
    rmSync(workspace, { recursive: true, force: false });
    for (const capture of captures) {
      const destination = join(ready, capture.artifact.repository);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      chmodSync(destination, 0o700);
      writeProjection(destination, capture.records);
      snapshotProjection(destination, capture.records);
    }
    assertDirectoryGuard(ready, readyGuard);
    assertAncestors(outputAncestors);
    assertDirectoryGuard(outputDirectory, outputGuard);
    if (readdirSync(outputDirectory).length !== 0) fixedFailure();
    renameSync(ready, outputDirectory);
    promoted = true;
    assertDirectoryGuard(outputDirectory, readyGuard);
    const result = captures.toSorted((left, right) => binaryCompare(left.artifact.name, right.artifact.name)).map((capture) => {
      const path = join(outputDirectory, capture.artifact.repository);
      snapshotProjection(path, capture.records);
      return Object.freeze({
        kind: "composer",
        name: capture.artifact.name,
        version: versions[unitIdForArtifact(capture.artifact.name)],
        path,
        repository: capture.artifact.repository,
        repositoryUrl: capture.artifact.repositoryUrl,
        sourceCommit,
        sha256: capture.sha256,
      });
    });
    assertDirectoryGuard(outputDirectory, readyGuard);
    return Object.freeze(result);
  } catch {
    fixedFailure();
  } finally {
    if (readyGuard !== undefined) closeSync(readyGuard.descriptor);
    if (outputGuard !== undefined) closeSync(outputGuard.descriptor);
    closeGuards(rootGuards);
    closeGuards(outputAncestors);
    if (!promoted) {
      // Ambiguous ready paths are quarantined rather than removed by pathname.
    }
  }
}
