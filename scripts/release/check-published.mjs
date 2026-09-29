#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, types as utilTypes } from "node:util";

import { parseDocument } from "yaml";

import { withMaterializedCanonicalTree, withOwnedTemporaryWorkspace } from "./archive-consumer.mjs";
import { parseReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";
import { publishComposerPackage } from "./publish-composer.mjs";

const execFileAsync = promisify(execFile);
const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const FAILURE = "Published destination check failed closed";
const OBSERVATION_FAILURE = "Remote probe observation failed closed";
const MAX_OBSERVATION_BYTES = 4 * 1024;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const GITHUB_ASSET_REDIRECTS = 3;
const GITHUB_API_VERSION = "2026-03-10";
const PUBLICATION_POLL_INTERVAL_MS = 15_000;
const PUBLICATION_MAX_POLLS = 40;

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function githubReleaseAssetCatalog(releaseVersion) {
  const version = stableVersion(releaseVersion);
  const mib = 1024 * 1024;
  return Object.freeze([
    { name: `gauntlet-compose-${version}.tar.gz`, maximumBytes: 512 * mib },
    { name: `gauntlet-skills-${version}.tgz`, maximumBytes: 64 * mib },
    { name: `gauntlet-${version}.tgz`, maximumBytes: 64 * mib },
    { name: "release-manifest.json", maximumBytes: 1 * mib },
    { name: "publication-receipt.json", maximumBytes: 64 * 1024 },
    { name: "SHA256SUMS", maximumBytes: 1 * mib },
    { name: `gauntlet-${version}.provenance.json`, maximumBytes: 16 * mib },
    { name: "gauntlet-linux-amd64.spdx.json", maximumBytes: 128 * mib },
    { name: "gauntlet-linux-arm64.spdx.json", maximumBytes: 128 * mib },
  ].map((record) => Object.freeze(record)));
}

function stagedArtifactCatalog(version) {
  const records = [
    ...RELEASE_ARTIFACTS.npm.map(({ name }) => ({
      kind: "npm",
      name,
      path: `npm/${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`,
    })),
    ...RELEASE_ARTIFACTS.composer.map(({ name, repository }) => ({
      kind: "composer",
      name,
      path: `composer/artifacts/${repository.split("/").at(-1)}-${version}.tar.gz`,
    })),
    ...RELEASE_ARTIFACTS.maven.map(({ name }) => ({
      kind: "maven",
      name,
      path: `maven/artifacts/gauntlet-${name.split(":")[1]}-${version}.tar.gz`,
    })),
    {
      kind: "compose",
      name: RELEASE_ARTIFACTS.compose.name,
      path: `compose/gauntlet-compose-${version}.tar.gz`,
    },
    {
      kind: "skills",
      name: RELEASE_ARTIFACTS.skills.name,
      path: `skills/gauntlet-skills-${version}.tgz`,
    },
    { kind: "helm", name: RELEASE_ARTIFACTS.chart.name, path: `helm/gauntlet-${version}.tgz` },
    { kind: "docker", name: "gauntlet.local/gauntlet", path: `image/gauntlet-${version}.docker.tar` },
    { kind: "oci", name: RELEASE_ARTIFACTS.image.name, path: `image/gauntlet-${version}.oci.tar` },
    {
      kind: "provenance",
      name: `${RELEASE_ARTIFACTS.image.name}@buildkit-unsigned`,
      path: `image/gauntlet-${version}.provenance.json`,
    },
    {
      kind: "sbom",
      name: `${RELEASE_ARTIFACTS.image.name}@linux/amd64`,
      path: "sbom/gauntlet-linux-amd64.spdx.json",
    },
    {
      kind: "sbom",
      name: `${RELEASE_ARTIFACTS.image.name}@linux/arm64`,
      path: "sbom/gauntlet-linux-arm64.spdx.json",
    },
  ];
  if (records.length !== 19) throw new Error(FAILURE);
  return Object.freeze(records.map((record) => Object.freeze(record)));
}

function deeplyFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deeplyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const publishedDestinations = [
  ...RELEASE_ARTIFACTS.npm.map((artifact) => ({
    id: `npm:${artifact.name.slice("@8lines/gauntlet-".length)}`,
    kind: "npm",
    target: artifact.name,
  })),
  ...RELEASE_ARTIFACTS.maven.map((artifact) => ({
    id: `maven:${artifact.name.split(":")[1]}`,
    kind: "maven",
    target: artifact.name,
  })),
  { id: "image:semantic", kind: "image", target: RELEASE_ARTIFACTS.image.name },
  { id: "image:commit", kind: "image", target: RELEASE_ARTIFACTS.image.name },
  { id: "chart:semantic", kind: "chart", target: RELEASE_ARTIFACTS.chart.repository },
  ...RELEASE_ARTIFACTS.composer.map((artifact) => ({
    id: `composer:${artifact.name.slice("8lines/gauntlet-".length)}`,
    kind: "composer",
    target: artifact.repositoryUrl,
  })),
  { id: "github:release", kind: "release", target: "https://github.com/8lines/gauntlet/releases/tag" },
];

export const PUBLISHED_DESTINATIONS = deeplyFreeze(publishedDestinations);

function ownData(value, keys, label) {
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

function stableVersion(value) {
  try {
    if (typeof value !== "string") throw new Error();
    return parseReleaseVersion(`${value}\n`);
  } catch {
    throw new TypeError("Published destination version must be an exact stable semantic version");
  }
}

function sourceCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new TypeError("Published destination source commit must be a lowercase full SHA-1");
  }
  return value;
}

function exactEvidence(evidence, source) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence) || utilTypes.isProxy(evidence)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(evidence))) {
    throw new TypeError("Published evidence must be a closed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(evidence);
  const keys = Reflect.ownKeys(descriptors);
  const expectedKeys = PUBLISHED_DESTINATIONS.map(({ id }) => id);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) {
    throw new TypeError("Published evidence must name every fixed destination exactly once");
  }
  const result = Object.create(null);
  for (const destination of PUBLISHED_DESTINATIONS) {
    const value = descriptors[destination.id].value;
    const accepted = destination.kind === "npm" ? NPM_INTEGRITY
      : destination.kind === "image" ? OCI_DIGEST
      : destination.kind === "composer" ? COMMIT
        : SHA256;
    if (typeof value !== "string" || !accepted.test(value)) {
      throw new TypeError(`Published evidence for ${destination.id} is invalid`);
    }
    result[destination.id] = value;
  }
  return Object.freeze(result);
}

export function parseOciLayoutIndex(source) {
  try {
    if (typeof source !== "string" || Buffer.byteLength(source) < 2 || Buffer.byteLength(source) > 1024 * 1024
        || source.includes("\0") || source.includes("\r")) throw new Error();
    const value = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 2
        || !Array.isArray(value.manifests) || value.manifests.length !== 1) throw new Error();
    const descriptor = value.manifests[0];
    if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)
        || typeof descriptor.mediaType !== "string"
        || !["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"].includes(descriptor.mediaType)
        || typeof descriptor.digest !== "string" || !OCI_DIGEST.test(descriptor.digest)
        || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) throw new Error();
    return descriptor.digest;
  } catch {
    throw new Error("OCI layout evidence failed closed");
  }
}

export function parseImageInspection(output) {
  try {
    if (typeof output !== "string" || output.length === 0 || output.length > 1024 * 1024
        || output.includes("\0") || output.includes("\r")) throw new Error();
    const matches = [...output.matchAll(/^Digest:[ \t]+(sha256:[0-9a-f]{64})$/gmu)];
    if (matches.length !== 1) throw new Error();
    return matches[0][1];
  } catch {
    throw new Error("Remote image inspection failed closed");
  }
}

function publicationReceiptBytes(receipt) {
  const keys = ["schemaVersion", "version", "sourceCommit", "imageDigest", "chartDigest", "manifestSha256"];
  return Buffer.from(`${JSON.stringify(Object.fromEntries(keys.map((key) => [key, receipt[key]])), null, 2)}\n`, "utf8");
}

export function parsePublicationReceipt(source, expected) {
  try {
    const values = ownData(expected, ["version", "sourceCommit", "manifestSha256"], "Publication receipt expectation");
    const version = stableVersion(values.version);
    const commit = sourceCommit(values.sourceCommit);
    if (typeof values.manifestSha256 !== "string" || !SHA256.test(values.manifestSha256)
        || typeof source !== "string" || Buffer.byteLength(source) === 0 || Buffer.byteLength(source) > 64 * 1024
        || source.includes("\0") || source.includes("\r")) throw new Error();
    const document = parseDocument(source, { json: true, prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length !== 0 || document.warnings.length !== 0) throw new Error();
    const receipt = JSON.parse(source);
    const keys = ["schemaVersion", "version", "sourceCommit", "imageDigest", "chartDigest", "manifestSha256"];
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)
        || Object.keys(receipt).length !== keys.length || keys.some((key) => !Object.hasOwn(receipt, key))
        || receipt.schemaVersion !== 1 || receipt.version !== version || receipt.sourceCommit !== commit
        || typeof receipt.imageDigest !== "string" || !OCI_DIGEST.test(receipt.imageDigest)
        || typeof receipt.chartDigest !== "string" || !OCI_DIGEST.test(receipt.chartDigest)
        || receipt.manifestSha256 !== values.manifestSha256) throw new Error();
    const result = Object.freeze(Object.fromEntries(keys.map((key) => [key, receipt[key]])));
    if (!Buffer.from(source, "utf8").equals(publicationReceiptBytes(result))) throw new Error();
    return result;
  } catch {
    throw new Error("Remote publication receipt failed closed");
  }
}

export function parseReleaseAssets(assets, releaseVersion) {
  try {
    const version = stableVersion(releaseVersion);
    const expected = githubReleaseAssetCatalog(version).map(({ name }) => name);
    if (!Array.isArray(assets) || utilTypes.isProxy(assets) || assets.length !== expected.length) throw new Error();
    const result = Object.create(null);
    const ids = new Set();
    for (const asset of assets) {
      if (asset === null || typeof asset !== "object" || Array.isArray(asset) || utilTypes.isProxy(asset)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(asset))) throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(asset);
      if (!("name" in descriptors) || !("id" in descriptors)
          || !("value" in descriptors.name) || !("value" in descriptors.id)) throw new Error();
      const name = descriptors.name.value;
      const id = descriptors.id.value;
      if (typeof name !== "string" || !expected.includes(name) || Object.hasOwn(result, name)
          || !Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error();
      result[name] = id;
      ids.add(id);
    }
    if (expected.some((name) => !Object.hasOwn(result, name))) throw new Error();
    return Object.freeze(Object.fromEntries(expected.map((name) => [name, result[name]])));
  } catch {
    throw new Error("GitHub Release assets failed closed");
  }
}

function destinationUrl(template, version, commit) {
  switch (template.kind) {
    case "npm":
      return `https://registry.npmjs.org/${template.target}@${version}`;
    case "maven": {
      const [group, artifact] = template.target.split(":");
      return `${RELEASE_ARTIFACTS.maven.find(({ name }) => name === template.target).repository}/${group.replaceAll(".", "/")}/${artifact}/${version}`;
    }
    case "image":
      return `${template.target}:${template.id.endsWith("semantic") ? version : `sha-${commit.slice(0, 12)}`}`;
    case "chart":
      return `${template.target}/${RELEASE_ARTIFACTS.chart.name}:${version}`;
    case "composer":
      return `${template.target}#v${version}`;
    case "release":
      return `${template.target}/v${version}`;
    default:
      throw new Error(FAILURE);
  }
}

export function createPublishedCheckPlan(options) {
  const values = ownData(options, ["version", "sourceCommit", "evidence"], "Published check plan options");
  const version = stableVersion(values.version);
  const commit = sourceCommit(values.sourceCommit);
  const evidence = exactEvidence(values.evidence, commit);
  const plan = PUBLISHED_DESTINATIONS.map((template) => Object.freeze({
    id: template.id,
    kind: template.kind,
    destination: destinationUrl(template, version, commit),
    expectedEvidence: evidence[template.id],
    version,
  }));
  return Object.freeze(plan);
}

function assertPlan(plan) {
  if (!Array.isArray(plan) || utilTypes.isProxy(plan) || plan.length !== PUBLISHED_DESTINATIONS.length) {
    throw new TypeError("Published check plan is invalid");
  }
  for (const [index, check] of plan.entries()) {
    if (!Object.isFrozen(check) || check.id !== PUBLISHED_DESTINATIONS[index].id
        || check.kind !== PUBLISHED_DESTINATIONS[index].kind || typeof check.destination !== "string"
        || typeof check.expectedEvidence !== "string") throw new TypeError("Published check plan is invalid");
  }
  return plan;
}

function observationValue(candidate, expected) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || utilTypes.isProxy(candidate)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) {
    throw new Error(`invalid observation for ${expected.id}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) {
    throw new Error(`invalid observation for ${expected.id}`);
  }
  const id = descriptors.id?.value;
  const state = descriptors.state?.value;
  if (id !== expected.id || !["absent", "present"].includes(state)) throw new Error(`invalid observation for ${expected.id}`);
  if (state === "absent") {
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("state")) throw new Error(`invalid observation for ${expected.id}`);
    return Object.freeze({ id, state });
  }
  if (keys.length !== 3 || !keys.includes("id") || !keys.includes("state") || !keys.includes("evidence")
      || typeof descriptors.evidence.value !== "string") throw new Error(`invalid observation for ${expected.id}`);
  return Object.freeze({ id, state, evidence: descriptors.evidence.value });
}

export function evaluatePublishedState(plan, observations) {
  const checks = assertPlan(plan);
  if (!Array.isArray(observations) || utilTypes.isProxy(observations) || observations.length !== checks.length) {
    throw new Error("Remote probes did not return a complete observation set");
  }
  const byId = new Map();
  for (const candidate of observations) {
    const id = candidate?.id;
    const expected = checks.find((check) => check.id === id);
    if (expected === undefined || byId.has(id)) throw new Error("Remote probes did not return a complete observation set");
    byId.set(id, observationValue(candidate, expected));
  }
  if (byId.size !== checks.length) throw new Error("Remote probes did not return a complete observation set");
  const ordered = checks.map(({ id }) => byId.get(id));
  const present = ordered.filter(({ state }) => state === "present");
  if (present.length !== 0 && present.length !== checks.length) {
    throw new Error("Remote destinations have mixed published state");
  }
  if (present.length === 0) return "clean";
  for (const [index, observation] of ordered.entries()) {
    if (observation.evidence !== checks[index].expectedEvidence) {
      throw new Error(`Remote destination ${observation.id} has different evidence`);
    }
  }
  return "already-identical";
}

export async function checkPublishedDestinations(options) {
  const values = ownData(options, ["plan", "probe"], "Published destination check options");
  const plan = assertPlan(values.plan);
  if (typeof values.probe !== "function") throw new TypeError("Published destination probe must be a function");
  const settled = await Promise.allSettled(plan.map((check) => Promise.resolve().then(() => values.probe(check))));
  const failure = settled.find(({ status }) => status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return evaluatePublishedState(plan, settled.map(({ value }) => value));
}

async function collectRemoteObservations(plan, probe) {
  const settled = await Promise.allSettled(plan.map((check) => Promise.resolve().then(() => probe(check))));
  const failure = settled.find(({ status }) => status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return settled.map(({ value }) => value);
}

function evaluatePublishedArtifactsBeforeRelease(plan, observations) {
  if (!Array.isArray(observations) || observations.length !== plan.length) {
    throw new Error("Remote probes did not return a complete observation set");
  }
  const releaseCheck = plan.find(({ kind }) => kind === "release");
  const releaseObservation = observations.find(({ id }) => id === releaseCheck?.id);
  if (releaseCheck === undefined || releaseObservation === undefined
      || observationValue(releaseObservation, releaseCheck).state !== "absent") {
    throw new Error("Post-publication verification found invalid GitHub Release state");
  }
  const simulatedComplete = observations.map((observation) => observation.id === releaseCheck.id
    ? { id: releaseCheck.id, state: "present", evidence: releaseCheck.expectedEvidence }
    : observation);
  if (evaluatePublishedState(plan, simulatedComplete) !== "already-identical") {
    throw new Error("Post-publication verification required every artifact to be identical");
  }
  return "published-artifacts-identical";
}

function syntacticAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === sep
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be an absolute safe path`);
  return value;
}

function dependencySet(overrides) {
  const dependencies = overrides ?? DEFAULT_RELEASE_CHECK_DEPENDENCIES;
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)
      || utilTypes.isProxy(dependencies) || ![Object.prototype, null].includes(Object.getPrototypeOf(dependencies))) {
    throw new TypeError("Published check dependencies must be a closed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(dependencies);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => !["collectEvidence", "probe", "sleep"].includes(key)
      || typeof key !== "string" || descriptors[key].enumerable !== true || !("value" in descriptors[key]))
      || !keys.includes("collectEvidence") || !keys.includes("probe")) {
    throw new TypeError("Published check dependencies must be a closed data object");
  }
  const values = {
    collectEvidence: descriptors.collectEvidence.value,
    probe: descriptors.probe.value,
    sleep: descriptors.sleep?.value ?? wait,
  };
  if (typeof values.collectEvidence !== "function" || typeof values.probe !== "function"
      || typeof values.sleep !== "function") {
    throw new TypeError("Published check dependencies must be functions");
  }
  return Object.freeze(values);
}

const DEFAULT_RELEASE_CHECK_DEPENDENCIES = Object.freeze({
  collectEvidence: collectReleaseEvidence,
  probe: probeRemoteDestination,
});

async function verifyPublishedArtifactsWithRetry(plan, probe, sleep) {
  for (let attempt = 0; attempt <= PUBLICATION_MAX_POLLS; attempt += 1) {
    const observations = await collectRemoteObservations(plan, probe);
    try {
      if (evaluatePublishedState(plan, observations) === "already-identical") return "already-identical";
    } catch {
      // A partial set is retried only when every visible item still matches.
    }
    if (observations.length !== plan.length) throw new Error("Remote probes did not return a complete observation set");
    const byId = new Map(observations.map((observation) => [observation?.id, observation]));
    const releaseCheck = plan.find(({ kind }) => kind === "release");
    if (releaseCheck === undefined || byId.size !== plan.length) {
      throw new Error("Remote probes did not return a complete observation set");
    }
    for (const check of plan) {
      const observation = observationValue(byId.get(check.id), check);
      if (check.id === releaseCheck.id) {
        if (observation.state !== "absent") throw new Error("Post-publication verification found invalid GitHub Release state");
      } else if (observation.state === "present" && observation.evidence !== check.expectedEvidence) {
        throw new Error(`Remote destination ${check.id} has different evidence`);
      }
    }
    const pending = plan.some(({ id, kind }) => kind !== "release" && byId.get(id)?.state === "absent");
    if (!pending) return evaluatePublishedArtifactsBeforeRelease(plan, observations);
    if (attempt === PUBLICATION_MAX_POLLS) break;
    await sleep(PUBLICATION_POLL_INTERVAL_MS);
  }
  throw new Error("Post-publication verification required every destination to be identical");
}

export async function checkReleasePublication(options, dependencyOverrides) {
  const values = ownData(
    options,
    ["releaseDirectory", "version", "sourceCommit", "requireIdentical"],
    "Release publication check options",
  );
  const releaseDirectory = syntacticAbsolutePath(values.releaseDirectory, "Release directory");
  const version = stableVersion(values.version);
  const commit = sourceCommit(values.sourceCommit);
  if (typeof values.requireIdentical !== "boolean") {
    throw new TypeError("Release publication requireIdentical must be boolean");
  }
  const dependencies = dependencySet(dependencyOverrides);
  const collectorOptions = { releaseDirectory, version, sourceCommit: commit };
  const evidence = await dependencies.collectEvidence(collectorOptions);
  const plan = createPublishedCheckPlan({ version, sourceCommit: commit, evidence });
  if (!values.requireIdentical) return checkPublishedDestinations({ plan, probe: dependencies.probe });
  return verifyPublishedArtifactsWithRetry(plan, dependencies.probe, dependencies.sleep);
}

export async function checkDraftReleasePublication(options) {
  try {
    const values = ownData(
      options,
      ["releaseDirectory", "version", "sourceCommit"],
      "Draft release verification options",
    );
    const releaseDirectory = canonicalDirectory(
      syntacticAbsolutePath(values.releaseDirectory, "Release directory"),
      "Release directory",
    );
    const version = stableVersion(values.version);
    const commit = sourceCommit(values.sourceCommit);
    const local = await localGithubReleaseEvidence(releaseDirectory, version, commit);
    const template = PUBLISHED_DESTINATIONS.find(({ id }) => id === "github:release");
    if (template === undefined) throw new Error();
    const check = Object.freeze({
      id: template.id,
      kind: template.kind,
      destination: destinationUrl(template, version, commit),
      expectedEvidence: local.evidence,
      version,
    });
    const observation = observationValue(await probeDraftRelease(check), check);
    if (observation.state !== "present" || observation.evidence !== check.expectedEvidence) throw new Error();
    return "draft-identical";
  } catch {
    throw new Error(FAILURE);
  }
}

export function parseProbeObservation(output, check) {
  try {
    if (typeof output !== "string" || Buffer.byteLength(output) === 0
        || Buffer.byteLength(output) > MAX_OBSERVATION_BYTES || !output.endsWith("\n")
        || output.slice(0, -1).includes("\n") || output.includes("\0") || output.includes("\r")) throw new Error();
    const value = JSON.parse(output);
    const parsed = observationValue(value, check);
    if (`${JSON.stringify(parsed)}\n` !== output) throw new Error();
    return parsed;
  } catch {
    throw new Error(OBSERVATION_FAILURE);
  }
}

function canonicalFile(path, label, maximumBytes = 1024n * 1024n) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep
        || /[\u0000-\u001f\u007f]/u.test(path) || realpathSync(path) !== path) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n || stat.size > maximumBytes) throw new Error();
    return path;
  } catch {
    throw new TypeError(`${label} must be a safe canonical file`);
  }
}

function hashFile(path, algorithm = "sha256", encoding = "hex") {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const before = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!before.isFile() || pathname.isSymbolicLink() || before.dev !== pathname.dev || before.ino !== pathname.ino
        || before.mode !== pathname.mode || before.size !== pathname.size || before.nlink !== 1n || pathname.nlink !== 1n
        || before.size < 0n || before.size > 16n * 1024n * 1024n * 1024n) throw new Error();
    const hash = createHash(algorithm);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      if (count <= 0) throw new Error();
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error();
    return hash.digest(encoding);
  } catch {
    throw new Error(FAILURE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function digestFile(path) {
  return hashFile(path);
}

function atomicReplace(path, bytes, mode = 0o600) {
  const directory = resolve(path, "..");
  const scratch = join(directory, `.gauntlet-finalize-${randomBytes(16).toString("hex")}`);
  let descriptor;
  try {
    descriptor = openSync(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_CLOEXEC, mode);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error();
      offset += count;
    }
    fsyncSync(descriptor);
    chmodSync(scratch, mode);
    renameSync(scratch, path);
  } catch {
    try { unlinkSync(scratch); } catch { /* Exact task-owned scratch cleanup only. */ }
    throw new Error(FAILURE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writePublicationReceipt(options) {
  const values = ownData(
    options,
    ["releaseDirectory", "imageDigest", "chartDigest"],
    "Published manifest finalization options",
  );
  const releaseDirectory = canonicalDirectory(values.releaseDirectory, "Release directory");
  if (typeof values.imageDigest !== "string" || !OCI_DIGEST.test(values.imageDigest)
      || typeof values.chartDigest !== "string" || !OCI_DIGEST.test(values.chartDigest)) {
    throw new TypeError("Published OCI digests are invalid");
  }
  const manifestPath = canonicalFile(join(releaseDirectory, "release-manifest.json"), "Release manifest");
  let manifest;
  let manifestBytes;
  try {
    const parsed = readManifestDocument(manifestPath);
    const version = stableVersion(parsed.value?.version);
    const commit = sourceCommit(parsed.value?.sourceCommit);
    manifest = validateStagedManifest(parsed.value, version, commit);
    manifestBytes = parsed.bytes;
  } catch {
    throw new Error(FAILURE);
  }
  const records = ["release-manifest.json", "publication-receipt.json"];
  const seen = new Set(records);
  for (const artifact of manifest.artifacts) {
    const path = releaseArtifactPath(releaseDirectory, artifact);
    const relativePath = relative(releaseDirectory, path).split(sep).join("/");
    if (seen.has(relativePath)) throw new Error(FAILURE);
    seen.add(relativePath);
    records.push(relativePath);
  }
  const receipt = {
    schemaVersion: 1,
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    imageDigest: values.imageDigest,
    chartDigest: values.chartDigest,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  };
  const receiptPath = join(releaseDirectory, "publication-receipt.json");
  const receiptBytes = publicationReceiptBytes(receipt);
  try {
    const existing = readFileSync(canonicalFile(receiptPath, "Publication receipt"));
    if (!existing.equals(receiptBytes)) throw new Error();
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") atomicCreate(receiptPath, receiptBytes);
    else if (error instanceof TypeError && error.message.startsWith("Publication receipt")) {
      try {
        lstatSync(receiptPath);
        throw new Error(FAILURE);
      } catch (missing) {
        if (missing?.code !== "ENOENT") throw new Error(FAILURE);
        atomicCreate(receiptPath, receiptBytes);
      }
    } else if (error instanceof Error && error.message === FAILURE) throw error;
    else throw new Error(FAILURE);
  }
  if (digestFile(receiptPath) !== createHash("sha256").update(receiptBytes).digest("hex")) throw new Error(FAILURE);
  records.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const checksums = records.map((relativePath) => `${digestFile(resolve(releaseDirectory, ...relativePath.split("/")))}  ${relativePath}\n`).join("");
  atomicReplace(join(releaseDirectory, "SHA256SUMS"), Buffer.from(checksums, "ascii"));
  return Object.freeze({ files: records.length });
}

function atomicCreate(path, bytes, mode = 0o600) {
  const directory = resolve(path, "..");
  const scratch = join(directory, `.gauntlet-finalize-${randomBytes(16).toString("hex")}`);
  let descriptor;
  let linked = false;
  try {
    descriptor = openSync(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_CLOEXEC, mode);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error();
      offset += count;
    }
    fsyncSync(descriptor);
    chmodSync(scratch, mode);
    linkSync(scratch, path);
    linked = true;
    unlinkSync(scratch);
  } catch {
    try { unlinkSync(scratch); } catch { /* Exact task-owned scratch cleanup only. */ }
    if (linked) {
      try { unlinkSync(path); } catch { /* Best effort only for this invocation's just-created link. */ }
    }
    throw new Error(FAILURE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalDirectory(path, label) {
  try {
    syntacticAbsolutePath(path, label);
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    return path;
  } catch {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(FAILURE);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(FAILURE);
  return value;
}

function releaseArtifactPath(releaseDirectory, record) {
  const relativePath = safeRelativePath(record.path);
  const path = resolve(releaseDirectory, ...relativePath.split("/"));
  if (!path.startsWith(`${releaseDirectory}${sep}`)) throw new Error(FAILURE);
  canonicalFile(path, "Staged release artifact", 16n * 1024n * 1024n * 1024n);
  if (digestFile(path) !== record.sha256) throw new Error(FAILURE);
  return path;
}

function readManifestDocument(manifestPath) {
  const bytes = readFileSync(manifestPath);
  const source = bytes.toString("utf8");
  if (source.includes("\0") || source.includes("\r")) throw new Error(FAILURE);
  const document = parseDocument(source, { json: true, prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length !== 0 || document.warnings.length !== 0) throw new Error(FAILURE);
  return Object.freeze({ bytes, value: JSON.parse(source) });
}

function validateStagedManifest(manifest, version, commit) {
  try {
    const expectedArtifacts = stagedArtifactCatalog(version);
    const expectedPaths = new Map(expectedArtifacts.map((record) => [`${record.kind}\0${record.name}`, record.path]));
    if (expectedPaths.size !== expectedArtifacts.length) throw new Error();
    const manifestKeys = ["schemaVersion", "version", "sourceTag", "sourceCommit", "artifacts"];
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
        || Object.keys(manifest).sort().join("\0") !== manifestKeys.sort().join("\0")
        || manifest.schemaVersion !== 1 || manifest.version !== version || manifest.sourceTag !== `v${version}`
        || manifest.sourceCommit !== commit || !Array.isArray(manifest.artifacts)
        || manifest.artifacts.length !== expectedArtifacts.length) throw new Error();
    const identities = new Set();
    const paths = new Set();
    for (const record of manifest.artifacts) {
      if (record === null || typeof record !== "object" || Array.isArray(record)
          || typeof record.kind !== "string" || typeof record.name !== "string" || typeof record.path !== "string"
          || typeof record.sha256 !== "string" || !SHA256.test(record.sha256)
          || Object.keys(record).sort().join("\0") !== ["kind", "name", "path", "sha256"].sort().join("\0")) throw new Error();
      const identity = `${record.kind}\0${record.name}`;
      if (identities.has(identity) || paths.has(record.path) || expectedPaths.get(identity) !== record.path) throw new Error();
      identities.add(identity);
      paths.add(record.path);
    }
    if ([...expectedPaths.keys()].some((identity) => !identities.has(identity))) throw new Error();
    return manifest;
  } catch {
    throw new Error(FAILURE);
  }
}

function readStagedManifest(releaseDirectory, version, commit) {
  const manifestPath = canonicalFile(join(releaseDirectory, "release-manifest.json"), "Release manifest");
  const parsed = readManifestDocument(manifestPath);
  return Object.freeze({ bytes: parsed.bytes, manifest: validateStagedManifest(parsed.value, version, commit) });
}

function oneArtifact(manifest, kind, name) {
  const matches = manifest.artifacts.filter((record) => record.kind === kind && record.name === name);
  if (matches.length !== 1) throw new Error(FAILURE);
  return matches[0];
}

function finalizedChecksumsBytes(manifest, manifestBytes, receiptBytes) {
  const records = [
    { path: "release-manifest.json", sha256: createHash("sha256").update(manifestBytes).digest("hex") },
    { path: "publication-receipt.json", sha256: createHash("sha256").update(receiptBytes).digest("hex") },
    ...manifest.artifacts.map(({ path, sha256 }) => ({ path, sha256 })),
  ];
  records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return Buffer.from(records.map(({ path, sha256 }) => `${sha256}  ${path}\n`).join(""), "ascii");
}

function releaseAssetHashes(releaseDirectory, version, manifest, manifestBytes, receiptBytes, checksumsBytes) {
  const catalog = githubReleaseAssetCatalog(version);
  const paths = new Map([
    [`gauntlet-compose-${version}.tar.gz`, releaseArtifactPath(
      releaseDirectory,
      oneArtifact(manifest, "compose", RELEASE_ARTIFACTS.compose.name),
    )],
    [`gauntlet-skills-${version}.tgz`, releaseArtifactPath(
      releaseDirectory,
      oneArtifact(manifest, "skills", RELEASE_ARTIFACTS.skills.name),
    )],
    [`gauntlet-${version}.tgz`, releaseArtifactPath(
      releaseDirectory,
      oneArtifact(manifest, "helm", RELEASE_ARTIFACTS.chart.name),
    )],
    [`gauntlet-${version}.provenance.json`, releaseArtifactPath(
      releaseDirectory,
      oneArtifact(manifest, "provenance", `${RELEASE_ARTIFACTS.image.name}@buildkit-unsigned`),
    )],
    ["gauntlet-linux-amd64.spdx.json", releaseArtifactPath(
      releaseDirectory,
      oneArtifact(manifest, "sbom", `${RELEASE_ARTIFACTS.image.name}@linux/amd64`),
    )],
    ["gauntlet-linux-arm64.spdx.json", releaseArtifactPath(
      releaseDirectory,
      oneArtifact(manifest, "sbom", `${RELEASE_ARTIFACTS.image.name}@linux/arm64`),
    )],
  ]);
  const generated = new Map([
    ["release-manifest.json", manifestBytes],
    ["publication-receipt.json", receiptBytes],
    ["SHA256SUMS", checksumsBytes],
  ]);
  const result = Object.create(null);
  for (const { name, maximumBytes } of catalog) {
    const path = paths.get(name);
    const bytes = generated.get(name);
    if ((path === undefined) === (bytes === undefined)) throw new Error(FAILURE);
    if (path !== undefined) {
      const size = lstatSync(path, { bigint: true }).size;
      if (size <= 0n || size > BigInt(maximumBytes)) throw new Error(FAILURE);
      result[name] = digestFile(path);
    } else {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumBytes) throw new Error(FAILURE);
      result[name] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return Object.freeze(result);
}

function githubReleaseEvidence(version, commit, assetHashes) {
  const releaseVersion = stableVersion(version);
  const source = sourceCommit(commit);
  const expected = githubReleaseAssetCatalog(releaseVersion).map(({ name }) => name);
  const hashes = ownData(assetHashes, expected, "GitHub Release asset hashes");
  const assets = expected.map((name) => {
    if (typeof hashes[name] !== "string" || !SHA256.test(hashes[name])) throw new Error(FAILURE);
    return { name, sha256: hashes[name] };
  });
  return createHash("sha256").update(JSON.stringify({ schemaVersion: 1, version: releaseVersion, sourceCommit: source, assets })).digest("hex");
}

function localPublication(releaseDirectory, version, commit, manifestBytes) {
  const path = join(releaseDirectory, "publication-receipt.json");
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(FAILURE);
  }
  const bytes = readFileSync(canonicalFile(path, "Publication receipt", 64n * 1024n));
  const receipt = parsePublicationReceipt(bytes.toString("utf8"), {
    version,
    sourceCommit: commit,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  });
  if (!bytes.equals(publicationReceiptBytes(receipt))) throw new Error(FAILURE);
  return Object.freeze({ receipt, bytes });
}

async function localGithubReleaseEvidence(releaseDirectory, version, commit) {
  const staged = readStagedManifest(releaseDirectory, version, commit);
  for (const artifact of staged.manifest.artifacts) releaseArtifactPath(releaseDirectory, artifact);
  const publication = localPublication(releaseDirectory, version, commit, staged.bytes);
  if (publication === undefined) throw new Error(FAILURE);
  const ociPath = releaseArtifactPath(
    releaseDirectory,
    oneArtifact(staged.manifest, "oci", RELEASE_ARTIFACTS.image.name),
  );
  const stagedImageDigest = await ociLayoutDigest(ociPath);
  if (publication.receipt.imageDigest !== stagedImageDigest) throw new Error(FAILURE);
  const checksumsBytes = readFileSync(canonicalFile(join(releaseDirectory, "SHA256SUMS"), "Release checksums"));
  const expectedChecksums = finalizedChecksumsBytes(staged.manifest, staged.bytes, publication.bytes);
  if (!checksumsBytes.equals(expectedChecksums)) throw new Error(FAILURE);
  return Object.freeze({
    evidence: githubReleaseEvidence(
      version,
      commit,
      releaseAssetHashes(
        releaseDirectory,
        version,
        staged.manifest,
        staged.bytes,
        publication.bytes,
        checksumsBytes,
      ),
    ),
    imageDigest: stagedImageDigest,
  });
}

function commandEnvironment(extra = {}) {
  const path = process.env.PATH;
  const home = process.env.HOME;
  if (typeof path !== "string" || path === "" || path.includes("\0")
      || typeof home !== "string" || !isAbsolute(home) || home.includes("\0")) throw new Error(FAILURE);
  const environment = {
    PATH: path,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
  };
  for (const key of ["DOCKER_CONFIG", "HELM_CONFIG_HOME", "HELM_CACHE_HOME", "HELM_DATA_HOME", "XDG_RUNTIME_DIR"]) {
    if (typeof process.env[key] === "string" && !process.env[key].includes("\0")) environment[key] = process.env[key];
  }
  return Object.freeze({ ...environment, ...extra });
}

async function runReadCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd ?? ROOT,
      env: commandEnvironment(options.environment),
      encoding: options.encoding ?? "utf8",
      timeout: options.timeout ?? 60_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      windowsHide: true,
    });
    return Object.freeze({ ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 });
  } catch (error) {
    if (typeof error?.code === "number") {
      return Object.freeze({
        ok: false,
        stdout: error.stdout ?? (options.encoding === "buffer" ? Buffer.alloc(0) : ""),
        stderr: error.stderr ?? (options.encoding === "buffer" ? Buffer.alloc(0) : ""),
        code: error.code,
      });
    }
    throw new Error(FAILURE);
  }
}

async function composerTreeEvidence(source, version, commit) {
  return withOwnedTemporaryWorkspace({ prefix: "gauntlet-composer-evidence-" }, async (workspace) => {
    const remote = join(workspace, "remote.git");
    const initialized = await runReadCommand("git", ["init", "--bare", "--initial-branch=main", remote], { cwd: workspace });
    if (!initialized.ok) throw new Error(FAILURE);
    await publishComposerPackage({ source, remote: realpathSync(remote), version, sourceCommit: commit, dryRun: false });
    const result = await runReadCommand("git", ["--git-dir", remote, "rev-parse", `v${version}^{tree}`], { cwd: workspace });
    const tree = result.ok ? result.stdout.trim() : "";
    if (!COMMIT.test(tree)) throw new Error(FAILURE);
    return tree;
  });
}

async function consumeManifestTree(binding, consumer) {
  try {
    return await withMaterializedCanonicalTree(binding, consumer);
  } catch {
    throw new Error(FAILURE);
  }
}

async function ociLayoutDigest(path) {
  const result = await runReadCommand("tar", ["-xOf", path, "index.json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (!result.ok || result.stderr !== "") throw new Error(FAILURE);
  return parseOciLayoutIndex(result.stdout);
}

export async function collectReleaseEvidence(options) {
  const values = ownData(options, ["releaseDirectory", "version", "sourceCommit"], "Release evidence options");
  const releaseDirectory = canonicalDirectory(values.releaseDirectory, "Release directory");
  const version = stableVersion(values.version);
  const commit = sourceCommit(values.sourceCommit);
  const staged = readStagedManifest(releaseDirectory, version, commit);
  const manifest = staged.manifest;
  const manifestBytes = staged.bytes;
  for (const artifact of manifest.artifacts) releaseArtifactPath(releaseDirectory, artifact);
  const result = Object.create(null);

  for (const template of PUBLISHED_DESTINATIONS.filter(({ kind }) => kind === "npm")) {
    const artifact = RELEASE_ARTIFACTS.npm.find(({ name }) => `npm:${name.slice("@8lines/gauntlet-".length)}` === template.id);
    if (artifact === undefined) throw new Error(FAILURE);
    const path = releaseArtifactPath(releaseDirectory, oneArtifact(manifest, "npm", artifact.name));
    result[template.id] = `sha512-${hashFile(path, "sha512", "base64")}`;
  }

  for (const template of PUBLISHED_DESTINATIONS.filter(({ kind }) => kind === "maven")) {
    const artifact = RELEASE_ARTIFACTS.maven.find(({ name }) => `maven:${name.split(":")[1]}` === template.id);
    if (artifact === undefined) throw new Error(FAILURE);
    const record = oneArtifact(manifest, "maven", artifact.name);
    const archivePath = releaseArtifactPath(releaseDirectory, record);
    const artifactId = artifact.name.split(":")[1];
    const expectedPrefix = `gauntlet-${artifactId}-${version}`;
    result[template.id] = await consumeManifestTree({
      archivePath,
      expectedPrefix,
      expectedSha256: record.sha256,
    }, (source) => digestFile(canonicalFile(
      resolve(source, `${artifactId}-${version}.jar`),
      "Materialized Maven binary",
      512n * 1024n * 1024n,
    )));
  }

  const ociPath = releaseArtifactPath(
    releaseDirectory,
    oneArtifact(manifest, "oci", RELEASE_ARTIFACTS.image.name),
  );
  const imageDigest = await ociLayoutDigest(ociPath);
  const localFinalization = localPublication(releaseDirectory, version, commit, manifestBytes);
  const remotePublication = await publishedReceipt(version, commit, manifestBytes);
  if (localFinalization !== undefined && remotePublication !== undefined
      && !localFinalization.bytes.equals(remotePublication.bytes)) throw new Error(FAILURE);
  const publication = localFinalization ?? remotePublication;
  const publishedImageDigest = process.env.GAUNTLET_EXPECTED_IMAGE_DIGEST;
  if (publishedImageDigest !== undefined && !OCI_DIGEST.test(publishedImageDigest)) throw new Error(FAILURE);
  if (publishedImageDigest !== undefined && publishedImageDigest !== imageDigest) throw new Error(FAILURE);
  if (publication !== undefined && publication.receipt.imageDigest !== imageDigest) throw new Error(FAILURE);
  const expectedImageDigest = imageDigest;
  result["image:semantic"] = expectedImageDigest;
  result["image:commit"] = expectedImageDigest;

  const chartPath = releaseArtifactPath(
    releaseDirectory,
    oneArtifact(manifest, "helm", RELEASE_ARTIFACTS.chart.name),
  );
  const chartSha256 = digestFile(chartPath);
  result["chart:semantic"] = chartSha256;
  const publishedChartDigest = process.env.GAUNTLET_EXPECTED_CHART_DIGEST;
  if (publishedChartDigest !== undefined && !OCI_DIGEST.test(publishedChartDigest)) throw new Error(FAILURE);
  if (publishedChartDigest !== undefined && publication !== undefined
      && publishedChartDigest !== publication.receipt.chartDigest) throw new Error(FAILURE);

  for (const artifact of RELEASE_ARTIFACTS.composer) {
    const record = oneArtifact(manifest, "composer", artifact.name);
    const archivePath = releaseArtifactPath(releaseDirectory, record);
    const id = `composer:${artifact.name.slice("8lines/gauntlet-".length)}`;
    const expectedPrefix = `${artifact.repository.split("/").at(-1)}-${version}`;
    result[id] = await consumeManifestTree({
      archivePath,
      expectedPrefix,
      expectedSha256: record.sha256,
    }, (source) => composerTreeEvidence(source, version, commit));
  }
  const receipt = publication?.receipt ?? Object.freeze({
    schemaVersion: 1,
    version,
    sourceCommit: commit,
    imageDigest: expectedImageDigest,
    chartDigest: publishedChartDigest ?? `sha256:${chartSha256}`,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  });
  const receiptBytes = publication?.bytes ?? publicationReceiptBytes(receipt);
  const expectedChecksumsBytes = finalizedChecksumsBytes(manifest, manifestBytes, receiptBytes);
  let checksumsBytes = expectedChecksumsBytes;
  if (localFinalization !== undefined) {
    checksumsBytes = readFileSync(canonicalFile(join(releaseDirectory, "SHA256SUMS"), "Release checksums"));
    if (!checksumsBytes.equals(expectedChecksumsBytes)) throw new Error(FAILURE);
  }
  result["github:release"] = githubReleaseEvidence(
    version,
    commit,
    releaseAssetHashes(releaseDirectory, version, manifest, manifestBytes, receiptBytes, checksumsBytes),
  );
  return exactEvidence(result, commit);
}

function validatedToken(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 20 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Remote probe requires ${name}`);
  }
  return value;
}

async function boundedResponseText(response) {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 8 * 1024 * 1024)) throw new Error(FAILURE);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024 || bytes.includes(0x00)) throw new Error(FAILURE);
  return bytes.toString("utf8");
}

async function githubJson(path, token) {
  if (typeof path !== "string" || !path.startsWith("/repos/8lines/") || path.includes("..") || path.includes("\0")) {
    throw new Error(FAILURE);
  }
  const response = await fetch(`https://api.github.com${path}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "8lines-gauntlet-release",
    },
  });
  if (response.status === 404) return Object.freeze({ state: "absent" });
  if (response.status !== 200) throw new Error(FAILURE);
  try {
    return Object.freeze({ state: "present", value: JSON.parse(await boundedResponseText(response)) });
  } catch {
    throw new Error(FAILURE);
  }
}

async function githubDraftByTag(version, token) {
  // GitHub's release-by-tag endpoint omits drafts and returns 404 for them.
  // Authenticated list releases includes drafts, so use it for the pre-publication gate.
  const listing = await githubJson("/repos/8lines/gauntlet/releases?per_page=100", token);
  if (listing.state !== "present") return listing;
  if (!Array.isArray(listing.value)) throw new Error(FAILURE);
  const matches = listing.value.filter((release) => release?.tag_name === `v${version}`);
  if (matches.length > 1) throw new Error(FAILURE);
  return matches.length === 0
    ? Object.freeze({ state: "absent" })
    : Object.freeze({ state: "present", value: matches[0] });
}

function allowedGithubAssetUrl(url) {
  if (!(url instanceof URL) || url.protocol !== "https:" || url.username !== "" || url.password !== ""
      || url.port !== "" || url.hash !== "") return false;
  if (url.hostname === "api.github.com") {
    return /^\/repos\/8lines\/gauntlet\/releases\/assets\/[1-9][0-9]*$/u.test(url.pathname);
  }
  return url.hostname === "objects.githubusercontent.com" || url.hostname.endsWith(".githubusercontent.com");
}

async function downloadGithubReleaseAsset(assetId, token, maximumBytes, captureBytes = false) {
  try {
    if (!Number.isSafeInteger(assetId) || assetId <= 0 || typeof maximumBytes !== "number"
        || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || typeof captureBytes !== "boolean") throw new Error();
    let url = new URL(`https://api.github.com/repos/8lines/gauntlet/releases/assets/${assetId}`);
    for (let redirects = 0; redirects <= GITHUB_ASSET_REDIRECTS; redirects += 1) {
      if (!allowedGithubAssetUrl(url)) throw new Error();
      const headers = {
        Accept: "application/octet-stream",
        "Accept-Encoding": "identity",
        "User-Agent": "8lines-gauntlet-release",
      };
      if (url.hostname === "api.github.com") {
        headers.Authorization = `Bearer ${token}`;
        headers["X-GitHub-Api-Version"] = GITHUB_API_VERSION;
      }
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === GITHUB_ASSET_REDIRECTS) throw new Error();
        const location = response.headers.get("location");
        if (typeof location !== "string" || location === "") throw new Error();
        const next = new URL(location, url);
        if (!allowedGithubAssetUrl(next)) throw new Error();
        url = next;
        continue;
      }
      if (response.status !== 200 || response.body === null || typeof response.body.getReader !== "function") throw new Error();
      const contentEncoding = response.headers.get("content-encoding");
      if (contentEncoding !== null && contentEncoding !== "identity") throw new Error();
      const declared = response.headers.get("content-length");
      let declaredBytes;
      if (declared !== null) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) throw new Error();
        declaredBytes = BigInt(declared);
        if (declaredBytes <= 0n || declaredBytes > BigInt(maximumBytes)) throw new Error();
      }
      const reader = response.body.getReader();
      const hash = createHash("sha256");
      const chunks = [];
      let bytesRead = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array) || chunk.value.length === 0) throw new Error();
          bytesRead += chunk.value.length;
          if (!Number.isSafeInteger(bytesRead) || bytesRead > maximumBytes) throw new Error();
          hash.update(chunk.value);
          if (captureBytes) chunks.push(Buffer.from(chunk.value));
        }
      } catch {
        try { await reader.cancel(); } catch { /* The bounded read has already failed closed. */ }
        throw new Error();
      }
      if (bytesRead === 0 || (declaredBytes !== undefined && BigInt(bytesRead) !== declaredBytes)) throw new Error();
      return Object.freeze({
        sha256: hash.digest("hex"),
        bytes: captureBytes ? Buffer.concat(chunks, bytesRead) : undefined,
      });
    }
    throw new Error();
  } catch {
    throw new Error(FAILURE);
  }
}

async function publishedReceipt(version, commit, manifestBytes) {
  if (process.env.GAUNTLET_USE_REMOTE_RECEIPT !== "true") return undefined;
  const token = validatedToken("GH_TOKEN");
  const release = await githubJson(`/repos/8lines/gauntlet/releases/tags/v${version}`, token);
  if (release.state === "absent") return undefined;
  if (release.value?.tag_name !== `v${version}` || release.value?.draft !== false || release.value?.prerelease !== false
      || release.value?.immutable !== true || !Array.isArray(release.value?.assets)) throw new Error(FAILURE);
  const assets = parseReleaseAssets(release.value.assets, version);
  const downloaded = await downloadGithubReleaseAsset(
    assets["publication-receipt.json"],
    token,
    githubReleaseAssetCatalog(version).find(({ name }) => name === "publication-receipt.json").maximumBytes,
    true,
  );
  const source = downloaded.bytes.toString("utf8");
  const receipt = parsePublicationReceipt(source, {
    version,
    sourceCommit: commit,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  });
  if (!downloaded.bytes.equals(publicationReceiptBytes(receipt))) throw new Error(FAILURE);
  return Object.freeze({ receipt, bytes: downloaded.bytes });
}

async function githubTagCommit(repository, tag, token) {
  const repositoryAccess = await githubJson(`/repos/8lines/${repository}`, token);
  if (repositoryAccess.state !== "present") throw new Error(FAILURE);
  const reference = await githubJson(`/repos/8lines/${repository}/git/ref/tags/${tag}`, token);
  if (reference.state === "absent") return reference;
  let object = reference.value?.object;
  if (object?.type === "tag" && COMMIT.test(object.sha)) {
    const annotated = await githubJson(`/repos/8lines/${repository}/git/tags/${object.sha}`, token);
    if (annotated.state !== "present") throw new Error(FAILURE);
    object = annotated.value?.object;
  }
  if (object?.type !== "commit" || !COMMIT.test(object.sha)) throw new Error(FAILURE);
  return Object.freeze({ state: "present", commit: object.sha });
}

function missingRegistryCommand(result) {
  if (result.ok || typeof result.stderr !== "string" || result.stderr.length > 1024 * 1024) return false;
  return /(?:manifest unknown|not found|does not exist|no such manifest|404)/iu.test(result.stderr);
}

async function probeNpm(check) {
  const template = PUBLISHED_DESTINATIONS.find(({ id }) => id === check.id);
  // The public npm registry serves published version metadata without authentication.
  const encodedName = template.target.replace("/", "%2F");
  const response = await fetch(`https://registry.npmjs.org/${encodedName}/${check.version}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/json",
      "User-Agent": "8lines-gauntlet-release",
    },
  });
  if (response.status === 404) return { id: check.id, state: "absent" };
  if (response.status !== 200) throw new Error(FAILURE);
  let metadata;
  try { metadata = JSON.parse(await boundedResponseText(response)); } catch { throw new Error(FAILURE); }
  const integrity = metadata?.dist?.integrity;
  if (typeof integrity !== "string" || !NPM_INTEGRITY.test(integrity)) throw new Error(FAILURE);
  return { id: check.id, state: "present", evidence: integrity };
}

async function probeMaven(check) {
  const actor = process.env.GITHUB_ACTOR;
  const token = validatedToken("GH_TOKEN");
  if (typeof actor !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(actor)) throw new Error(FAILURE);
  const artifactId = check.id.slice("maven:".length);
  const url = `${check.destination}/${artifactId}-${check.version}.jar`;
  let response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Basic ${Buffer.from(`${actor}:${token}`, "utf8").toString("base64")}`,
      "User-Agent": "8lines-gauntlet-release",
    },
  });
  if (response.status === 404) return { id: check.id, state: "absent" };
  // GitHub Packages answers an existing file with one redirect to a pre-signed
  // githubusercontent.com URL; follow exactly that hop, without the credential.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (typeof location !== "string" || location === "") throw new Error(FAILURE);
    const next = new URL(location, url);
    if (next.protocol !== "https:" || next.username !== "" || next.password !== "" || next.port !== ""
        || !next.hostname.endsWith(".githubusercontent.com")) throw new Error(FAILURE);
    response = await fetch(next, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "8lines-gauntlet-release" },
    });
  }
  if (response.status !== 200) throw new Error(FAILURE);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 512 * 1024 * 1024) throw new Error(FAILURE);
  return { id: check.id, state: "present", evidence: createHash("sha256").update(bytes).digest("hex") };
}

async function probeImage(check) {
  const inspected = await runReadCommand("docker", ["buildx", "imagetools", "inspect", check.destination]);
  if (!inspected.ok) {
    if (missingRegistryCommand(inspected)) return { id: check.id, state: "absent" };
    throw new Error(FAILURE);
  }
  return { id: check.id, state: "present", evidence: parseImageInspection(inspected.stdout) };
}

async function probeChart(check) {
  return withOwnedTemporaryWorkspace({ prefix: "gauntlet-chart-probe-" }, async (workspace) => {
    const suffix = `:${check.version}`;
    if (!check.destination.endsWith(suffix)) throw new Error(FAILURE);
    const source = check.destination.slice(0, -suffix.length);
    const pulled = await runReadCommand("helm", ["pull", source, "--version", check.version, "--destination", workspace]);
    if (!pulled.ok) {
      if (missingRegistryCommand(pulled)) return { id: check.id, state: "absent" };
      throw new Error(FAILURE);
    }
    const path = canonicalFile(join(workspace, `gauntlet-${check.version}.tgz`), "Pulled Helm chart");
    return { id: check.id, state: "present", evidence: digestFile(path) };
  });
}

function anonymousGitEnvironment(workspace) {
  // The split repositories are public: reads use anonymous HTTPS with every credential source disabled.
  return Object.freeze({
    HOME: workspace,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  });
}

async function probeComposer(check) {
  const template = PUBLISHED_DESTINATIONS.find(({ id }) => id === check.id);
  const artifact = RELEASE_ARTIFACTS.composer.find(({ repositoryUrl }) => repositoryUrl === template.target);
  if (artifact === undefined || artifact.repositoryUrl !== `https://github.com/${artifact.repository}.git`) {
    throw new Error(FAILURE);
  }
  const reference = `refs/tags/v${check.version}`;
  return withOwnedTemporaryWorkspace({ prefix: "gauntlet-composer-probe-" }, async (workspace) => {
    const environment = anonymousGitEnvironment(workspace);
    const listed = await runReadCommand("git", ["ls-remote", "--refs", artifact.repositoryUrl, reference], {
      cwd: workspace,
      environment,
    });
    if (!listed.ok) throw new Error(FAILURE);
    if (listed.stdout === "") return { id: check.id, state: "absent" };
    const match = /^([0-9a-f]{40})\t(refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+)\n$/u.exec(listed.stdout);
    if (match === null || match[2] !== reference) throw new Error(FAILURE);
    const repository = join(workspace, "probe.git");
    const steps = [
      ["init", "--bare", "--initial-branch=main", repository],
      ["--git-dir", repository, "fetch", "--no-tags", "--depth=1", artifact.repositoryUrl, `+${reference}:${reference}`],
    ];
    for (const args of steps) {
      const result = await runReadCommand("git", args, { cwd: workspace, environment, timeout: 120_000 });
      if (!result.ok) throw new Error(FAILURE);
    }
    const tagged = await runReadCommand("git", ["--git-dir", repository, "rev-parse", reference], { cwd: workspace, environment });
    const tree = await runReadCommand("git", ["--git-dir", repository, "rev-parse", `${reference}^{tree}`], {
      cwd: workspace,
      environment,
    });
    const observedTree = tree.ok ? tree.stdout.trim() : "";
    if (!tagged.ok || tagged.stdout.trim() !== match[1] || !COMMIT.test(observedTree)) throw new Error(FAILURE);
    return { id: check.id, state: "present", evidence: observedTree };
  });
}

async function probeGithubRelease(check, expectedDraft) {
  const token = validatedToken("GH_TOKEN");
  const repositoryAccess = await githubJson("/repos/8lines/gauntlet", token);
  if (repositoryAccess.state !== "present") throw new Error(FAILURE);
  const release = expectedDraft
    ? await githubDraftByTag(check.version, token)
    : await githubJson(`/repos/8lines/gauntlet/releases/tags/v${check.version}`, token);
  if (release.state === "absent") return { id: check.id, state: "absent" };
  if (release.value?.tag_name !== `v${check.version}` || release.value?.draft !== expectedDraft
      || release.value?.prerelease !== false || release.value?.immutable !== !expectedDraft) {
    throw new Error(FAILURE);
  }
  const assets = parseReleaseAssets(release.value?.assets, check.version);
  const downloads = await Promise.allSettled(githubReleaseAssetCatalog(check.version).map(async ({ name, maximumBytes }) => {
    const downloaded = await downloadGithubReleaseAsset(assets[name], token, maximumBytes);
    return Object.freeze({ name, sha256: downloaded.sha256 });
  }));
  if (downloads.some(({ status }) => status === "rejected")) throw new Error(FAILURE);
  const hashes = Object.fromEntries(downloads.map(({ value }) => [value.name, value.sha256]));
  const tagged = await githubTagCommit("gauntlet", `v${check.version}`, token);
  if (tagged.state !== "present") throw new Error(FAILURE);
  return { id: check.id, state: "present", evidence: githubReleaseEvidence(check.version, tagged.commit, hashes) };
}

async function probeRelease(check) {
  return probeGithubRelease(check, false);
}

async function probeDraftRelease(check) {
  return probeGithubRelease(check, true);
}

export async function probeRemoteDestination(check) {
  let validated;
  try {
    const values = ownData(check, ["id", "kind", "destination", "expectedEvidence", "version"], "Remote probe check");
    const template = PUBLISHED_DESTINATIONS.find(({ id }) => id === values.id);
    const version = stableVersion(values.version);
    if (template === undefined || values.kind !== template.kind || typeof values.destination !== "string") throw new Error();
    const semanticDestination = destinationUrl(template, version, "0".repeat(40));
    const destinationMatches = template.id === "image:commit"
      ? new RegExp(`^${template.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:sha-[0-9a-f]{12}$`, "u").test(values.destination)
      : values.destination === semanticDestination;
    const evidenceMatches = template.kind === "npm" ? NPM_INTEGRITY.test(values.expectedEvidence)
      : template.kind === "image" ? OCI_DIGEST.test(values.expectedEvidence)
        : template.kind === "composer" ? COMMIT.test(values.expectedEvidence)
          : SHA256.test(values.expectedEvidence);
    if (!destinationMatches || !evidenceMatches) throw new Error();
    validated = Object.freeze({ ...values, version });
  } catch {
    throw new TypeError("Remote probe check is invalid");
  }
  switch (validated.kind) {
    case "npm": return probeNpm(validated);
    case "maven": return probeMaven(validated);
    case "image": return probeImage(validated);
    case "chart": return probeChart(validated);
    case "composer": return probeComposer(validated);
    case "release": return probeRelease(validated);
    default: throw new Error(FAILURE);
  }
}

const CLI_USAGE = "Usage: check-published.mjs --release-directory ABSOLUTE_PATH --version X.Y.Z --source-commit SHA [--require-identical|--require-draft-identical] | --finalize ABSOLUTE_PATH --image-digest sha256:... --chart-digest sha256:...";

export function parsePublishedArguments(argv) {
  try {
    if (!Array.isArray(argv)) throw new Error();
    if (argv.length === 7
        && argv[0] === "--release-directory" && argv[2] === "--version" && argv[4] === "--source-commit"
        && argv[6] === "--require-draft-identical") {
      return Object.freeze({
        command: "verify-draft",
        releaseDirectory: syntacticAbsolutePath(argv[1], "Release directory"),
        version: stableVersion(argv[3]),
        sourceCommit: sourceCommit(argv[5]),
      });
    }
    if ((argv.length === 6 || argv.length === 7)
        && argv[0] === "--release-directory" && argv[2] === "--version" && argv[4] === "--source-commit"
        && (argv.length === 6 || argv[6] === "--require-identical")) {
      return Object.freeze({
        command: "check",
        releaseDirectory: syntacticAbsolutePath(argv[1], "Release directory"),
        version: stableVersion(argv[3]),
        sourceCommit: sourceCommit(argv[5]),
        requireIdentical: argv.length === 7,
      });
    }
    if (argv.length === 6 && argv[0] === "--finalize" && argv[2] === "--image-digest" && argv[4] === "--chart-digest"
        && typeof argv[3] === "string" && OCI_DIGEST.test(argv[3])
        && typeof argv[5] === "string" && OCI_DIGEST.test(argv[5])) {
      return Object.freeze({
        command: "finalize",
        releaseDirectory: syntacticAbsolutePath(argv[1], "Release directory"),
        imageDigest: argv[3],
        chartDigest: argv[5],
      });
    }
    throw new Error();
  } catch {
    throw new TypeError(CLI_USAGE);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = parsePublishedArguments(process.argv.slice(2));
    if (command.command === "finalize") {
      const result = writePublicationReceipt({
        releaseDirectory: command.releaseDirectory,
        imageDigest: command.imageDigest,
        chartDigest: command.chartDigest,
      });
      process.stdout.write(`${JSON.stringify({ command: "finalize", ...result })}\n`);
    } else if (command.command === "verify-draft") {
      const state = await checkDraftReleasePublication({
        releaseDirectory: command.releaseDirectory,
        version: command.version,
        sourceCommit: command.sourceCommit,
      });
      process.stdout.write(`${JSON.stringify({ command: "verify-draft", assets: 9, state })}\n`);
    } else {
      const state = await checkReleasePublication({
        releaseDirectory: command.releaseDirectory,
        version: command.version,
        sourceCommit: command.sourceCommit,
        requireIdentical: command.requireIdentical,
      });
      process.stdout.write(`${JSON.stringify({ command: "check", destinations: PUBLISHED_DESTINATIONS.length, state })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : FAILURE}\n`);
    process.exitCode = 1;
  }
}
