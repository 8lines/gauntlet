#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

const FAILURE = "External inputs must use the closed content-bound layout";
const MAX_ENTRIES = 256;
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const ALLOWED_EXCLUSIONS = new Set([".phpunit.result.cache", "dist", "node_modules", "vendor"]);

const compare = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const fail = () => { throw new Error(FAILURE); };

function unsignedLength(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail();
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function updateCount(hash, tag, value) {
  hash.update(Buffer.from([tag]));
  hash.update(unsignedLength(value));
}

function updateBytes(hash, tag, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  updateCount(hash, tag, bytes.length);
  hash.update(bytes);
}

function closedRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string")
      || keys.some((key) => !Object.hasOwn(descriptors, key))) fail();
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined
        || descriptor.enumerable !== true) fail();
    result[key] = descriptor.value;
  }
  return result;
}

function closedArray(value, maximum = MAX_ENTRIES) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maximum) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key !== "string")) fail();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined
        || descriptor.set !== undefined || descriptor.enumerable !== true) fail();
    result.push(descriptor.value);
  }
  return result;
}

function safeDirectory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n) fail();
  return stat;
}

function sameEntry(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readStable(path, { allowHardlinks = false, maximumBytes = MAX_FILE_BYTES, expected } = {}) {
  let descriptor;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || (!allowHardlinks && before.nlink !== 1n)
        || before.nlink < 1n || before.size > BigInt(maximumBytes) || (before.mode & 0o022n) !== 0n
        || (expected !== undefined && !sameEntry(before, expected))) fail();
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameEntry(before, opened)) fail();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail();
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!sameEntry(opened, after) || !sameEntry(after, pathname)) fail();
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function contained(parent, candidate, { allowEqual = false } = {}) {
  return (allowEqual && candidate === parent) || candidate.startsWith(`${parent}${sep}`);
}

function relativePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || isAbsolute(value)
      || value.includes("\\") || /[\0-\x1f\x7f]/u.test(value)) fail();
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail();
  return parts;
}

function assertSorted(entries) {
  if (entries.some((entry, index) => index > 0 && compare(entries[index - 1].path, entry.path) >= 0)) fail();
}

function overlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateCollections(sourceFiles, sourceTrees, linkedRuntimeTrees, evaluationRelative) {
  const entries = [...sourceFiles, ...sourceTrees, ...linkedRuntimeTrees];
  if (entries.length < 1 || entries.length > MAX_ENTRIES) fail();
  assertSorted(sourceFiles);
  assertSorted(sourceTrees);
  assertSorted(linkedRuntimeTrees);
  for (let index = 0; index < entries.length; index += 1) {
    if (overlap(entries[index].path, evaluationRelative)) fail();
    for (let other = index + 1; other < entries.length; other += 1) {
      if (overlap(entries[index].path, entries[other].path)) fail();
    }
  }
}

function parseManifest(source, evaluationRelative) {
  let parsed;
  try { parsed = JSON.parse(source); } catch { fail(); }
  const root = closedRecord(parsed, ["schemaVersion", "sourceFiles", "sourceTrees", "linkedRuntimeTrees"]);
  if (root.schemaVersion !== 1) fail();
  const sourceFiles = closedArray(root.sourceFiles).map((candidate) => {
    const entry = closedRecord(candidate, ["path", "sha256"]);
    const parts = relativePath(entry.path);
    if (parts.includes("node_modules") || !/^[a-f0-9]{64}$/u.test(entry.sha256)) fail();
    return { path: entry.path, sha256: entry.sha256 };
  });
  const sourceTrees = closedArray(root.sourceTrees).map((candidate) => {
    const entry = closedRecord(candidate, ["path", "excludedTopLevel", "sha256"]);
    const parts = relativePath(entry.path);
    const excludedTopLevel = closedArray(entry.excludedTopLevel, ALLOWED_EXCLUSIONS.size);
    if (parts.includes("node_modules") || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || excludedTopLevel.some((name) => !ALLOWED_EXCLUSIONS.has(name))
        || excludedTopLevel.some((name, index) => index > 0 && compare(excludedTopLevel[index - 1], name) >= 0)) fail();
    return { path: entry.path, excludedTopLevel, sha256: entry.sha256 };
  });
  const linkedRuntimeTrees = closedArray(root.linkedRuntimeTrees).map((candidate) => {
    const entry = closedRecord(candidate, ["path", "sha256"]);
    const parts = relativePath(entry.path);
    if (!parts.includes("node_modules") || !/^[a-f0-9]{64}$/u.test(entry.sha256)) fail();
    return { path: entry.path, sha256: entry.sha256 };
  });
  validateCollections(sourceFiles, sourceTrees, linkedRuntimeTrees, evaluationRelative);
  const manifest = { schemaVersion: 1, sourceFiles, sourceTrees, linkedRuntimeTrees };
  if (source !== `${JSON.stringify(manifest, null, 2)}\n`) fail();
  return manifest;
}

function parseDeclaration(values, evaluationRelative) {
  const sourceFiles = closedArray(values.sourceFiles).map((path) => {
    const parts = relativePath(path);
    if (parts.includes("node_modules")) fail();
    return { path };
  });
  const sourceTrees = closedArray(values.sourceTrees).map((candidate) => {
    const entry = closedRecord(candidate, ["path", "excludedTopLevel"]);
    const parts = relativePath(entry.path);
    const excludedTopLevel = closedArray(entry.excludedTopLevel, ALLOWED_EXCLUSIONS.size);
    if (parts.includes("node_modules") || excludedTopLevel.some((name) => !ALLOWED_EXCLUSIONS.has(name))
        || excludedTopLevel.some((name, index) => index > 0 && compare(excludedTopLevel[index - 1], name) >= 0)) fail();
    return { path: entry.path, excludedTopLevel };
  });
  const linkedRuntimeTrees = closedArray(values.linkedRuntimeTrees).map((path) => {
    const parts = relativePath(path);
    if (!parts.includes("node_modules")) fail();
    return { path };
  });
  validateCollections(sourceFiles, sourceTrees, linkedRuntimeTrees, evaluationRelative);
  return { schemaVersion: 1, sourceFiles, sourceTrees, linkedRuntimeTrees };
}

function assertSourceAncestors(root, parts, { includeLeaf = false } = {}) {
  let current = root;
  const limit = includeLeaf ? parts.length : parts.length - 1;
  for (let index = 0; index < limit; index += 1) {
    current = resolve(current, parts[index]);
    safeDirectory(current);
  }
}

function collectTree(root, excludedTopLevel, { allowHardlinks, context }) {
  const files = [];
  const directories = [];
  const excludedEntries = [];
  const excluded = new Set(excludedTopLevel);
  const visit = (directory, depth = 0) => {
    const initial = safeDirectory(directory);
    directories.push({ path: directory, stat: initial });
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (depth === 0 && excluded.has(entry.name)) {
        const stat = lstatSync(path, { bigint: true });
        if (entry.name === ".phpunit.result.cache") {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n) fail();
          excludedEntries.push({ path, stat });
        } else {
          directories.push({ path, stat: safeDirectory(path) });
        }
        continue;
      }
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n) fail();
      if (stat.isDirectory()) visit(path, depth + 1);
      else if (stat.isFile() && (allowHardlinks || stat.nlink === 1n) && stat.nlink >= 1n) {
        context.files += 1;
        context.bytes += Number(stat.size);
        if (context.files > MAX_FILES || stat.size > BigInt(MAX_FILE_BYTES) || context.bytes > MAX_TOTAL_BYTES) fail();
        files.push({ path, relativePath: relative(root, path).split(sep).join("/"), stat });
      } else fail();
    }
  };
  visit(root);
  if (files.length === 0) fail();
  const orderedFiles = files.sort((left, right) => compare(left.relativePath, right.relativePath));
  const hash = createHash("sha256");
  hash.update("gauntlet-external-input-tree-v2\0", "ascii");
  updateCount(hash, 0x01, orderedFiles.length);
  for (const file of orderedFiles) {
    hash.update(Buffer.from([0x02]));
    updateBytes(hash, 0x03, file.relativePath);
    updateBytes(hash, 0x04, readStable(file.path, { allowHardlinks, expected: file.stat }));
  }
  for (const directory of directories.toReversed()) {
    if (!sameEntry(directory.stat, lstatSync(directory.path, { bigint: true }))) fail();
  }
  for (const entry of excludedEntries) {
    if (!sameEntry(entry.stat, lstatSync(entry.path, { bigint: true }))) fail();
  }
  return hash.digest("hex");
}

function sourceFileDigest(root, entry, context) {
  const parts = relativePath(entry.path);
  assertSourceAncestors(root, parts);
  const path = resolve(root, ...parts);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE_BYTES)
      || (stat.mode & 0o022n) !== 0n) fail();
  context.files += 1;
  context.bytes += Number(stat.size);
  if (context.files > MAX_FILES || context.bytes > MAX_TOTAL_BYTES) fail();
  return createHash("sha256").update(readStable(path, { expected: stat })).digest("hex");
}

function sourceTreeDigest(root, entry, context) {
  const parts = relativePath(entry.path);
  assertSourceAncestors(root, parts, { includeLeaf: true });
  const path = resolve(root, ...parts);
  return collectTree(path, entry.excludedTopLevel, { allowHardlinks: false, context });
}

function linkedRuntimeTarget(root, realRoot, realNodeModules, entry) {
  const parts = relativePath(entry.path);
  const nodeModulesIndex = parts.indexOf("node_modules");
  assertSourceAncestors(root, parts.slice(0, nodeModulesIndex + 1));
  const lexical = resolve(root, ...parts);
  const target = realpathSync(lexical);
  if (!contained(realNodeModules, target) || !contained(realRoot, target)) fail();
  safeDirectory(target);
  return target;
}

function locations(root, evaluationRoot) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === sep
      || typeof evaluationRoot !== "string" || !isAbsolute(evaluationRoot)
      || resolve(evaluationRoot) !== evaluationRoot || !contained(root, evaluationRoot)) fail();
  safeDirectory(root);
  const evaluationParts = relativePath(relative(root, evaluationRoot).split(sep).join("/"));
  assertSourceAncestors(root, evaluationParts, { includeLeaf: true });
  const realRoot = realpathSync(root);
  const realEvaluationRoot = realpathSync(evaluationRoot);
  if (!contained(realRoot, realEvaluationRoot)) fail();
  return {
    evaluationRelative: evaluationParts.join("/"),
    realRoot,
  };
}

function bindManifest(root, realRoot, manifest, { verify }) {
  const context = { bytes: 0, files: 0 };
  const sourceFiles = manifest.sourceFiles.map((entry) => {
    const actual = sourceFileDigest(root, entry, context);
    if (verify && actual !== entry.sha256) fail();
    return { path: entry.path, sha256: actual };
  });
  const sourceTrees = manifest.sourceTrees.map((entry) => {
    const actual = sourceTreeDigest(root, entry, context);
    if (verify && actual !== entry.sha256) fail();
    return { path: entry.path, excludedTopLevel: entry.excludedTopLevel, sha256: actual };
  });
  let realNodeModules;
  if (manifest.linkedRuntimeTrees.length > 0) {
    const nodeModules = resolve(root, "node_modules");
    safeDirectory(nodeModules);
    realNodeModules = realpathSync(nodeModules);
    if (!contained(realRoot, realNodeModules)) fail();
  }
  const realTargets = [];
  const linkedRuntimeTrees = manifest.linkedRuntimeTrees.map((entry) => {
    const target = linkedRuntimeTarget(root, realRoot, realNodeModules, entry);
    if (realTargets.some((other) => overlap(
      relative(realNodeModules, other).split(sep).join("/"),
      relative(realNodeModules, target).split(sep).join("/"),
    ))) fail();
    realTargets.push(target);
    const actual = collectTree(target, [], { allowHardlinks: true, context });
    if (verify && actual !== entry.sha256) fail();
    return { path: entry.path, sha256: actual };
  });
  return { schemaVersion: 1, sourceFiles, sourceTrees, linkedRuntimeTrees };
}

function boundManifestSha256(manifest) {
  const hash = createHash("sha256");
  hash.update("gauntlet-external-inputs-bound-manifest-v2\0", "ascii");
  updateCount(hash, 0x10, manifest.sourceFiles.length);
  for (const entry of manifest.sourceFiles) {
    hash.update(Buffer.from([0x11]));
    updateBytes(hash, 0x12, entry.path);
    updateBytes(hash, 0x13, entry.sha256);
  }
  updateCount(hash, 0x20, manifest.sourceTrees.length);
  for (const entry of manifest.sourceTrees) {
    hash.update(Buffer.from([0x21]));
    updateBytes(hash, 0x22, entry.path);
    updateCount(hash, 0x23, entry.excludedTopLevel.length);
    for (const exclusion of entry.excludedTopLevel) updateBytes(hash, 0x24, exclusion);
    updateBytes(hash, 0x25, entry.sha256);
  }
  updateCount(hash, 0x30, manifest.linkedRuntimeTrees.length);
  for (const entry of manifest.linkedRuntimeTrees) {
    hash.update(Buffer.from([0x31]));
    updateBytes(hash, 0x32, entry.path);
    updateBytes(hash, 0x33, entry.sha256);
  }
  return hash.digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeOwnedFile(path, identity) {
  try {
    const current = lstatSync(path, { bigint: true });
    if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1n && sameIdentity(current, identity)) {
      unlinkSync(path);
    }
  } catch {
    // Cleanup is best-effort and is restricted to this invocation's just-created inode.
  }
}

function writeNewManifest(path, bytes) {
  const temporaryPath = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  let descriptor;
  let identity;
  let published = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
      0o600,
    );
    identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n || identity.size !== 0n
        || (identity.mode & 0o077n) !== 0n) fail();
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail();
      offset += count;
    }
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(temporaryPath, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || after.size !== BigInt(bytes.length)
        || !sameIdentity(identity, after) || !sameEntry(after, pathname)) fail();
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, path);
    published = true;
    const linked = lstatSync(path, { bigint: true });
    const temporary = lstatSync(temporaryPath, { bigint: true });
    if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 2n
        || !sameIdentity(identity, linked) || !sameEntry(linked, temporary)) fail();
    unlinkSync(temporaryPath);
    const final = lstatSync(path, { bigint: true });
    if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1n
        || !sameIdentity(identity, final) || final.size !== BigInt(bytes.length)) fail();
    return final;
  } catch (error) {
    if (identity !== undefined) {
      removeOwnedFile(temporaryPath, identity);
      if (published) removeOwnedFile(path, identity);
    }
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseCliDeclaration(source) {
  if (typeof source !== "string" || source.length === 0
      || Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES || source.includes("\0")) fail();
  let parsed;
  try { parsed = JSON.parse(source); } catch { fail(); }
  if (source !== JSON.stringify(parsed)) fail();
  const declaration = closedRecord(parsed, [
    "schemaVersion", "sourceFiles", "sourceTrees", "linkedRuntimeTrees",
  ]);
  if (declaration.schemaVersion !== 1) fail();
  return declaration;
}

export function hashExternalInputs(options) {
  try {
    const values = closedRecord(options, ["root", "evaluationRoot"]);
    const { evaluationRelative, realRoot } = locations(values.root, values.evaluationRoot);
    const manifestPath = resolve(values.evaluationRoot, "external-inputs.json");
    const manifestBytes = readStable(manifestPath, { maximumBytes: MAX_MANIFEST_BYTES });
    if (manifestBytes.length === 0 || manifestBytes.includes(0)) fail();
    const source = manifestBytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(manifestBytes)) fail();
    const manifest = parseManifest(source, evaluationRelative);
    return boundManifestSha256(bindManifest(values.root, realRoot, manifest, { verify: true }));
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

export function generateExternalInputsManifest(options) {
  let manifestPath;
  let identity;
  try {
    const values = closedRecord(options, [
      "root", "evaluationRoot", "sourceFiles", "sourceTrees", "linkedRuntimeTrees",
    ]);
    const { evaluationRelative, realRoot } = locations(values.root, values.evaluationRoot);
    const declaration = parseDeclaration(values, evaluationRelative);
    const manifest = bindManifest(values.root, realRoot, declaration, { verify: false });
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (bytes.length > MAX_MANIFEST_BYTES) fail();
    manifestPath = resolve(values.evaluationRoot, "external-inputs.json");
    identity = writeNewManifest(manifestPath, bytes);
    return hashExternalInputs({ root: values.root, evaluationRoot: values.evaluationRoot });
  } catch (error) {
    if (identity !== undefined && manifestPath !== undefined) removeOwnedFile(manifestPath, identity);
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

export function runExternalInputsCli(args) {
  try {
    const values = closedArray(args, 7);
    if (values.length !== 7 || values[0] !== "generate" || values[1] !== "--root"
        || values[3] !== "--evaluation-root" || values[5] !== "--declaration-json") fail();
    const declaration = parseCliDeclaration(values[6]);
    const externalInputsSha256 = generateExternalInputsManifest({
      root: values[2],
      evaluationRoot: values[4],
      sourceFiles: declaration.sourceFiles,
      sourceTrees: declaration.sourceTrees,
      linkedRuntimeTrees: declaration.linkedRuntimeTrees,
    });
    process.stdout.write(`${JSON.stringify({ externalInputsSha256 })}\n`);
    return Object.freeze({ externalInputsSha256 });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runExternalInputsCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
