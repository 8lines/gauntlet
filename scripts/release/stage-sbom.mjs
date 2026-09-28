import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import { parseReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";

const FAILURE = "Attested SPDX SBOM staging failed closed";
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_NODES = 1_000_000;

function failClosed() {
  throw new Error(FAILURE);
}

function optionsOf(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) failClosed();
  const expected = ["imageInspection", "outputPath", "platform", "version"];
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) failClosed();
  return Object.freeze(Object.fromEntries(expected.map((key) => [key, descriptors[key].value])));
}

function canonicalOutputParent(outputPath) {
  try {
    if (typeof outputPath !== "string" || !isAbsolute(outputPath) || resolve(outputPath) !== outputPath
        || outputPath === sep || /[\u0000-\u001f\u007f,]/u.test(outputPath)) throw new Error();
    const parent = dirname(outputPath);
    const stat = lstatSync(parent, { bigint: true });
    const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent
        || stat.uid !== uid || (stat.mode & 0o077n) !== 0n) throw new Error();
    try {
      lstatSync(outputPath);
      throw new Error();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } catch {
    failClosed();
  }
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !utilTypes.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function nonemptyText(value, maximum = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function spdxId(value) {
  return typeof value === "string" && /^SPDXRef-[A-Za-z0-9.-]{1,240}$/.test(value);
}

function validateDocument(document, version) {
  if (!plainRecord(document) || document.spdxVersion !== "SPDX-2.3" || document.dataLicense !== "CC0-1.0"
      || document.SPDXID !== "SPDXRef-DOCUMENT" || document.name !== "sbom"
      || typeof document.documentNamespace !== "string" || !/^https?:\/\/[^\s]+$/.test(document.documentNamespace)
      || !plainRecord(document.creationInfo) || typeof document.creationInfo.created !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(document.creationInfo.created)
      || !Array.isArray(document.creationInfo.creators) || document.creationInfo.creators.length === 0
      || document.creationInfo.creators.some((creator) => typeof creator !== "string" || creator === "")
      || !Array.isArray(document.packages) || document.packages.length === 0
      || !Array.isArray(document.files) || document.files.length === 0
      || !Array.isArray(document.relationships) || document.relationships.length === 0) failClosed();
  const identifiers = new Set(["SPDXRef-DOCUMENT"]);
  for (const entry of [...document.packages, ...document.files]) {
    if (!plainRecord(entry) || !spdxId(entry.SPDXID) || identifiers.has(entry.SPDXID)) failClosed();
    identifiers.add(entry.SPDXID);
  }
  for (const packageRecord of document.packages) {
    if (!nonemptyText(packageRecord.name) || !nonemptyText(packageRecord.downloadLocation)
        || typeof packageRecord.filesAnalyzed !== "boolean" || !nonemptyText(packageRecord.licenseConcluded)
        || !nonemptyText(packageRecord.licenseDeclared) || !nonemptyText(packageRecord.copyrightText)) failClosed();
  }
  const applicationPackages = document.packages.filter((entry) => entry.name === "@8lines/gauntlet-server");
  const rootPackages = document.packages.filter((entry) => entry.name === "sbom"
    && entry.SPDXID === "SPDXRef-DocumentRoot-Directory-sbom");
  if (applicationPackages.length !== 1 || applicationPackages[0].versionInfo !== version
      || rootPackages.length !== 1) failClosed();
  for (const file of document.files) {
    if (!nonemptyText(file.fileName) || !Array.isArray(file.checksums) || file.checksums.length === 0
        || !nonemptyText(file.licenseConcluded) || !nonemptyText(file.copyrightText)) failClosed();
    for (const checksum of file.checksums) {
      if (!plainRecord(checksum) || checksum.algorithm !== "SHA256"
          || typeof checksum.checksumValue !== "string" || !/^[0-9a-f]{64}$/.test(checksum.checksumValue)) failClosed();
    }
  }
  const relationships = new Set();
  for (const relationship of document.relationships) {
    if (!plainRecord(relationship) || !identifiers.has(relationship.spdxElementId)
        || !identifiers.has(relationship.relatedSpdxElement)
        || typeof relationship.relationshipType !== "string"
        || !/^[A-Z][A-Z0-9_]{1,63}$/.test(relationship.relationshipType)) failClosed();
    const identity = `${relationship.spdxElementId}\0${relationship.relationshipType}\0${relationship.relatedSpdxElement}`;
    if (relationships.has(identity)) failClosed();
    relationships.add(identity);
  }
  const rootId = rootPackages[0].SPDXID;
  const applicationId = applicationPackages[0].SPDXID;
  if (!relationships.has(`SPDXRef-DOCUMENT\0DESCRIBES\0${rootId}`)
      || !relationships.has(`${rootId}\0CONTAINS\0${applicationId}`)) failClosed();
}

function canonicalValue(value, state) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) failClosed();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype) {
    return value.map((entry) => canonicalValue(entry, state));
  }
  if (!plainRecord(value)) failClosed();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || descriptors[key].get !== undefined
      || descriptors[key].set !== undefined || !("value" in descriptors[key]) || !descriptors[key].enumerable)) failClosed();
  return Object.fromEntries(keys.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((key) => [key, canonicalValue(descriptors[key].value, state)]));
}

function writeExclusive(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) failClosed();
      offset += count;
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!stat.isFile() || pathname.isSymbolicLink() || stat.dev !== pathname.dev || stat.ino !== pathname.ino
        || stat.nlink !== 1n || pathname.nlink !== 1n || stat.size !== BigInt(bytes.length)
        || (stat.mode & 0o777n) !== 0o600n) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function generateSpdxSbom(options) {
  const { imageInspection, outputPath, platform, version: rawVersion } = optionsOf(options);
  let version;
  try { version = parseReleaseVersion(`${rawVersion}\n`); } catch { failClosed(); }
  if (!["linux/amd64", "linux/arm64"].includes(platform) || !plainRecord(imageInspection)
      || !Array.isArray(imageInspection.platforms)) failClosed();
  const matches = imageInspection.platforms.filter((record) => plainRecord(record) && record.platform === platform);
  if (matches.length !== 1) failClosed();
  const imageDigest = matches[0].imageDigest;
  if (typeof imageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) failClosed();
  const document = matches[0].spdxDocument;
  validateDocument(document, version);
  canonicalOutputParent(outputPath);
  const canonical = canonicalValue(document, { nodes: 0 });
  const bytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, "utf8");
  if (bytes.length <= 1 || bytes.length > MAX_DOCUMENT_BYTES) failClosed();
  writeExclusive(outputPath, bytes);
  return Object.freeze({
    kind: "sbom",
    imageDigest,
    name: `${RELEASE_ARTIFACTS.image.name}@${platform}`,
    path: outputPath,
    platform,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    validation: "spdx-2.3-structural-and-release-binding",
    version,
  });
}
