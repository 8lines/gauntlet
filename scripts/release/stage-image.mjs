import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify, types as utilTypes } from "node:util";
import { gunzipSync } from "node:zlib";

import { parseReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";

const execFileAsync = promisify(execFile);
const FAILURE = "Image staging failed closed";
const BLOCKER = "Multi-platform OCI staging is blocked";
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_LAYER_BYTES = 512 * 1024 * 1024;
const MAX_TAR_ENTRIES = 200_000;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REQUIRED_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);
// Older BuildKit writes in-toto Statement v0.1 and current BuildKit writes v1; both carry the same subject and predicate.
const IN_TOTO_STATEMENT_TYPES = Object.freeze(["https://in-toto.io/Statement/v0.1", "https://in-toto.io/Statement/v1"]);
const SOURCE_URL = "https://github.com/8lines/gauntlet";
const LOCAL_IMAGE_NAME = "gauntlet.local/gauntlet";
const BUILD_TYPE = "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md";
const DOCKERFILE_FRONTEND_DIGEST = "a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e";
const SBOM_GENERATOR_DIGEST = "ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9";
const NODE_IMAGE_DIGEST = "e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf";
const OCI_LABELS = Object.freeze({
  "org.opencontainers.image.licenses": "Apache-2.0",
  "org.opencontainers.image.source": SOURCE_URL,
});

function failClosed(message = FAILURE) {
  throw new Error(message);
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

function validateAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === sep
      || value.includes(",") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be an absolute safe path`);
  }
  return value;
}

function validateCanonicalDirectory(path, label, privateDirectory = false) {
  validateAbsolutePath(path, label);
  try {
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

function hostPlatform() {
  if (process.arch === "x64") return "linux/amd64";
  if (process.arch === "arm64") return "linux/arm64";
  failClosed(`Local Docker archive staging is unsupported on architecture ${process.arch}`);
}

function stableVersion(value) {
  try {
    return parseReleaseVersion(`${value}\n`);
  } catch {
    throw new TypeError("Image staging version must be an exact stable semantic version");
  }
}

function safeCommit(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new TypeError("Image staging source commit must be a lowercase full SHA-1");
  }
  return value;
}

function freezeStep(phase, args) {
  return Object.freeze({ command: "docker", args: Object.freeze(args), phase });
}

export function createImageExportPlan(options) {
  const values = exactDataObject(
    options,
    ["hostPlatform", "outputDirectory", "root", "sourceCommit", "version"],
    "Image export plan options",
  );
  const root = validateAbsolutePath(values.root, "Image export root");
  const outputDirectory = validateAbsolutePath(values.outputDirectory, "Image export output");
  const sourceCommit = safeCommit(values.sourceCommit);
  const version = stableVersion(values.version);
  if (!REQUIRED_PLATFORMS.includes(values.hostPlatform)) {
    throw new TypeError("Image export host platform must be linux/amd64 or linux/arm64");
  }
  const bakeFile = join(root, "docker-bake.hcl");
  const dockerArchive = join(outputDirectory, `gauntlet-${version}.docker.tar`);
  const ociArchive = join(outputDirectory, `gauntlet-${version}.oci.tar`);
  return Object.freeze([
    freezeStep("builder", ["buildx", "inspect", "--bootstrap"]),
    freezeStep("docker-archive", [
      "buildx", "bake", `--allow=fs.write=${outputDirectory}`, "--file", bakeFile, "--progress=plain",
      "--set", `release-local.platform=${values.hostPlatform}`,
      "--set", `release-local.tags=${LOCAL_IMAGE_NAME}:${version}`,
      "--set", `release-local.args.GAUNTLET_VERSION=${version}`,
      "--set", `release-local.args.GAUNTLET_REVISION=${sourceCommit}`,
      "--set", `release-local.output=type=docker,dest=${dockerArchive},oci-mediatypes=false`,
      "release-local",
    ]),
    freezeStep("oci-archive", [
      "buildx", "bake", `--allow=fs.write=${outputDirectory}`, "--file", bakeFile, "--progress=plain",
      "--set", `release.tags=${RELEASE_ARTIFACTS.image.name}:${version}`,
      "--set", `release.args.GAUNTLET_VERSION=${version}`,
      "--set", `release.args.GAUNTLET_REVISION=${sourceCommit}`,
      "--set", `release.output=type=oci,dest=${ociArchive},oci-artifact=false`,
      "release",
    ]),
  ]);
}

export function parseBuildxPlatforms(output, options = {}) {
  if (typeof output !== "string" || output.length === 0 || output.length > MAX_COMMAND_OUTPUT_BYTES
      || output.includes("\0")) failClosed(`${BLOCKER}: Docker Buildx returned invalid builder metadata`);
  const requireReleasePlatforms = options.requireReleasePlatforms === true;
  if (Object.keys(options).some((key) => key !== "requireReleasePlatforms")) {
    throw new TypeError("Buildx platform parser options are invalid");
  }
  const platforms = [];
  for (const match of output.matchAll(/^Platforms:\s*(.+)$/gmu)) {
    for (const raw of match[1].split(",")) {
      const platform = raw.trim().replace(/\*$/, "");
      if (/^linux\/[a-z0-9_]+(?:\/[a-z0-9_.-]+)?$/.test(platform) && !platforms.includes(platform)) {
        platforms.push(platform);
      }
    }
  }
  if (platforms.length === 0) failClosed(`${BLOCKER}: Docker Buildx reported no usable Linux platforms`);
  if (requireReleasePlatforms) {
    const missing = REQUIRED_PLATFORMS.filter((platform) => !platforms.includes(platform));
    if (missing.length > 0) failClosed(`${BLOCKER}: Docker Buildx builder lacks ${missing.join(", ")}`);
  }
  return Object.freeze(platforms);
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === 1n && right.nlink === 1n
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function archiveRecord(path) {
  let descriptor;
  try {
    if (realpathSync(path) !== path) failClosed();
    chmodSync(path, 0o600);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!sameFile(before, pathname) || before.size <= 0n || before.size > BigInt(MAX_ARCHIVE_BYTES)
        || (before.mode & 0o777n) !== 0o600n) failClosed();
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
    const pathnameAfter = lstatSync(path, { bigint: true });
    if (!sameFile(before, after) || !sameFile(after, pathnameAfter)) failClosed();
    return Object.freeze({ path, sha256: hash.digest("hex"), size: Number(before.size) });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function tarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero === -1 ? field.length : zero).toString("utf8");
}

function tarNumber(header, offset, length) {
  const source = tarText(header, offset, length).trim().replace(/\0+$/u, "");
  if (!/^[0-7]+$/.test(source)) failClosed();
  const result = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(result) || result < 0) failClosed();
  return result;
}

function tarName(header) {
  const name = tarText(header, 0, 100);
  const prefix = tarText(header, 345, 155);
  const result = prefix === "" ? name : `${prefix}/${name}`;
  const path = result.endsWith("/") ? result.slice(0, -1) : result;
  if (path === "" || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((part) => part === "" || part === "." || part === "..")
      || /[\u0000-\u001f\u007f]/u.test(result)) failClosed();
  return path;
}

function tarChecksum(header) {
  const source = tarText(header, 148, 8).trim();
  if (!/^[0-7]+$/.test(source)) failClosed();
  const expected = Number.parseInt(source, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = [...copy].reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) failClosed();
}

function readExact(descriptor, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, bytes, offset, length - offset, position + offset);
    if (count <= 0) failClosed();
    offset += count;
  }
  return bytes;
}

function readTarMembers(archivePath, wanted, maximumMemberBytes = MAX_METADATA_BYTES, observedEntries) {
  if (!(wanted instanceof Set) || wanted.size === 0 || [...wanted].some((path) => typeof path !== "string")) failClosed();
  if (!Number.isSafeInteger(maximumMemberBytes) || maximumMemberBytes <= 0 || maximumMemberBytes > MAX_LAYER_BYTES) failClosed();
  if (observedEntries !== undefined && (!(observedEntries instanceof Map) || observedEntries.size !== 0)) failClosed();
  let descriptor;
  try {
    const archive = archiveRecord(archivePath);
    descriptor = openSync(archive.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const result = new Map();
    const seen = new Set();
    let position = 0;
    let entries = 0;
    let zeroBlocks = 0;
    while (position + 512 <= archive.size) {
      const header = readExact(descriptor, 512, position);
      position += 512;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) break;
        continue;
      }
      if (zeroBlocks !== 0 || ++entries > MAX_TAR_ENTRIES) failClosed();
      tarChecksum(header);
      const name = tarName(header);
      if (seen.has(name)) failClosed();
      seen.add(name);
      const size = tarNumber(header, 124, 12);
      const type = String.fromCharCode(header[156] || 0x30);
      if (type !== "0" && type !== "5") failClosed();
      if (type === "5" && size !== 0) failClosed();
      if (observedEntries !== undefined) observedEntries.set(name, type);
      if (wanted.has(name)) {
        if (type !== "0" || size > maximumMemberBytes) failClosed();
        result.set(name, readExact(descriptor, size, position));
      }
      position += Math.ceil(size / 512) * 512;
      if (position > archive.size) failClosed();
    }
    if (zeroBlocks !== 2 || archive.size % 512 !== 0) failClosed();
    while (position < archive.size) {
      const length = Math.min(1024 * 1024, archive.size - position);
      if (!readExact(descriptor, length, position).every((byte) => byte === 0)) failClosed();
      position += length;
    }
    if (result.size !== wanted.size || [...wanted].some((name) => !result.has(name))) failClosed();
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.includes(0)) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    failClosed();
  }
}

function digestPath(digest) {
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) failClosed();
  return `blobs/sha256/${digest.slice(7)}`;
}

function validateDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)
      || typeof descriptor.mediaType !== "string" || typeof descriptor.size !== "number"
      || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) failClosed();
  digestPath(descriptor.digest);
  return descriptor;
}

function verifiedDescriptorBytes(descriptor, bytes) {
  validateDescriptor(descriptor);
  if (!Buffer.isBuffer(bytes) || bytes.length !== descriptor.size
      || createHash("sha256").update(bytes).digest("hex") !== descriptor.digest.slice(7)) failClosed();
  return bytes;
}

function uncompressedLayerDigest(bytes) {
  try {
    const uncompressed = gunzipSync(bytes, { maxOutputLength: MAX_LAYER_BYTES });
    if (uncompressed.length === 0) failClosed();
    return `sha256:${createHash("sha256").update(uncompressed).digest("hex")}`;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function terminalDescriptors(archivePath, descriptors, referencedMembers) {
  let current = descriptors;
  for (let depth = 0; depth < 4; depth += 1) {
    for (const descriptor of current) referencedMembers.add(digestPath(descriptor.digest));
    const indexes = current.filter(({ mediaType }) => mediaType === "application/vnd.oci.image.index.v1+json");
    if (indexes.length === 0) return current;
    const members = readTarMembers(archivePath, new Set(indexes.map(({ digest }) => digestPath(digest))));
    const expanded = [];
    for (const descriptor of current) {
      if (descriptor.mediaType !== "application/vnd.oci.image.index.v1+json") {
        expanded.push(descriptor);
        continue;
      }
      const index = parseJson(verifiedDescriptorBytes(descriptor, members.get(digestPath(descriptor.digest))));
      if (index.schemaVersion !== 2 || index.mediaType !== "application/vnd.oci.image.index.v1+json"
          || !Array.isArray(index.manifests) || index.manifests.length === 0) failClosed();
      expanded.push(...index.manifests.map(validateDescriptor));
    }
    if (expanded.length > 32 || new Set(expanded.map(({ digest }) => digest)).size !== expanded.length) failClosed();
    current = expanded;
  }
  failClosed();
}

function platformOf(descriptor) {
  const platform = descriptor.platform;
  if (platform === null || typeof platform !== "object" || platform.os !== "linux"
      || !["amd64", "arm64"].includes(platform.architecture)) return undefined;
  return `${platform.os}/${platform.architecture}`;
}

function validateLabels(config, version, sourceCommit) {
  const labels = config?.config?.Labels;
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)
      || labels["org.opencontainers.image.source"] !== OCI_LABELS["org.opencontainers.image.source"]
      || labels["org.opencontainers.image.licenses"] !== OCI_LABELS["org.opencontainers.image.licenses"]
      || labels["org.opencontainers.image.version"] !== version
      || labels["org.opencontainers.image.revision"] !== sourceCommit) failClosed();
}

function statementSubjectMatches(statement, imageDigest, platform, version) {
  const sha256 = imageDigest.slice(7);
  const subject = Array.isArray(statement.subject) && statement.subject.length === 1
    ? statement.subject[0]
    : undefined;
  return subject !== null && typeof subject === "object" && !Array.isArray(subject)
    && subject.name === `pkg:docker/${RELEASE_ARTIFACTS.image.name}@${version}?platform=${encodeURIComponent(platform)}`
    && subject.digest !== null && typeof subject.digest === "object" && !Array.isArray(subject.digest)
    && Object.keys(subject.digest).length === 1 && subject.digest.sha256 === sha256;
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !utilTypes.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validateProvenancePredicate(predicate, version, sourceCommit) {
  const definition = predicate?.buildDefinition;
  const external = definition?.externalParameters;
  const request = external?.request;
  const args = request?.args;
  const internal = definition?.internalParameters;
  const dependencies = definition?.resolvedDependencies;
  const builder = predicate?.runDetails?.builder;
  const metadata = predicate?.runDetails?.metadata;
  const completeness = metadata?.buildkit_completeness;
  if (!plainRecord(predicate) || !plainRecord(definition) || definition.buildType !== BUILD_TYPE
      || !plainRecord(external) || !plainRecord(external.configSource)
      || external.configSource.path !== "Dockerfile" || !plainRecord(request)
      || request.frontend !== "gateway.v0" || !plainRecord(args) || args.target !== "runtime"
      || args["build-arg:GAUNTLET_VERSION"] !== version
      || args["build-arg:GAUNTLET_REVISION"] !== sourceCommit
      || args.source !== `docker/dockerfile:1.7@sha256:${DOCKERFILE_FRONTEND_DIGEST}`
      || !Array.isArray(request.locals) || request.locals.length !== 2
      || new Set(request.locals.map((entry) => plainRecord(entry) ? entry.name : undefined)).size !== 2
      || !request.locals.some((entry) => entry.name === "context")
      || !request.locals.some((entry) => entry.name === "dockerfile")
      || !plainRecord(internal) || typeof internal.builderPlatform !== "string"
      || !/^linux\/(?:amd64|arm64)$/.test(internal.builderPlatform)
      || !Array.isArray(dependencies) || dependencies.length === 0 || !plainRecord(builder)
      || typeof builder.id !== "string" || !plainRecord(metadata)
      || typeof metadata.invocationId !== "string" || metadata.invocationId === ""
      || metadata.invocationId.length > 2048
      || typeof metadata.startedOn !== "string" || typeof metadata.finishedOn !== "string"
      || !RFC3339_TIMESTAMP.test(metadata.startedOn) || !RFC3339_TIMESTAMP.test(metadata.finishedOn)
      || !Number.isFinite(Date.parse(metadata.startedOn)) || !Number.isFinite(Date.parse(metadata.finishedOn))
      || Date.parse(metadata.startedOn) > Date.parse(metadata.finishedOn)
      || !plainRecord(completeness) || completeness.request !== true
      || typeof completeness.resolvedDependencies !== "boolean") failClosed();
  const dependencyDigests = new Set();
  for (const dependency of dependencies) {
    if (!plainRecord(dependency) || typeof dependency.uri !== "string" || dependency.uri === ""
        || !plainRecord(dependency.digest)
        || Object.keys(dependency.digest).length !== 1
        || typeof dependency.digest.sha256 !== "string"
        || !/^[0-9a-f]{64}$/.test(dependency.digest.sha256)) failClosed();
    dependencyDigests.add(dependency.digest.sha256);
  }
  for (const required of [DOCKERFILE_FRONTEND_DIGEST, SBOM_GENERATOR_DIGEST, NODE_IMAGE_DIGEST]) {
    if (!dependencyDigests.has(required)) failClosed();
  }
  return Object.freeze({
    attestationAuthenticity: "unsigned",
    builderIdentity: builder.id === "" ? "absent" : "self-asserted",
    builderPlatform: internal.builderPlatform,
    classification: "buildkit-unsigned-provenance",
    dependencyCompleteness: completeness.resolvedDependencies ? "complete" : "incomplete",
    predicateType: "https://slsa.dev/provenance/v1",
    sourceBinding: "unverified-local-context",
  });
}

export function inspectOciArchive({ archivePath, sourceCommit, version }) {
  validateAbsolutePath(archivePath, "OCI archive");
  safeCommit(sourceCommit);
  stableVersion(version);
  const archiveEntries = new Map();
  const referencedMembers = new Set(["oci-layout", "index.json"]);
  const rootMembers = readTarMembers(
    archivePath,
    new Set(["oci-layout", "index.json"]),
    MAX_METADATA_BYTES,
    archiveEntries,
  );
  const layout = parseJson(rootMembers.get("oci-layout"));
  const index = parseJson(rootMembers.get("index.json"));
  if (layout.imageLayoutVersion !== "1.0.0" || index.schemaVersion !== 2
      || index.mediaType !== "application/vnd.oci.image.index.v1+json"
      || !Array.isArray(index.manifests) || index.manifests.length === 0) failClosed();
  const top = terminalDescriptors(archivePath, index.manifests.map(validateDescriptor), referencedMembers);
  const topMembers = readTarMembers(archivePath, new Set(top.map(({ digest }) => digestPath(digest))));
  const images = [];
  const attestations = [];
  for (const descriptor of top) {
    const referenceType = descriptor.annotations?.["vnd.docker.reference.type"];
    if (referenceType === "attestation-manifest") attestations.push(descriptor);
    else {
      if (descriptor.mediaType !== "application/vnd.oci.image.manifest.v1+json") failClosed();
      const platform = platformOf(descriptor);
      if (platform === undefined) failClosed();
      images.push({
        descriptor,
        manifest: parseJson(verifiedDescriptorBytes(descriptor, topMembers.get(digestPath(descriptor.digest)))),
        platform,
      });
    }
  }
  if (images.length !== 2 || new Set(images.map(({ platform }) => platform)).size !== 2
      || REQUIRED_PLATFORMS.some((platform) => !images.some((image) => image.platform === platform))) failClosed();
  const configPaths = new Set();
  for (const image of images) {
    if (image.manifest.schemaVersion !== 2
        || image.manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json"
        || !Array.isArray(image.manifest.layers) || image.manifest.layers.length === 0) failClosed();
    validateDescriptor(image.manifest.config);
    if (image.manifest.config.mediaType !== "application/vnd.oci.image.config.v1+json") failClosed();
    configPaths.add(digestPath(image.manifest.config.digest));
    referencedMembers.add(digestPath(image.manifest.config.digest));
  }
  const configs = readTarMembers(archivePath, configPaths);
  for (const image of images) {
    const config = parseJson(verifiedDescriptorBytes(
      image.manifest.config,
      configs.get(digestPath(image.manifest.config.digest)),
    ));
    const [expectedOs, expectedArchitecture] = image.platform.split("/");
    if (config.os !== expectedOs || config.architecture !== expectedArchitecture
        || config.rootfs?.type !== "layers" || !Array.isArray(config.rootfs.diff_ids)
        || config.rootfs.diff_ids.length !== image.manifest.layers.length) failClosed();
    validateLabels(config, version, sourceCommit);
    const layerPaths = new Set(image.manifest.layers.map((layer) => {
      validateDescriptor(layer);
      if (layer.mediaType !== "application/vnd.oci.image.layer.v1.tar+gzip") failClosed();
      referencedMembers.add(digestPath(layer.digest));
      return digestPath(layer.digest);
    }));
    const layerMembers = readTarMembers(archivePath, layerPaths, MAX_LAYER_BYTES);
    for (const [index, layer] of image.manifest.layers.entries()) {
      const bytes = verifiedDescriptorBytes(layer, layerMembers.get(digestPath(layer.digest)));
      if (uncompressedLayerDigest(bytes) !== config.rootfs.diff_ids[index]) failClosed();
    }
  }

  const attestationManifests = attestations.map((descriptor) => {
    const referencedDigest = descriptor.annotations?.["vnd.docker.reference.digest"];
    if (!images.some((image) => image.descriptor.digest === referencedDigest)) failClosed();
    const manifest = parseJson(verifiedDescriptorBytes(descriptor, topMembers.get(digestPath(descriptor.digest))));
    if (descriptor.mediaType !== "application/vnd.oci.image.manifest.v1+json"
        || manifest.schemaVersion !== 2 || manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json"
        || !Array.isArray(manifest.layers) || manifest.layers.length !== 2) failClosed();
    validateDescriptor(manifest.config);
    if (manifest.config.mediaType !== "application/vnd.oci.image.config.v1+json") failClosed();
    referencedMembers.add(digestPath(manifest.config.digest));
    return { descriptor, manifest, referencedDigest };
  });
  if (attestationManifests.length !== images.length) failClosed();
  const attestationConfigs = readTarMembers(
    archivePath,
    new Set(attestationManifests.map(({ manifest }) => digestPath(manifest.config.digest))),
  );
  for (const { manifest } of attestationManifests) {
    const config = parseJson(verifiedDescriptorBytes(
      manifest.config,
      attestationConfigs.get(digestPath(manifest.config.digest)),
    ));
    if (config.os !== "unknown" || config.architecture !== "unknown" || config.rootfs?.type !== "layers"
        || !Array.isArray(config.rootfs.diff_ids) || config.rootfs.diff_ids.length !== manifest.layers.length
        || manifest.layers.some((layer, index) => config.rootfs.diff_ids[index] !== layer.digest)) failClosed();
  }
  const layerPaths = new Set(attestationManifests.flatMap(({ manifest }) => manifest.layers.map((layer) => {
    validateDescriptor(layer);
    if (layer.mediaType !== "application/vnd.in-toto+json") failClosed();
    referencedMembers.add(digestPath(layer.digest));
    return digestPath(layer.digest);
  })));
  const layers = readTarMembers(archivePath, layerPaths);
  const result = images.map((image) => {
    const statements = [];
    for (const record of attestationManifests.filter(({ referencedDigest }) => referencedDigest === image.descriptor.digest)) {
      for (const layer of record.manifest.layers) {
        const statement = parseJson(verifiedDescriptorBytes(layer, layers.get(digestPath(layer.digest))));
        if (!IN_TOTO_STATEMENT_TYPES.includes(statement?._type)
            || !statementSubjectMatches(statement, image.descriptor.digest, image.platform, version)
            || typeof statement.predicateType !== "string" || statement.predicate === null
            || typeof statement.predicate !== "object" || Array.isArray(statement.predicate)
            || layer.annotations?.["in-toto.io/predicate-type"] !== statement.predicateType) failClosed();
        statements.push(statement);
      }
    }
    const spdx = statements.find(({ predicateType }) => predicateType === "https://spdx.dev/Document");
    const provenance = statements.find(({ predicateType }) => predicateType === "https://slsa.dev/provenance/v1");
    if (statements.length !== 2 || spdx === undefined || provenance === undefined
        || spdx.predicate.spdxVersion !== "SPDX-2.3") failClosed();
    const provenanceClassification = validateProvenancePredicate(provenance.predicate, version, sourceCommit);
    return Object.freeze({
      imageDigest: image.descriptor.digest,
      platform: image.platform,
      provenance: provenanceClassification,
      provenancePredicateType: provenance.predicateType,
      spdxDocument: spdx.predicate,
      spdxPredicateType: spdx.predicateType,
    });
  }).sort((left, right) => REQUIRED_PLATFORMS.indexOf(left.platform) - REQUIRED_PLATFORMS.indexOf(right.platform));
  const allowedDirectories = new Set(["blobs", "blobs/sha256"]);
  for (const [name, type] of archiveEntries) {
    if ((type === "0" && !referencedMembers.has(name))
        || (type === "5" && !allowedDirectories.has(name))) failClosed();
  }
  if ([...referencedMembers].some((name) => archiveEntries.get(name) !== "0")) failClosed();
  return Object.freeze({ platforms: Object.freeze(result) });
}

export function inspectDockerArchive({ archivePath, platform, sourceCommit, version }) {
  validateAbsolutePath(archivePath, "Docker archive");
  safeCommit(sourceCommit);
  stableVersion(version);
  if (!REQUIRED_PLATFORMS.includes(platform)) failClosed();
  const archiveEntries = new Map();
  const rootMembers = readTarMembers(
    archivePath,
    new Set(["index.json", "manifest.json", "oci-layout"]),
    MAX_METADATA_BYTES,
    archiveEntries,
  );
  const layout = parseJson(rootMembers.get("oci-layout"));
  const index = parseJson(rootMembers.get("index.json"));
  const manifest = parseJson(rootMembers.get("manifest.json"));
  if (layout.imageLayoutVersion !== "1.0.0" || index.schemaVersion !== 2
      || index.mediaType !== "application/vnd.oci.image.index.v1+json"
      || !Array.isArray(index.manifests) || index.manifests.length !== 1
      || !Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0].RepoTags)
      || manifest[0].RepoTags.length !== 1 || manifest[0].RepoTags[0] !== `${LOCAL_IMAGE_NAME}:${version}`
      || typeof manifest[0].Config !== "string" || !Array.isArray(manifest[0].Layers)
      || manifest[0].Layers.length === 0) failClosed();
  const imageDescriptor = validateDescriptor(index.manifests[0]);
  if (imageDescriptor.mediaType !== "application/vnd.docker.distribution.manifest.v2+json"
      || platformOf(imageDescriptor) !== platform) failClosed();
  const imageManifestPath = digestPath(imageDescriptor.digest);
  const imageManifest = parseJson(verifiedDescriptorBytes(
    imageDescriptor,
    readTarMembers(archivePath, new Set([imageManifestPath])).get(imageManifestPath),
  ));
  if (imageManifest.schemaVersion !== 2
      || imageManifest.mediaType !== "application/vnd.docker.distribution.manifest.v2+json"
      || !Array.isArray(imageManifest.layers) || imageManifest.layers.length === 0) failClosed();
  validateDescriptor(imageManifest.config);
  if (imageManifest.config.mediaType !== "application/vnd.docker.container.image.v1+json"
      || manifest[0].Config !== digestPath(imageManifest.config.digest)
      || manifest[0].Layers.length !== imageManifest.layers.length) failClosed();
  const configPath = digestPath(imageManifest.config.digest);
  const config = parseJson(verifiedDescriptorBytes(
    imageManifest.config,
    readTarMembers(archivePath, new Set([configPath])).get(configPath),
  ));
  const [os, architecture] = platform.split("/");
  if (config.os !== os || config.architecture !== architecture || config.rootfs?.type !== "layers"
      || !Array.isArray(config.rootfs.diff_ids)
      || config.rootfs.diff_ids.length !== imageManifest.layers.length) failClosed();
  validateLabels(config, version, sourceCommit);
  const layerPaths = new Set(imageManifest.layers.map((layer, layerIndex) => {
    validateDescriptor(layer);
    const path = digestPath(layer.digest);
    if (layer.mediaType !== "application/vnd.docker.image.rootfs.diff.tar.gzip"
        || manifest[0].Layers[layerIndex] !== path) failClosed();
    return path;
  }));
  const layers = readTarMembers(archivePath, layerPaths, MAX_LAYER_BYTES);
  for (const [layerIndex, layer] of imageManifest.layers.entries()) {
    const bytes = verifiedDescriptorBytes(layer, layers.get(digestPath(layer.digest)));
    if (uncompressedLayerDigest(bytes) !== config.rootfs.diff_ids[layerIndex]) failClosed();
  }
  const referenced = new Set([
    "index.json",
    "manifest.json",
    "oci-layout",
    imageManifestPath,
    configPath,
    ...layerPaths,
  ]);
  const allowedDirectories = new Set(["blobs", "blobs/sha256"]);
  for (const [name, type] of archiveEntries) {
    if ((type === "0" && !referenced.has(name)) || (type === "5" && !allowedDirectories.has(name))) failClosed();
  }
  if ([...referenced].some((name) => archiveEntries.get(name) !== "0")) failClosed();
  return Object.freeze({
    platform,
    runtimeImageIds: Object.freeze([
      imageManifest.config.digest,
      imageDescriptor.digest,
    ]),
    tag: `${LOCAL_IMAGE_NAME}:${version}`,
  });
}

async function runProcess(request) {
  try {
    const result = await execFileAsync(request.command, request.args, {
      cwd: request.cwd,
      encoding: "utf8",
      env: request.environment,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: 30 * 60_000,
      windowsHide: true,
    });
    return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    const failure = new Error("Image staging command failed safely");
    Object.defineProperty(failure, "cause", { value: error, enumerable: false });
    throw failure;
  }
}

function dockerEnvironment(source) {
  const path = source.PATH;
  const home = source.HOME;
  if (typeof path !== "string" || path === "" || path.includes("\0")
      || typeof home !== "string" || home === "" || home.includes("\0")) failClosed();
  const environment = {
    PATH: path,
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    NO_COLOR: "1",
  };
  for (const key of ["DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "BUILDX_BUILDER", "XDG_RUNTIME_DIR", "TMPDIR", "__CF_USER_TEXT_ENCODING"]) {
    const value = source[key];
    if (typeof value === "string" && value !== "" && !value.includes("\0")) environment[key] = value;
  }
  return Object.freeze(environment);
}

function writeProvenanceClassification(outputDirectory, inspection, sourceCommit, version) {
  if (!plainRecord(inspection) || !Array.isArray(inspection.platforms)
      || inspection.platforms.length !== REQUIRED_PLATFORMS.length) failClosed();
  const platforms = inspection.platforms.map((record, index) => {
    const provenance = record?.provenance;
    if (!plainRecord(record) || record.platform !== REQUIRED_PLATFORMS[index]
        || typeof record.imageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.imageDigest)
        || !plainRecord(provenance) || provenance.classification !== "buildkit-unsigned-provenance"
        || provenance.attestationAuthenticity !== "unsigned"
        || provenance.sourceBinding !== "unverified-local-context"
        || provenance.predicateType !== "https://slsa.dev/provenance/v1"
        || !["complete", "incomplete"].includes(provenance.dependencyCompleteness)
        || !["absent", "self-asserted"].includes(provenance.builderIdentity)
        || typeof provenance.builderPlatform !== "string"
        || !/^linux\/(?:amd64|arm64)$/.test(provenance.builderPlatform)) failClosed();
    return {
      builderIdentity: provenance.builderIdentity,
      builderPlatform: provenance.builderPlatform,
      dependencyCompleteness: provenance.dependencyCompleteness,
      imageDigest: record.imageDigest,
      platform: record.platform,
    };
  });
  const report = {
    schemaVersion: 1,
    imageName: RELEASE_ARTIFACTS.image.name,
    version,
    sourceCommit,
    predicateType: "https://slsa.dev/provenance/v1",
    classification: "buildkit-unsigned-provenance",
    attestationAuthenticity: "unsigned",
    sourceBinding: "unverified-local-context",
    limitations: [
      "BuildKit attestations in this archive are not cryptographically signed.",
      "Build context and Dockerfile are local inputs without an attested immutable source digest.",
      "Builder identity is absent or self-asserted and is not independently verified.",
      ...(platforms.some(({ dependencyCompleteness }) => dependencyCompleteness === "incomplete")
        ? ["BuildKit reports that its resolved dependency disclosure is incomplete."]
        : []),
    ],
    platforms,
  };
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const path = join(outputDirectory, `gauntlet-${version}.provenance.json`);
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
    if (!sameFile(stat, pathname) || stat.size !== BigInt(bytes.length)) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return Object.freeze({
    kind: "provenance",
    name: `${RELEASE_ARTIFACTS.image.name}@buildkit-unsigned`,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    version,
  });
}

function validateBakeFile(root) {
  const path = join(root, "docker-bake.hcl");
  try {
    if (realpathSync(path) !== path) failClosed();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n || stat.size > 64_000n) failClosed();
    const source = readFileSync(path, "utf8");
    if (/\b(?:push|cache-to|secret|ssh)\b/iu.test(source)
        || !source.includes("type=provenance,mode=max,version=v1")
        || !source.includes(`type=sbom,generator=docker.io/docker/buildkit-syft-scanner@sha256:${SBOM_GENERATOR_DIGEST}`)) {
      failClosed();
    }
    const dockerfilePath = join(root, "Dockerfile");
    if (realpathSync(dockerfilePath) !== dockerfilePath) failClosed();
    const dockerfileStat = lstatSync(dockerfilePath, { bigint: true });
    if (!dockerfileStat.isFile() || dockerfileStat.isSymbolicLink() || dockerfileStat.nlink !== 1n
        || dockerfileStat.size <= 0n || dockerfileStat.size > 1024_000n) failClosed();
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    if (!dockerfile.startsWith(
      `# syntax=docker/dockerfile:1.7@sha256:${DOCKERFILE_FRONTEND_DIGEST}\n`,
    )) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

export async function exportImageAndAttestations(options, testing = {}) {
  const values = exactDataObject(
    options,
    ["outputDirectory", "root", "sourceCommit", "version"],
    "Image staging options",
  );
  const root = values.root;
  const outputDirectory = values.outputDirectory;
  validateCanonicalDirectory(root, "Image staging root");
  validateCanonicalDirectory(outputDirectory, "Image staging output", true);
  if (outputDirectory.startsWith(`${root}${sep}`) || root.startsWith(`${outputDirectory}${sep}`)) failClosed();
  if (readdirSync(outputDirectory).length !== 0) failClosed();
  const sourceCommit = safeCommit(values.sourceCommit);
  const version = stableVersion(values.version);
  validateBakeFile(root);
  const platform = hostPlatform();
  const plan = createImageExportPlan({ hostPlatform: platform, outputDirectory, root, sourceCommit, version });
  const run = testing.run ?? runProcess;
  const inspectOci = testing.inspectOci ?? inspectOciArchive;
  const inspectDocker = testing.inspectDocker ?? inspectDockerArchive;
  if (typeof run !== "function" || typeof inspectOci !== "function" || typeof inspectDocker !== "function") {
    throw new TypeError("Image staging testing hooks must be functions");
  }
  const environment = dockerEnvironment(process.env);
  let builder;
  try {
    builder = await run({ ...plan[0], cwd: root, environment });
  } catch {
    failClosed(`${BLOCKER}: Docker Buildx builder inspection failed`);
  }
  parseBuildxPlatforms(`${builder.stdout ?? ""}\n${builder.stderr ?? ""}`, { requireReleasePlatforms: true });
  try {
    await run({ ...plan[1], cwd: root, environment });
  } catch {
    failClosed("Local Docker archive export failed safely");
  }
  const dockerPath = join(outputDirectory, `gauntlet-${version}.docker.tar`);
  const dockerInspection = inspectDocker({ archivePath: dockerPath, platform, sourceCommit, version });
  try {
    await run({ ...plan[2], cwd: root, environment });
  } catch {
    failClosed(`${BLOCKER}: the capable builder failed to export the attested release index`);
  }
  const ociPath = join(outputDirectory, `gauntlet-${version}.oci.tar`);
  const inspection = inspectOci({ archivePath: ociPath, sourceCommit, version });
  const docker = archiveRecord(dockerPath);
  const oci = archiveRecord(ociPath);
  const provenance = writeProvenanceClassification(outputDirectory, inspection, sourceCommit, version);
  return Object.freeze({
    artifacts: Object.freeze([
      Object.freeze({ kind: "docker", name: LOCAL_IMAGE_NAME, path: docker.path, sha256: docker.sha256, version }),
      Object.freeze({ kind: "oci", name: RELEASE_ARTIFACTS.image.name, path: oci.path, sha256: oci.sha256, version }),
      provenance,
    ]),
    dockerInspection,
    hostPlatform: platform,
    inspection,
  });
}
