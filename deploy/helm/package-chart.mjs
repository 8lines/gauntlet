#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import { gunzipSync } from "node:zlib";
import { parseDocument } from "yaml";
import { createHelmRunner, repositoryRoot } from "./test-support.mjs";

const NORMALIZED_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
const NORMALIZED_MTIME_SECONDS = NORMALIZED_DATE.getTime() / 1000;
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_TAR_BYTES = 9 * 1024 * 1024;
const CHART_DIRECTORY = join("deploy", "helm", "gauntlet");
const ROOT_FILES = [".helmignore", "Chart.yaml", "values.schema.json", "values.yaml"];
const TEMPLATE_FILES = [
  "NOTES.txt",
  "_configuration.tpl",
  "_helpers.tpl",
  "configmap.yaml",
  "deployment.yaml",
  "ingress.yaml",
  "networkpolicy.yaml",
  "service.yaml",
];

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function failSource() {
  throw new Error("Chart package source must match the closed regular-file layout");
}

function validateClosedDataObject(value, allowedKeys, label) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)
      || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a closed data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !allowedKeys.has(key)
      || descriptors[key].enumerable !== true
      || !("value" in descriptors[key]))) {
    throw new TypeError(`${label} must be a closed data object`);
  }
}

function optionValue(options, key) {
  return Object.getOwnPropertyDescriptor(options, key)?.value;
}

function validateTestingHooks(value, allowedKeys) {
  if (value === undefined) return Object.freeze({});
  validateClosedDataObject(value, allowedKeys, "Chart package testing hooks");
  for (const key of allowedKeys) {
    const hook = optionValue(value, key);
    if (hook !== undefined && typeof hook !== "function") {
      throw new TypeError("Chart package testing hooks must be callable");
    }
  }
  return value;
}

function validateCanonicalDirectory(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
      || value === "/" || /[,\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
  try {
    const stat = lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(value) !== value) throw new Error();
  } catch {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
}

export function validatePackageDestinationPermissions(entries, effectiveUid, allowedStickyRoots) {
  try {
    if (!Array.isArray(entries) || entries.length < 2 || typeof effectiveUid !== "bigint"
        || !(allowedStickyRoots instanceof Set)) throw new Error();
    for (const [index, entry] of entries.entries()) {
      if (entry === null || typeof entry !== "object" || typeof entry.path !== "string"
          || typeof entry.uid !== "bigint" || typeof entry.mode !== "bigint") throw new Error();
      const writableByOthers = (entry.mode & 0o022n) !== 0n;
      if (index === entries.length - 1) {
        if (entry.uid !== effectiveUid || writableByOthers) throw new Error();
        continue;
      }
      const allowedStickyRoot = allowedStickyRoots.has(entry.path)
        && entry.uid === 0n
        && (entry.mode & 0o1000n) !== 0n;
      if (allowedStickyRoot) continue;
      const trustedOwner = entry.uid === 0n || entry.uid === effectiveUid;
      if (!trustedOwner || writableByOthers) throw new Error();
    }
  } catch {
    throw new Error("Chart package destination is unsafe");
  }
}

function validatePromotionDestination(value) {
  validateCanonicalDirectory(value, "Chart package destination");
  const effectiveUid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : undefined;
  if (effectiveUid === undefined) throw new Error();
  const allowedStickyRoots = new Set();
  for (const candidate of ["/tmp", "/var/tmp"]) {
    try { allowedStickyRoots.add(realpathSync(candidate)); } catch { /* Platform has no such root. */ }
  }
  const snapshot = captureDirectorySnapshot(value, "Chart package destination is unsafe");
  const permissionEntries = snapshot.map((entry) => {
    const stat = lstatSync(entry.path, { bigint: true });
    return Object.freeze({ path: entry.path, uid: stat.uid, mode: stat.mode });
  });
  validatePackageDestinationPermissions(permissionEntries, effectiveUid, allowedStickyRoots);
}

function assertDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) failSource();
  } catch {
    failSource();
  }
}

function captureDirectorySnapshot(path, failure) {
  try {
    const paths = [];
    let cursor = path;
    while (true) {
      paths.push(cursor);
      const parent = resolve(cursor, "..");
      if (parent === cursor) break;
      cursor = parent;
    }
    paths.reverse();
    const entries = paths.map((entryPath) => {
      const stat = lstatSync(entryPath, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      return Object.freeze({ path: entryPath, dev: stat.dev, ino: stat.ino, mode: stat.mode });
    });
    if (realpathSync(path) !== path) throw new Error();
    return Object.freeze(entries);
  } catch {
    throw new Error(failure);
  }
}

function assertDirectorySnapshot(snapshot, failure, includeMode = true) {
  try {
    for (const expected of snapshot) {
      const actual = lstatSync(expected.path, { bigint: true });
      if (!actual.isDirectory() || actual.isSymbolicLink()
          || actual.dev !== expected.dev || actual.ino !== expected.ino
          || (includeMode && actual.mode !== expected.mode)) throw new Error();
    }
    if (realpathSync(snapshot.at(-1).path) !== snapshot.at(-1).path) throw new Error();
  } catch {
    throw new Error(failure);
  }
}

function sameRegularFile(left, right, includeLinks = true) {
  return left.isFile() && right.isFile()
    && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && (!includeLinks || left.nlink === right.nlink);
}

function readExactRegularFile(descriptor, size) {
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < contents.length) {
    const count = readSync(descriptor, contents, offset, contents.length - offset, offset);
    if (count === 0) throw new Error();
    offset += count;
  }
  const overflow = Buffer.alloc(1);
  if (readSync(descriptor, overflow, 0, 1, size) !== 0) throw new Error();
  return contents;
}

function safeReadRegularFile(path, maximumBytes, failure, options = {}) {
  const relativePath = options.relativePath ?? "";
  const hooks = options.hooks ?? Object.freeze({});
  const directorySnapshot = options.directorySnapshot
    ?? captureDirectorySnapshot(resolve(path, ".."), failure);
  let descriptor;
  try {
    assertDirectorySnapshot(directorySnapshot, failure);
    const pathStat = lstatSync(path, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink()
        || pathStat.size > BigInt(maximumBytes)) {
      throw new Error();
    }
    assertDirectorySnapshot(directorySnapshot, failure);
    const pathBeforeOpen = lstatSync(path, { bigint: true });
    if (!sameRegularFile(pathStat, pathBeforeOpen)) throw new Error();
    optionValue(hooks, "beforeSourceOpen")?.({ relativePath });
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    optionValue(hooks, "sourceDescriptorOpened")?.({ descriptor, relativePath });
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    if (!sameRegularFile(pathStat, descriptorBefore)) throw new Error();
    assertDirectorySnapshot(directorySnapshot, failure);
    const size = Number(pathStat.size);
    const first = readExactRegularFile(descriptor, size);
    optionValue(hooks, "betweenSourceReads")?.({ relativePath });
    const second = readExactRegularFile(descriptor, size);
    const firstHash = createHash("sha256").update(first).digest();
    const secondHash = createHash("sha256").update(second).digest();
    if (!firstHash.equals(secondHash) || !first.equals(second)) throw new Error();
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (!sameRegularFile(pathStat, descriptorAfter)
        || !sameRegularFile(pathStat, pathAfter)) throw new Error();
    assertDirectorySnapshot(directorySnapshot, failure);
    return first;
  } catch {
    throw new Error(failure);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exactDirectoryEntries(path, expected) {
  let entries;
  try {
    assertDirectory(path);
    entries = readdirSync(path).sort(binaryCompare);
  } catch {
    failSource();
  }
  if (entries.length !== expected.length
      || entries.some((entry, index) => entry !== expected[index])) failSource();
}

function sourceLayout(sourceRepositoryRoot, hooks) {
  try {
    validateCanonicalDirectory(sourceRepositoryRoot, "Chart package source root");
  } catch {
    failSource();
  }
  const deploy = join(sourceRepositoryRoot, "deploy");
  const helm = join(deploy, "helm");
  const chart = join(helm, "gauntlet");
  const templates = join(chart, "templates");
  for (const directory of [deploy, helm, chart, templates]) assertDirectory(directory);

  let rootEntries;
  try {
    rootEntries = readdirSync(chart).sort(binaryCompare);
  } catch {
    failSource();
  }
  const includesLicense = rootEntries.includes("LICENSE");
  const expectedRootEntries = [
    ...ROOT_FILES,
    ...(includesLicense ? ["LICENSE"] : []),
    "templates",
  ].sort(binaryCompare);
  if (rootEntries.length !== expectedRootEntries.length
      || rootEntries.some((entry, index) => entry !== expectedRootEntries[index])) failSource();
  exactDirectoryEntries(templates, [...TEMPLATE_FILES].sort(binaryCompare));
  const chartSnapshot = captureDirectorySnapshot(
    chart,
    "Chart package source must match the closed regular-file layout",
  );
  const templatesSnapshot = captureDirectorySnapshot(
    templates,
    "Chart package source must match the closed regular-file layout",
  );

  const files = [
    ...ROOT_FILES,
    ...(includesLicense ? ["LICENSE"] : []),
    ...TEMPLATE_FILES.map((name) => join("templates", name)),
  ].sort(binaryCompare);
  const contents = new Map();
  let totalBytes = 0;
  for (const relativePath of files) {
    const data = safeReadRegularFile(
      join(chart, relativePath),
      MAX_SOURCE_FILE_BYTES,
      "Chart package source must match the closed regular-file layout",
      {
        directorySnapshot: relativePath.startsWith("templates/")
          ? templatesSnapshot
          : chartSnapshot,
        hooks,
        relativePath,
      },
    );
    totalBytes += data.length;
    if (totalBytes > MAX_SOURCE_BYTES) failSource();
    contents.set(relativePath, data);
  }
  assertDirectorySnapshot(chartSnapshot, "Chart package source must match the closed regular-file layout");
  assertDirectorySnapshot(templatesSnapshot, "Chart package source must match the closed regular-file layout");
  exactDirectoryEntries(chart, expectedRootEntries);
  exactDirectoryEntries(templates, [...TEMPLATE_FILES].sort(binaryCompare));
  return { contents, files };
}

function chartVersion(chartYaml) {
  const matches = chartYaml.toString("utf8").match(/^version: (0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/gm);
  if (matches === null || matches.length !== 1) failSource();
  return matches[0].slice("version: ".length);
}

function normalizeReadOnlyTree(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) normalizeReadOnlyTree(join(path, entry));
    chmodSync(path, 0o555);
  } else {
    chmodSync(path, 0o444);
  }
  utimesSync(path, NORMALIZED_DATE, NORMALIZED_DATE);
}

function unlockTree(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) unlockTree(join(path, entry));
  } else {
    chmodSync(path, 0o600);
  }
}

function openOwnedDirectories(paths, failure) {
  const descriptors = [];
  try {
    for (const path of paths) {
      let descriptor;
      try {
        descriptor = openSync(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const pathStat = lstatSync(path, { bigint: true });
        const descriptorStat = fstatSync(descriptor, { bigint: true });
        if (!pathStat.isDirectory() || !descriptorStat.isDirectory()
            || pathStat.isSymbolicLink() || pathStat.dev !== descriptorStat.dev
            || pathStat.ino !== descriptorStat.ino) throw new Error();
        descriptors.push(Object.freeze({ descriptor, path, dev: pathStat.dev, ino: pathStat.ino }));
        descriptor = undefined;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    return descriptors;
  } catch {
    for (const entry of descriptors) {
      try { closeSync(entry.descriptor); } catch { /* Preserve the bounded open failure. */ }
    }
    throw new Error(failure);
  }
}

function assertOwnedDirectories(entries, failure) {
  try {
    for (const entry of entries) {
      const stat = fstatSync(entry.descriptor, { bigint: true });
      if (!stat.isDirectory() || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error();
    }
  } catch {
    throw new Error(failure);
  }
}

export function createChartPackageProjection(options = {}) {
  validateClosedDataObject(
    options,
    new Set(["sourceRepositoryRoot", "testingHooks"]),
    "Chart package projection options",
  );
  const configuredRoot = optionValue(options, "sourceRepositoryRoot");
  const hooks = validateTestingHooks(
    optionValue(options, "testingHooks"),
    new Set([
      "beforeProjectionDispose",
      "beforeProjectionRemove",
      "beforeProjectionUnlock",
      "beforeSourceOpen",
      "betweenSourceReads",
      "sourceDescriptorOpened",
    ]),
  );
  const sourceRepositoryRoot = configuredRoot === undefined ? repositoryRoot : configuredRoot;
  const { contents, files } = sourceLayout(sourceRepositoryRoot, hooks);
  const version = chartVersion(contents.get("Chart.yaml"));
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-helm-package-source-")));
  const projectedRepositoryRoot = join(workspaceRoot, "repository");
  const projectedChart = join(projectedRepositoryRoot, CHART_DIRECTORY);

  try {
    mkdirSync(join(projectedChart, "templates"), { recursive: true, mode: 0o700 });
    for (const relativePath of files) {
      writeFileSync(join(projectedChart, relativePath), contents.get(relativePath), {
        flag: "wx",
        mode: 0o600,
      });
    }
    normalizeReadOnlyTree(projectedRepositoryRoot);
    const cleanupSnapshot = captureDirectorySnapshot(
      projectedRepositoryRoot,
      "Chart package projection cleanup could not complete",
    );
    const ownedDirectories = openOwnedDirectories([
      projectedRepositoryRoot,
      join(projectedRepositoryRoot, "deploy"),
      join(projectedRepositoryRoot, "deploy", "helm"),
      projectedChart,
      join(projectedChart, "templates"),
    ], "Chart package projection cleanup could not complete");
    let disposed = false;
    return Object.freeze({
      chartDirectory: projectedChart,
      repositoryRoot: projectedRepositoryRoot,
      version,
      dispose() {
        if (disposed) return;
        try {
          optionValue(hooks, "beforeProjectionDispose")?.({
            repositoryRoot: projectedRepositoryRoot,
            workspaceRoot,
          });
          optionValue(hooks, "beforeProjectionUnlock")?.({
            repositoryRoot: projectedRepositoryRoot,
            workspaceRoot,
          });
          assertDirectorySnapshot(
            cleanupSnapshot,
            "Chart package projection cleanup could not complete",
            false,
          );
          assertOwnedDirectories(ownedDirectories, "Chart package projection cleanup could not complete");
          for (const entry of ownedDirectories) fchmodSync(entry.descriptor, 0o700);
          optionValue(hooks, "beforeProjectionRemove")?.({
            repositoryRoot: projectedRepositoryRoot,
            workspaceRoot,
          });
          assertDirectorySnapshot(
            cleanupSnapshot,
            "Chart package projection cleanup could not complete",
            false,
          );
          assertOwnedDirectories(ownedDirectories, "Chart package projection cleanup could not complete");
          rmSync(workspaceRoot, { recursive: true, force: false });
          for (const entry of ownedDirectories) {
            try { closeSync(entry.descriptor); } catch { /* Removal is already complete. */ }
          }
          disposed = true;
        } catch {
          throw new Error("Chart package projection cleanup could not complete");
        }
      },
    });
  } catch (error) {
    try {
      if (lstatSync(projectedRepositoryRoot).isDirectory()) unlockTree(projectedRepositoryRoot);
    } catch {
      // Preserve the staging error while attempting bounded cleanup.
    }
    rmSync(workspaceRoot, { recursive: true, force: true });
    throw error;
  }
}

export function createPrivatePackageOutput(options = {}) {
  validateClosedDataObject(
    options,
    new Set(["testingHooks"]),
    "Private chart package output options",
  );
  const hooks = validateTestingHooks(
    optionValue(options, "testingHooks"),
    new Set(["beforeOutputDispose", "beforeOutputRemove"]),
  );
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-helm-package-output-")));
  const directory = join(workspaceRoot, "output");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o733);
  const snapshot = captureDirectorySnapshot(
    directory,
    "Private chart package output changed during packaging",
  );
  let disposed = false;
  return Object.freeze({
    directory,
    workspaceRoot,
    assertIntegrity() {
      assertDirectorySnapshot(snapshot, "Private chart package output changed during packaging");
    },
    dispose() {
      if (disposed) return;
      try {
        optionValue(hooks, "beforeOutputDispose")?.({ directory, workspaceRoot });
        optionValue(hooks, "beforeOutputRemove")?.({ directory, workspaceRoot });
        assertDirectorySnapshot(snapshot, "Private chart package output changed during packaging");
        rmSync(workspaceRoot, { recursive: true, force: false });
        disposed = true;
      } catch {
        throw new Error("Private chart package output cleanup could not complete");
      }
    },
  });
}

function tarText(block, offset, length) {
  return block.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/s, "");
}

function tarOctal(block, offset, length) {
  const value = tarText(block, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error();
  return Number.parseInt(value, 8);
}

function parseArchive(archive) {
  if (archive.length < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b
      || archive.readUInt32LE(4) !== 0) throw new Error();
  const tar = gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES });
  if (tar.length === 0 || tar.length % 512 !== 0) throw new Error();
  const entries = [];
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      continue;
    }
    if (zeroBlocks !== 0 || tarText(header, 257, 6) !== "ustar"
        || tarText(header, 263, 2) !== "00") throw new Error();
    const storedChecksum = tarOctal(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (checksum !== storedChecksum) throw new Error();
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const size = tarOctal(header, 124, 12);
    const payloadOffset = offset + 512;
    const payloadEnd = payloadOffset + size;
    if (payloadEnd > tar.length) throw new Error();
    entries.push({
      name: prefix.length === 0 ? name : `${prefix}/${name}`,
      mode: tarOctal(header, 100, 8),
      uid: tarOctal(header, 108, 8),
      gid: tarOctal(header, 116, 8),
      mtime: tarOctal(header, 136, 12),
      type: header[156] === 0 ? "0" : String.fromCharCode(header[156]),
      linkname: tarText(header, 157, 100),
      uname: tarText(header, 265, 32),
      gname: tarText(header, 297, 32),
      payload: tar.subarray(payloadOffset, payloadEnd),
    });
    offset = payloadOffset + Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2) throw new Error();
  return entries;
}

function parseChartMetadata(contents) {
  const document = parseDocument(contents.toString("utf8"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length !== 0) throw new Error();
  const metadata = document.toJS({ maxAliasCount: 0 });
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
  return metadata;
}

function canonicalChartPayload(contents) {
  const metadata = parseChartMetadata(contents);
  const version = metadata.version;
  if (typeof version !== "string"
      || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)
      || !isDeepStrictEqual(metadata, {
        apiVersion: "v2",
        name: "gauntlet",
        description: "Private non-production Gauntlet control plane and dashboard",
        type: "application",
        version,
        appVersion: version,
        kubeVersion: ">=1.33.0-0",
        annotations: { "artifacthub.io/license": "Apache-2.0" },
      })) throw new Error();
  return Buffer.from([
    "annotations:",
    "  artifacthub.io/license: Apache-2.0",
    "apiVersion: v2",
    `appVersion: ${version}`,
    "description: Private non-production Gauntlet control plane and dashboard",
    "kubeVersion: '>=1.33.0-0'",
    "name: gauntlet",
    "type: application",
    `version: ${version}`,
    "",
  ].join("\n"));
}

export function validateChartPackageArchive(archive, projection) {
  try {
    if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES
        || projection === null || typeof projection !== "object") throw new Error();
    const expectedPaths = [
      "Chart.yaml",
      "values.yaml",
      "values.schema.json",
      ...TEMPLATE_FILES.map((name) => `templates/${name}`),
      ...(readdirSync(projection.chartDirectory).includes("LICENSE") ? ["LICENSE"] : []),
    ];
    const entries = parseArchive(archive);
    if (entries.length !== expectedPaths.length) throw new Error();
    for (let index = 0; index < expectedPaths.length; index += 1) {
      const relativePath = expectedPaths[index];
      const expectedName = `gauntlet/${relativePath}`;
      const entry = entries[index];
      if (entry.name !== expectedName || entry.mode !== 0o644 || entry.uid !== 0 || entry.gid !== 0
          || entry.mtime !== NORMALIZED_MTIME_SECONDS || entry.type !== "0"
          || entry.linkname !== "" || entry.uname !== "" || entry.gname !== "") throw new Error();
      const expectedPayload = readFileSync(join(projection.chartDirectory, relativePath));
      if (relativePath === "Chart.yaml") {
        if (!entry.payload.equals(canonicalChartPayload(expectedPayload))) throw new Error();
      } else if (entry.payload.length !== expectedPayload.length
          || !entry.payload.equals(expectedPayload)) throw new Error();
    }
  } catch {
    throw new Error("Pinned Helm produced an invalid chart package");
  }
}

function destinationArchivePath(destinationDirectory, version) {
  return join(destinationDirectory, `gauntlet-${version}.tgz`);
}

function assertDestinationAvailable(path, directorySnapshot) {
  assertDirectorySnapshot(directorySnapshot, "Chart package destination changed during packaging");
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      assertDirectorySnapshot(directorySnapshot, "Chart package destination changed during packaging");
      return;
    }
    throw new Error("Chart package destination could not be inspected");
  }
  throw new Error("Chart package destination already exists");
}

function sameOwnedInode(left, right) {
  return left.isFile() && right.isFile()
    && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino;
}

function assertOwnedPath(path, descriptorStat, directorySnapshot) {
  assertDirectorySnapshot(directorySnapshot, "Chart package destination changed during packaging");
  let pathStat;
  try {
    pathStat = lstatSync(path, { bigint: true });
  } catch {
    throw new Error("Chart package destination changed during packaging");
  }
  if (!sameOwnedInode(descriptorStat, pathStat)) {
    throw new Error("Chart package destination changed during packaging");
  }
  return pathStat;
}

function promoteNoClobber(archive, destinationPath, directorySnapshot, hooks) {
  const destinationDirectory = dirname(destinationPath);
  let descriptor;
  let directoryDescriptor;
  let failure;
  try {
    assertDirectorySnapshot(directorySnapshot, "Chart package destination changed during packaging");
    directoryDescriptor = openSync(
      destinationDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const directoryStat = fstatSync(directoryDescriptor, { bigint: true });
    const expectedDirectory = directorySnapshot.at(-1);
    if (!directoryStat.isDirectory() || directoryStat.dev !== expectedDirectory.dev
        || directoryStat.ino !== expectedDirectory.ino) {
      throw new Error("Chart package destination changed during packaging");
    }
    assertDirectorySnapshot(directorySnapshot, "Chart package destination changed during packaging");
    optionValue(hooks, "beforeDestinationOpen")?.({ destinationPath });
    assertDirectorySnapshot(directorySnapshot, "Chart package destination changed during packaging");
    descriptor = openSync(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
        | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    optionValue(hooks, "destinationDescriptorOpened")?.({ descriptor, destinationPath });
    let ownedStat = fstatSync(descriptor, { bigint: true });
    assertOwnedPath(destinationPath, ownedStat, directorySnapshot);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, archive);
    fsyncSync(descriptor);
    ownedStat = fstatSync(descriptor, { bigint: true });
    if (!ownedStat.isFile() || ownedStat.size !== BigInt(archive.length)
        || (ownedStat.mode & 0o777n) !== 0o600n
        || !createHash("sha256").update(readExactRegularFile(descriptor, archive.length)).digest()
          .equals(createHash("sha256").update(archive).digest())) {
      throw new Error("Chart package destination changed during packaging");
    }
    optionValue(hooks, "afterDestinationWrite")?.({ descriptor, destinationPath });
    const finalDescriptorStat = fstatSync(descriptor, { bigint: true });
    const finalPathStat = assertOwnedPath(destinationPath, finalDescriptorStat, directorySnapshot);
    if (!sameRegularFile(finalDescriptorStat, finalPathStat)
        || finalDescriptorStat.nlink !== 1n || finalPathStat.nlink !== 1n
        || finalPathStat.size !== BigInt(archive.length)
        || (finalPathStat.mode & 0o777n) !== 0o600n
        || !createHash("sha256").update(readExactRegularFile(descriptor, archive.length)).digest()
          .equals(createHash("sha256").update(archive).digest())) {
      throw new Error("Chart package destination changed during packaging");
    }
    fsyncSync(directoryDescriptor);
  } catch (error) {
    failure = error?.code === "EEXIST"
      ? new Error("Chart package destination already exists")
      : error?.message === "Chart package destination changed during packaging"
        ? error
        : new Error("Chart package could not be promoted");
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } catch {
      // A validated publication must not become a retry that collides with itself.
    }
    try {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    } catch {
      // A validated publication must not become a retry that collides with itself.
    }
  }
  if (failure !== undefined) throw failure;
}

export function packageChart(options) {
  validateClosedDataObject(
    options,
    new Set(["destinationDirectory", "sourceRepositoryRoot", "testingHooks"]),
    "Chart package options",
  );
  const destinationDirectory = optionValue(options, "destinationDirectory");
  const configuredSourceRoot = optionValue(options, "sourceRepositoryRoot");
  const hooks = validateTestingHooks(
    optionValue(options, "testingHooks"),
    new Set([
      "afterDestinationWrite",
      "beforeDestinationOpen",
      "beforeOutputDispose",
      "beforeOutputRemove",
      "beforeProjectionDispose",
      "beforeProjectionRemove",
      "beforeProjectionUnlock",
      "destinationDescriptorOpened",
    ]),
  );
  try {
    validatePromotionDestination(destinationDirectory);
  } catch {
    throw new TypeError("Chart package destination must be a safe canonical directory");
  }
  const sourceRepositoryRoot = configuredSourceRoot === undefined ? repositoryRoot : configuredSourceRoot;
  let projection;
  let output;
  let receiptFields;
  let primaryError;
  const cleanupPending = [];
  try {
    const destinationSnapshot = captureDirectorySnapshot(
      destinationDirectory,
      "Chart package destination changed during packaging",
    );
    const projectionHooks = Object.fromEntries([
      "beforeProjectionDispose",
      "beforeProjectionRemove",
      "beforeProjectionUnlock",
    ].filter((key) => optionValue(hooks, key) !== undefined)
      .map((key) => [key, optionValue(hooks, key)]));
    projection = createChartPackageProjection({
      sourceRepositoryRoot,
      testingHooks: projectionHooks,
    });
    const destinationPath = destinationArchivePath(destinationDirectory, projection.version);
    assertDestinationAvailable(destinationPath, destinationSnapshot);
    const outputHooks = Object.fromEntries([
      "beforeOutputDispose",
      "beforeOutputRemove",
    ].filter((key) => optionValue(hooks, key) !== undefined)
      .map((key) => [key, optionValue(hooks, key)]));
    output = createPrivatePackageOutput({ testingHooks: outputHooks });
    const helm = createHelmRunner({
      mountedRepositoryRoot: projection.repositoryRoot,
      outputDirectory: output.directory,
    });
    helm(["package", CHART_DIRECTORY, "--destination", "/output"]);
    output.assertIntegrity();
    const packagedName = `gauntlet-${projection.version}.tgz`;
    const outputEntries = readdirSync(output.directory);
    if (outputEntries.length !== 1 || outputEntries[0] !== packagedName) {
      throw new Error("Pinned Helm produced an invalid chart package");
    }
    const archive = safeReadRegularFile(
      join(output.directory, packagedName),
      MAX_ARCHIVE_BYTES,
      "Pinned Helm produced an invalid chart package",
    );
    validateChartPackageArchive(archive, projection);
    assertDirectorySnapshot(destinationSnapshot, "Chart package destination changed during packaging");
    promoteNoClobber(archive, destinationPath, destinationSnapshot, hooks);
    receiptFields = {
      archivePath: destinationPath,
      sha256: createHash("sha256").update(archive).digest("hex"),
      size: archive.length,
      version: projection.version,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (output !== undefined) output.dispose();
    } catch {
      cleanupPending.push("helm-output");
    }
    try {
      if (projection !== undefined) projection.dispose();
    } catch {
      cleanupPending.push("chart-projection");
    }
  }
  if (primaryError !== undefined) throw primaryError;
  return Object.freeze({
    archivePath: receiptFields.archivePath,
    cleanupPending: Object.freeze(cleanupPending),
    sha256: receiptFields.sha256,
    size: receiptFields.size,
    version: receiptFields.version,
  });
}

export function parsePackageArguments(args) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== "--destination"
      || typeof args[1] !== "string") {
    throw new TypeError("Invalid chart package arguments");
  }
  try {
    validatePromotionDestination(args[1]);
  } catch {
    throw new TypeError("Invalid chart package arguments");
  }
  return { destinationDirectory: args[1] };
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const receipt = packageChart(parsePackageArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
