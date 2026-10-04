import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
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
import { basename, isAbsolute, resolve, sep } from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";

import { parseReleaseSetId } from "./plan.mjs";
import { parseReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";
import { dependencyOrder, unitById, unitTag } from "./units.mjs";

const FAILURE = "Release inventory generation failed closed";
const INPUT_FAILURE = "Release inventory input is invalid";
const VERIFY_FAILURE = "Release inventory verification failed closed";
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9@._+:/-]{1,240}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9@._+:-]+$/;
const KINDS = new Set([
  "npm", "composer", "maven", "compose", "helm", "oci", "docker", "skills", "sbom", "provenance", "security",
]);
const MAX_ARTIFACTS = 512;
const MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MANIFEST_KEYS = Object.freeze(["schemaVersion", "releaseSet", "sourceCommit", "units", "artifacts"]);

function inputFailure() {
  throw new Error(INPUT_FAILURE);
}

function failClosed() {
  throw new Error(FAILURE);
}

function ownData(record, expectedKeys) {
  if (record === null || typeof record !== "object" || Array.isArray(record) || utilTypes.isProxy(record)) inputFailure();
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) inputFailure();
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const keys = Object.keys(descriptors);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(descriptors, key))) inputFailure();
  const values = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      inputFailure();
    }
    values[key] = descriptor.value;
  }
  return values;
}

function ownArray(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) inputFailure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isInteger(length) || length < 1 || length > MAX_ARTIFACTS) inputFailure();
  if (Object.keys(descriptors).length !== length + 1) inputFailure();
  const records = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) inputFailure();
    records.push(descriptor.value);
  }
  return records;
}

function stableVersion(value) {
  if (typeof value !== "string") inputFailure();
  try {
    return parseReleaseVersion(`${value}\n`);
  } catch {
    inputFailure();
  }
}

function safePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || value.includes("\\")
      || value.startsWith("/") || value.includes("\0")) inputFailure();
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment))) {
    inputFailure();
  }
  return value;
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function compareArtifacts(left, right) {
  return compareText(left.kind, right.kind) || compareText(left.name, right.name) || compareText(left.path, right.path);
}

function parseArtifacts(value, requireHash, unitIds) {
  const paths = new Set();
  const identities = new Set();
  const records = ownArray(value).map((candidate) => {
    const record = ownData(
      candidate,
      requireHash ? ["unit", "kind", "name", "path", "sha256"] : ["unit", "kind", "name", "path"],
    );
    if (typeof record.unit !== "string" || !unitIds.includes(record.unit)
        || typeof record.kind !== "string" || !KINDS.has(record.kind)
        || typeof record.name !== "string" || !SAFE_NAME.test(record.name)) inputFailure();
    const path = safePath(record.path);
    if (requireHash && (typeof record.sha256 !== "string" || !SHA256.test(record.sha256))) inputFailure();
    const identity = `${record.kind}\0${record.name}`;
    if (paths.has(path) || identities.has(identity)) inputFailure();
    paths.add(path);
    identities.add(identity);
    return Object.freeze({
      unit: record.unit,
      kind: record.kind,
      name: record.name,
      path,
      ...(requireHash ? { sha256: record.sha256 } : {}),
    });
  });
  return records.sort(compareArtifacts);
}

function parseUnits(value) {
  const entries = ownArray(value).map((candidate) => {
    const withTag = candidate !== null && typeof candidate === "object" && !utilTypes.isProxy(candidate)
      && Object.hasOwn(candidate, "tag");
    const record = ownData(candidate, withTag ? ["id", "version", "tag"] : ["id", "version"]);
    let unit;
    try { unit = unitById(record.id); } catch { inputFailure(); }
    const version = stableVersion(record.version);
    const tag = unitTag(unit, version);
    if (withTag && record.tag !== tag) inputFailure();
    return Object.freeze({ id: unit.id, version, tag });
  });
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || JSON.stringify(dependencyOrder(ids)) !== JSON.stringify(ids)) inputFailure();
  return Object.freeze(entries);
}

function parseSetId(value, sourceCommit) {
  try {
    return parseReleaseSetId(value, sourceCommit);
  } catch {
    inputFailure();
  }
}

function deeplyFreezeManifest(manifest) {
  Object.freeze(manifest.units);
  Object.freeze(manifest.artifacts);
  return Object.freeze(manifest);
}

export function createReleaseManifest(options) {
  try {
    const values = ownData(options, ["releaseSet", "sourceCommit", "units", "artifacts"]);
    if (typeof values.sourceCommit !== "string" || !COMMIT.test(values.sourceCommit)) inputFailure();
    const releaseSet = parseSetId(values.releaseSet, values.sourceCommit);
    const units = parseUnits(values.units);
    return deeplyFreezeManifest({
      schemaVersion: 2,
      releaseSet,
      sourceCommit: values.sourceCommit,
      units,
      artifacts: parseArtifacts(values.artifacts, true, units.map(({ id }) => id)),
    });
  } catch (error) {
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    inputFailure();
  }
}

function assertDirectoryChain(root, relativePath) {
  let current = root;
  const segments = relativePath.split("/");
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) failClosed();
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function hashFile(root, relativePath) {
  assertDirectoryChain(root, relativePath);
  const path = resolve(root, ...relativePath.split("/"));
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 0n
        || before.size > BigInt(MAX_FILE_BYTES)) failClosed();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      if (count <= 0) failClosed();
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    if (!sameFile(before, after) || pathStat.isSymbolicLink() || !sameFile(after, pathStat)) failClosed();
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readRegularFile(root, relativePath, maximumBytes) {
  assertDirectoryChain(root, relativePath);
  const path = resolve(root, ...relativePath.split("/"));
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n
        || before.size > BigInt(maximumBytes)) failClosed();
    const bytes = Buffer.alloc(Number(before.size));
    let position = 0;
    while (position < bytes.length) {
      const count = readSync(descriptor, bytes, position, bytes.length - position, position);
      if (count <= 0) failClosed();
      position += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    if (!sameFile(before, after) || pathStat.isSymbolicLink() || !sameFile(after, pathStat)) failClosed();
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const npmArchive = (name, version) => `npm/${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;

export function expectedUnitArtifacts(unitId, rawVersion) {
  const unit = unitById(unitId);
  const version = stableVersion(rawVersion);
  const name = unit.artifacts[0];
  let records;
  if (unit.kind === "npm") {
    records = [{ kind: "npm", name, path: npmArchive(name, version) }];
  } else if (unit.kind === "composer") {
    const { repository } = RELEASE_ARTIFACTS.composer.find((artifact) => artifact.name === name);
    records = [{ kind: "composer", name, path: `composer/artifacts/${repository.split("/").at(-1)}-${version}.tar.gz` }];
  } else if (unit.kind === "maven") {
    records = [{ kind: "maven", name, path: `maven/artifacts/gauntlet-${name.split(":")[1]}-${version}.tar.gz` }];
  } else if (unit.kind === "skills") {
    records = [{ kind: "skills", name: RELEASE_ARTIFACTS.skills.name, path: `skills/gauntlet-skills-${version}.tgz` }];
  } else {
    const image = RELEASE_ARTIFACTS.image.name;
    records = [
      { kind: "compose", name: RELEASE_ARTIFACTS.compose.name, path: `compose/gauntlet-compose-${version}.tar.gz` },
      { kind: "helm", name: RELEASE_ARTIFACTS.chart.name, path: `helm/gauntlet-${version}.tgz` },
      { kind: "docker", name: "gauntlet.local/gauntlet", path: `image/gauntlet-${version}.docker.tar` },
      { kind: "oci", name: image, path: `image/gauntlet-${version}.oci.tar` },
      { kind: "provenance", name: `${image}@buildkit-unsigned`, path: `image/gauntlet-${version}.provenance.json` },
      { kind: "sbom", name: `${image}@linux/amd64`, path: "sbom/gauntlet-linux-amd64.spdx.json" },
      { kind: "sbom", name: `${image}@linux/arm64`, path: "sbom/gauntlet-linux-arm64.spdx.json" },
    ];
  }
  return Object.freeze(records.map((record) => Object.freeze({ unit: unit.id, ...record })).sort(compareArtifacts));
}

export function expectedReleaseArtifacts(units) {
  return Object.freeze(units.flatMap(({ id, version }) => expectedUnitArtifacts(id, version)).sort(compareArtifacts));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidenceArtifact(manifest, kind, name) {
  const value = manifest.artifacts.find((artifact) => artifact.kind === kind && artifact.name === name);
  if (value === undefined) failClosed();
  return Object.freeze({ path: value.path, sha256: value.sha256 });
}

function assertClosedInventoryTree(root, artifactPaths) {
  const expectedFiles = new Set(["release-manifest.json", "SHA256SUMS", ...artifactPaths]);
  const expectedDirectories = new Set([""]);
  for (const path of expectedFiles) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  const seenFiles = new Set();
  const visit = (relativeDirectory) => {
    const directory = relativeDirectory === "" ? root : resolve(root, ...relativeDirectory.split("/"));
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!SAFE_SEGMENT.test(entry.name) || entry.name === "." || entry.name === "..") failClosed();
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink()) failClosed();
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) failClosed();
        visit(relativePath);
      } else if (stat.isFile()) {
        if (!expectedFiles.has(relativePath) || stat.nlink !== 1n) failClosed();
        seenFiles.add(relativePath);
      } else {
        failClosed();
      }
    }
  };
  visit("");
  if (seenFiles.size !== expectedFiles.size || [...expectedFiles].some((path) => !seenFiles.has(path))) failClosed();
}

function canonicalInventoryRoot(outputDirectory) {
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory)
      || resolve(outputDirectory) !== outputDirectory || outputDirectory === sep || outputDirectory.includes("\0")) {
    inputFailure();
  }
  const supplied = lstatSync(outputDirectory, { bigint: true });
  const root = realpathSync(outputDirectory);
  const rootStat = lstatSync(root, { bigint: true });
  if (!supplied.isDirectory() || supplied.isSymbolicLink() || !rootStat.isDirectory() || rootStat.isSymbolicLink()
      || root !== outputDirectory) failClosed();
  return root;
}

function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function parseManifestBytes(bytes) {
  const values = ownData(JSON.parse(UTF8.decode(bytes)), MANIFEST_KEYS);
  if (values.schemaVersion !== 2) failClosed();
  const manifest = createReleaseManifest({
    releaseSet: values.releaseSet,
    sourceCommit: values.sourceCommit,
    units: values.units,
    artifacts: values.artifacts,
  });
  if (!bytes.equals(canonicalManifestBytes(manifest))) failClosed();
  return manifest;
}

// Reads a finalized release directory's manifest. Only the canonical bytes are checked: a finalized
// directory legitimately holds publication files beyond the closed staged tree.
export function readReleaseManifest(outputDirectory) {
  try {
    const root = canonicalInventoryRoot(outputDirectory);
    const bytes = readRegularFile(root, "release-manifest.json", MAX_INVENTORY_BYTES);
    return Object.freeze({ manifest: parseManifestBytes(bytes), bytes });
  } catch {
    throw new Error(VERIFY_FAILURE);
  }
}

export function verifyStagedReleaseInventory(outputDirectory) {
  try {
    const root = canonicalInventoryRoot(outputDirectory);
    const manifestBytes = readRegularFile(root, "release-manifest.json", MAX_INVENTORY_BYTES);
    const values = ownData(JSON.parse(UTF8.decode(manifestBytes)), MANIFEST_KEYS);
    if (values.schemaVersion !== 2 || typeof values.releaseSet !== "string" || basename(root) !== values.releaseSet
        || typeof values.sourceCommit !== "string" || !COMMIT.test(values.sourceCommit)) failClosed();
    return verifyReleaseInventory({ outputDirectory: root, releaseSet: values.releaseSet, sourceCommit: values.sourceCommit });
  } catch {
    throw new Error(VERIFY_FAILURE);
  }
}

export function verifyReleaseInventory(options) {
  try {
    const values = ownData(options, ["outputDirectory", "releaseSet", "sourceCommit"]);
    if (typeof values.sourceCommit !== "string" || !COMMIT.test(values.sourceCommit)) inputFailure();
    const releaseSet = parseSetId(values.releaseSet, values.sourceCommit);
    const root = canonicalInventoryRoot(values.outputDirectory);
    const rootBefore = lstatSync(root, { bigint: true });

    const manifestBytes = readRegularFile(root, "release-manifest.json", MAX_INVENTORY_BYTES);
    const manifest = parseManifestBytes(manifestBytes);
    if (manifest.releaseSet !== releaseSet || manifest.sourceCommit !== values.sourceCommit) failClosed();
    const expected = expectedReleaseArtifacts(manifest.units);
    const actual = manifest.artifacts.map(({ unit, kind, name, path }) => ({ unit, kind, name, path }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failClosed();

    const checksumsBytes = readRegularFile(root, "SHA256SUMS", MAX_INVENTORY_BYTES);
    const expectedChecksums = Buffer.from(
      [...manifest.artifacts]
        .sort((left, right) => compareText(left.path, right.path))
        .map(({ path, sha256 }) => `${sha256}  ${path}\n`)
        .join(""),
      "utf8",
    );
    if (!checksumsBytes.equals(expectedChecksums)) failClosed();
    for (const artifact of manifest.artifacts) {
      if (hashFile(root, artifact.path) !== artifact.sha256) failClosed();
    }
    assertClosedInventoryTree(root, manifest.artifacts.map(({ path }) => path));
    if (!readRegularFile(root, "release-manifest.json", MAX_INVENTORY_BYTES).equals(manifestBytes)
        || !readRegularFile(root, "SHA256SUMS", MAX_INVENTORY_BYTES).equals(checksumsBytes)) failClosed();
    const rootAfter = lstatSync(root, { bigint: true });
    if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || rootBefore.dev !== rootAfter.dev
        || rootBefore.ino !== rootAfter.ino || rootBefore.uid !== rootAfter.uid || rootBefore.mode !== rootAfter.mode) failClosed();

    const hasApplication = manifest.units.some(({ id }) => id === "gauntlet");
    let nativeImage = null;
    let multiPlatformOci = null;
    let helmChart = null;
    if (hasApplication) {
      nativeImage = evidenceArtifact(manifest, "docker", "gauntlet.local/gauntlet");
      helmChart = evidenceArtifact(manifest, "helm", RELEASE_ARTIFACTS.chart.name);
      multiPlatformOci = Object.freeze({
        ...evidenceArtifact(manifest, "oci", RELEASE_ARTIFACTS.image.name),
        platforms: Object.freeze(["linux/amd64", "linux/arm64"]),
        verification: "deeply-validated-during-staging",
      });
    }
    return Object.freeze({
      schemaVersion: 2,
      ok: true,
      releaseSet,
      sourceCommit: values.sourceCommit,
      units: manifest.units,
      artifacts: manifest.artifacts.length,
      manifestSha256: sha256Bytes(manifestBytes),
      checksumsSha256: sha256Bytes(checksumsBytes),
      nativeImage,
      multiPlatformOci,
      helmChart,
    });
  } catch {
    throw new Error(VERIFY_FAILURE);
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) failClosed();
    offset += count;
  }
}

function ownedUnlink(path, identity) {
  try {
    const current = lstatSync(path, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
  } catch {
    // Cleanup is best effort and never follows or removes a replacement.
  }
}

function prepareFile(root, basename, bytes) {
  const scratch = resolve(root, `.gauntlet-inventory-${randomBytes(16).toString("hex")}`);
  let descriptor;
  let identity;
  try {
    descriptor = openSync(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_CLOEXEC, 0o600);
    identity = fstatSync(descriptor, { bigint: true });
    writeAll(descriptor, bytes);
    fchmodSync(descriptor, 0o644);
    fsyncSync(descriptor);
    const finalIdentity = fstatSync(descriptor, { bigint: true });
    if (finalIdentity.dev !== identity.dev || finalIdentity.ino !== identity.ino || finalIdentity.size !== BigInt(bytes.length)) failClosed();
    linkSync(scratch, resolve(root, basename));
    const linked = lstatSync(resolve(root, basename), { bigint: true });
    if (linked.dev !== finalIdentity.dev || linked.ino !== finalIdentity.ino) failClosed();
    ownedUnlink(scratch, finalIdentity);
    try {
      lstatSync(scratch);
      failClosed();
    } catch (error) {
      if (error instanceof Error && error.message === FAILURE) throw error;
      if (error?.code !== "ENOENT") failClosed();
    }
    return Object.freeze({ path: resolve(root, basename), identity: linked });
  } catch (error) {
    if (identity !== undefined) ownedUnlink(scratch, identity);
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function writeReleaseInventory(options) {
  let preparedManifest;
  try {
    const values = ownData(options, ["outputDirectory", "releaseSet", "sourceCommit", "units", "artifacts"]);
    if (typeof values.outputDirectory !== "string" || !isAbsolute(values.outputDirectory)
        || resolve(values.outputDirectory) !== values.outputDirectory || values.outputDirectory.includes("\0")) inputFailure();
    const suppliedRootStat = lstatSync(values.outputDirectory, { bigint: true });
    if (!suppliedRootStat.isDirectory() || suppliedRootStat.isSymbolicLink()) failClosed();
    const root = realpathSync(values.outputDirectory);
    const rootStat = lstatSync(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o022n) !== 0n) failClosed();
    for (const basename of ["release-manifest.json", "SHA256SUMS"]) {
      try {
        lstatSync(resolve(root, basename));
        failClosed();
      } catch (error) {
        if (error instanceof Error && error.message === FAILURE) throw error;
        if (error?.code !== "ENOENT") failClosed();
      }
    }
    const units = parseUnits(values.units);
    const descriptors = parseArtifacts(values.artifacts, false, units.map(({ id }) => id));
    const hashed = descriptors.map((record) => ({ ...record, sha256: hashFile(root, record.path) }));
    const manifest = createReleaseManifest({
      releaseSet: values.releaseSet,
      sourceCommit: values.sourceCommit,
      units: values.units,
      artifacts: hashed,
    });
    const manifestBytes = canonicalManifestBytes(manifest);
    const checksumBytes = Buffer.from(
      [...manifest.artifacts]
        .sort((left, right) => compareText(left.path, right.path))
        .map(({ path, sha256 }) => `${sha256}  ${path}\n`)
        .join(""),
      "utf8",
    );
    preparedManifest = prepareFile(root, "release-manifest.json", manifestBytes);
    prepareFile(root, "SHA256SUMS", checksumBytes);
    return manifest;
  } catch (error) {
    if (preparedManifest !== undefined) ownedUnlink(preparedManifest.path, preparedManifest.identity);
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}
