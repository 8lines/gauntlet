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
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, types as utilTypes } from "node:util";

import { parseDocument } from "yaml";

import { withMaterializedCanonicalTree, withOwnedTemporaryWorkspace } from "./archive-consumer.mjs";
import { createReleaseManifest, expectedReleaseArtifacts, expectedUnitArtifacts, readReleaseManifest } from "./inventory.mjs";
import { parseReleaseSetId } from "./plan.mjs";
import { parseReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";
import { publishComposerPackage } from "./publish-composer.mjs";
import { unitById, unitTag } from "./units.mjs";

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
const MIB = 1024 * 1024;
const GITHUB_RELEASES = "https://github.com/8lines/gauntlet/releases/tag";
// Every staged kind a unit attaches to its GitHub Release; `docker` and `oci` image archives never are.
const RELEASE_ASSET_LIMITS = new Map([
  ["npm", 64 * MIB],
  ["composer", 64 * MIB],
  ["maven", 512 * MIB],
  ["skills", 64 * MIB],
  ["compose", 512 * MIB],
  ["helm", 64 * MIB],
  ["provenance", 16 * MIB],
  ["sbom", 128 * MIB],
]);
const GENERATED_ASSETS = Object.freeze([
  Object.freeze({ name: "release-manifest.json", maximumBytes: MIB }),
  Object.freeze({ name: "publication-receipt.json", maximumBytes: 64 * 1024 }),
  Object.freeze({ name: "SHA256SUMS", maximumBytes: MIB }),
]);
const RECEIPT_KEYS = Object.freeze(["schemaVersion", "releaseSet", "unit", "version", "sourceCommit", "manifestSha256"]);
const DIGEST_KEYS = Object.freeze(["imageDigest", "chartDigest"]);
const CHECK_KEYS = Object.freeze(["id", "unit", "kind", "destination", "expectedEvidence", "version", "tag"]);
const PLAN_INVALID = "Published unit check plan is invalid";

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function githubReleaseAssetCatalog(unitId, version) {
  const records = [
    ...expectedUnitArtifacts(unitId, stableVersion(version))
      .filter(({ kind }) => RELEASE_ASSET_LIMITS.has(kind))
      .map(({ kind, path }) => Object.freeze({ name: path.split("/").at(-1), maximumBytes: RELEASE_ASSET_LIMITS.get(kind) })),
    ...GENERATED_ASSETS,
  ];
  if (new Set(records.map(({ name }) => name)).size !== records.length) throw new Error(FAILURE);
  return Object.freeze(records);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestUnit(manifest, unitId) {
  const matches = Array.isArray(manifest?.units) ? manifest.units.filter((entry) => entry?.id === unitId) : [];
  if (matches.length !== 1) throw new TypeError(`Release unit ${String(unitId)} is not in the release manifest`);
  return matches[0];
}

export function unitReleaseManifest(manifest, unitId) {
  const entry = manifestUnit(manifest, unitId);
  return createReleaseManifest({
    releaseSet: manifest.releaseSet,
    sourceCommit: manifest.sourceCommit,
    units: [entry],
    artifacts: manifest.artifacts.filter((artifact) => artifact.unit === entry.id),
  });
}

function unitManifestBytes(manifest, unitId) {
  return Buffer.from(`${JSON.stringify(unitReleaseManifest(manifest, unitId), null, 2)}\n`, "utf8");
}

export function unitReleaseAssets(manifest, unitId) {
  const entry = manifestUnit(manifest, unitId);
  const catalog = githubReleaseAssetCatalog(entry.id, entry.version);
  const paths = [
    ...manifest.artifacts
      .filter((artifact) => artifact.unit === entry.id && RELEASE_ASSET_LIMITS.has(artifact.kind))
      .map(({ path }) => path),
    ...GENERATED_ASSETS.map(({ name }) => `units/${entry.id}/${name}`),
  ];
  if (paths.length !== catalog.length) throw new Error(FAILURE);
  return Object.freeze(catalog.map(({ name, maximumBytes }, index) => {
    if (typeof paths[index] !== "string" || paths[index].split("/").at(-1) !== name) throw new Error(FAILURE);
    return Object.freeze({ name, maximumBytes, path: paths[index] });
  }));
}

function evidencePattern(kind) {
  return kind === "npm" ? NPM_INTEGRITY : kind === "image" ? OCI_DIGEST : kind === "composer" ? COMMIT : SHA256;
}

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

function receiptKeys(unitId) {
  return unitId === "gauntlet" ? [...RECEIPT_KEYS, ...DIGEST_KEYS] : RECEIPT_KEYS;
}

function publicationReceiptBytes(receipt) {
  const keys = receiptKeys(receipt.unit);
  return Buffer.from(`${JSON.stringify(Object.fromEntries(keys.map((key) => [key, receipt[key]])), null, 2)}\n`, "utf8");
}

export function parsePublicationReceipt(source, expected) {
  try {
    const values = ownData(
      expected,
      ["releaseSet", "unit", "version", "sourceCommit", "manifestSha256"],
      "Publication receipt expectation",
    );
    const commit = sourceCommit(values.sourceCommit);
    const releaseSet = parseReleaseSetId(values.releaseSet, commit);
    const unit = unitById(values.unit);
    const version = stableVersion(values.version);
    if (typeof values.manifestSha256 !== "string" || !SHA256.test(values.manifestSha256)
        || typeof source !== "string" || Buffer.byteLength(source) === 0 || Buffer.byteLength(source) > 64 * 1024
        || source.includes("\0") || source.includes("\r")) throw new Error();
    const document = parseDocument(source, { json: true, prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length !== 0 || document.warnings.length !== 0) throw new Error();
    const receipt = JSON.parse(source);
    const keys = receiptKeys(unit.id);
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)
        || Object.keys(receipt).length !== keys.length || keys.some((key) => !Object.hasOwn(receipt, key))
        || receipt.schemaVersion !== 2 || receipt.releaseSet !== releaseSet || receipt.unit !== unit.id
        || receipt.version !== version || receipt.sourceCommit !== commit
        || receipt.manifestSha256 !== values.manifestSha256) throw new Error();
    if (unit.id === "gauntlet"
        && DIGEST_KEYS.some((key) => typeof receipt[key] !== "string" || !OCI_DIGEST.test(receipt[key]))) throw new Error();
    const result = Object.freeze(Object.fromEntries(keys.map((key) => [key, receipt[key]])));
    if (!Buffer.from(source, "utf8").equals(publicationReceiptBytes(result))) throw new Error();
    return result;
  } catch {
    throw new Error("Remote publication receipt failed closed");
  }
}

export function parseReleaseAssets(assets, unitId, releaseVersion) {
  try {
    const expected = githubReleaseAssetCatalog(unitId, releaseVersion).map(({ name }) => name);
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
    default:
      throw new Error(FAILURE);
  }
}

export function unitDestinations(unitId) {
  const unit = unitById(unitId);
  const name = unit.artifacts[0];
  const records = unit.kind === "npm" ? [{ id: `npm:${name.slice("@8lines/gauntlet-".length)}`, kind: "npm", target: name }]
    : unit.kind === "composer" ? [{
      id: `composer:${name.slice("8lines/gauntlet-".length)}`,
      kind: "composer",
      target: RELEASE_ARTIFACTS.composer.find((artifact) => artifact.name === name).repositoryUrl,
    }]
      : unit.kind === "maven" ? [{ id: `maven:${name.split(":")[1]}`, kind: "maven", target: name }]
        : unit.kind === "application" ? [
          { id: "image:semantic", kind: "image", target: RELEASE_ARTIFACTS.image.name },
          { id: "image:commit", kind: "image", target: RELEASE_ARTIFACTS.image.name },
          { id: "chart:semantic", kind: "chart", target: RELEASE_ARTIFACTS.chart.repository },
        ]
          : [];
  return Object.freeze(records.map((record) => Object.freeze(record)));
}

function unitTemplates(unitId, tag) {
  return [...unitDestinations(unitId), Object.freeze({ id: `github:${tag}`, kind: "release", target: GITHUB_RELEASES })];
}

function unitDestinationUrl(template, version, commit, tag) {
  return template.kind === "release" ? `${template.target}/${tag}` : destinationUrl(template, version, commit);
}

export function createUnitCheckPlan(options) {
  const values = ownData(options, ["unit", "version", "sourceCommit", "evidence"], "Unit check plan options");
  const unit = unitById(values.unit);
  const version = stableVersion(values.version);
  const commit = sourceCommit(values.sourceCommit);
  const tag = unitTag(unit, version);
  const templates = unitTemplates(unit.id, tag);
  const evidence = ownData(values.evidence, templates.map(({ id }) => id), "Unit evidence");
  return Object.freeze(templates.map((template) => {
    const expectedEvidence = evidence[template.id];
    if (typeof expectedEvidence !== "string" || !evidencePattern(template.kind).test(expectedEvidence)) {
      throw new TypeError(`Published evidence for ${template.id} is invalid`);
    }
    return Object.freeze({
      id: template.id, unit: unit.id, kind: template.kind,
      destination: unitDestinationUrl(template, version, commit, tag), expectedEvidence, version, tag,
    });
  }));
}

// Validates one check against its unit's templates: exact keys, a known unit, the unit's own tag,
// a known destination id and kind, the canonical destination URL and well-formed evidence.
function validatedCheck(candidate) {
  const values = ownData(candidate, CHECK_KEYS, "Published unit check");
  const unit = unitById(values.unit);
  const version = stableVersion(values.version);
  const tag = unitTag(unit, version);
  if (values.tag !== tag) throw new Error(PLAN_INVALID);
  const template = unitTemplates(unit.id, tag).find(({ id }) => id === values.id);
  if (template === undefined || values.kind !== template.kind || typeof values.destination !== "string"
      || typeof values.expectedEvidence !== "string" || !evidencePattern(template.kind).test(values.expectedEvidence)) {
    throw new Error(PLAN_INVALID);
  }
  const destinationMatches = template.id === "image:commit"
    ? new RegExp(`^${template.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:sha-[0-9a-f]{12}$`, "u").test(values.destination)
    : values.destination === unitDestinationUrl(template, version, "0".repeat(40), tag);
  if (!destinationMatches) throw new Error(PLAN_INVALID);
  return Object.freeze({ ...values, version });
}

function assertUnitChecks(checks) {
  try {
    if (!Array.isArray(checks) || utilTypes.isProxy(checks) || !Object.isFrozen(checks) || checks.length === 0) {
      throw new Error();
    }
    const validated = Array.from(checks, (check) => {
      if (utilTypes.isProxy(check) || !Object.isFrozen(check)) throw new Error();
      return validatedCheck(check);
    });
    const { unit, version, tag } = validated[0];
    const templates = unitTemplates(unit, tag);
    if (validated.length !== templates.length || validated.some((check, index) => check.unit !== unit
        || check.version !== version || check.tag !== tag || check.id !== templates[index].id)) throw new Error();
  } catch {
    throw new TypeError(PLAN_INVALID);
  }
  return checks;
}

function assertUnitPlans(plans) {
  if (!Array.isArray(plans) || utilTypes.isProxy(plans) || plans.length === 0) throw new TypeError(PLAN_INVALID);
  const checked = Array.from(plans, (checks) => assertUnitChecks(checks));
  if (new Set(checked.map((checks) => checks[0].unit)).size !== checked.length) throw new TypeError(PLAN_INVALID);
  return checked;
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

export function evaluateUnitState(checks, observations) {
  assertUnitChecks(checks);
  if (!Array.isArray(observations) || utilTypes.isProxy(observations) || observations.length !== checks.length) {
    throw new Error("Remote probes did not return a complete observation set");
  }
  const byId = new Map();
  for (const candidate of observations) {
    const expected = checks.find((check) => check.id === candidate?.id);
    if (expected === undefined || byId.has(expected.id)) throw new Error("Remote probes did not return a complete observation set");
    byId.set(expected.id, observationValue(candidate, expected));
  }
  const ordered = checks.map(({ id }) => byId.get(id));
  const present = ordered.filter(({ state }) => state === "present");
  if (present.length === 0) return "clean";
  for (const [index, observation] of ordered.entries()) {
    if (observation.state === "present" && observation.evidence !== checks[index].expectedEvidence) {
      throw new Error(`Remote destination ${observation.id} has different evidence`);
    }
  }
  if (present.length !== checks.length) throw new Error(`Release unit ${checks[0].unit} is partially published`);
  return "already-identical";
}

export function evaluateReleaseSetState(plans, observations) {
  const checked = assertUnitPlans(plans);
  if (!Array.isArray(observations) || utilTypes.isProxy(observations)
      || observations.length !== checked.reduce((total, checks) => total + checks.length, 0)) {
    throw new Error("Remote probes did not return a complete observation set");
  }
  return Object.freeze(checked.map((checks) => {
    const ids = new Set(checks.map(({ id }) => id));
    const state = evaluateUnitState(checks, observations.filter((observation) => ids.has(observation?.id)));
    return Object.freeze({ id: checks[0].unit, state });
  }));
}

export async function checkUnitDestinations(options) {
  const values = ownData(options, ["plans", "probe"], "Published unit check options");
  if (typeof values.probe !== "function") throw new TypeError("Published destination probe must be a function");
  // Every plan, including duplicate units, is rejected before the first probe runs.
  const plans = assertUnitPlans(values.plans);
  const checks = plans.flat();
  const settled = await Promise.allSettled(checks.map((check) => Promise.resolve().then(() => values.probe(check))));
  const failure = settled.find(({ status }) => status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return evaluateReleaseSetState(plans, settled.map(({ value }) => value));
}

async function collectRemoteObservations(plan, probe) {
  const settled = await Promise.allSettled(plan.map((check) => Promise.resolve().then(() => probe(check))));
  const failure = settled.find(({ status }) => status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return settled.map(({ value }) => value);
}

function evaluatePublishedArtifactsBeforeRelease(checks, observations) {
  if (!Array.isArray(observations) || observations.length !== checks.length) {
    throw new Error("Remote probes did not return a complete observation set");
  }
  const releaseCheck = checks.find(({ kind }) => kind === "release");
  const releaseObservation = observations.find(({ id }) => id === releaseCheck?.id);
  if (releaseCheck === undefined || releaseObservation === undefined
      || observationValue(releaseObservation, releaseCheck).state !== "absent") {
    throw new Error("Post-publication verification found invalid GitHub Release state");
  }
  const simulatedComplete = observations.map((observation) => observation.id === releaseCheck.id
    ? { id: releaseCheck.id, state: "present", evidence: releaseCheck.expectedEvidence }
    : observation);
  if (evaluateUnitState(checks, simulatedComplete) !== "already-identical") {
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

async function verifyPublishedArtifactsWithRetry(checks, probe, sleep) {
  assertUnitChecks(checks);
  for (let attempt = 0; attempt <= PUBLICATION_MAX_POLLS; attempt += 1) {
    const observations = await collectRemoteObservations(checks, probe);
    try {
      if (evaluateUnitState(checks, observations) === "already-identical") return "already-identical";
    } catch {
      // A partial unit is retried only when every visible item still matches.
    }
    if (observations.length !== checks.length) throw new Error("Remote probes did not return a complete observation set");
    const byId = new Map(observations.map((observation) => [observation?.id, observation]));
    const releaseCheck = checks.find(({ kind }) => kind === "release");
    if (releaseCheck === undefined || byId.size !== checks.length) {
      throw new Error("Remote probes did not return a complete observation set");
    }
    for (const check of checks) {
      const observation = observationValue(byId.get(check.id), check);
      if (check.id === releaseCheck.id) {
        if (observation.state !== "absent") throw new Error("Post-publication verification found invalid GitHub Release state");
      } else if (observation.state === "present" && observation.evidence !== check.expectedEvidence) {
        throw new Error(`Remote destination ${check.id} has different evidence`);
      }
    }
    const pending = checks.some(({ id, kind }) => kind !== "release" && byId.get(id)?.state === "absent");
    if (!pending) return evaluatePublishedArtifactsBeforeRelease(checks, observations);
    if (attempt === PUBLICATION_MAX_POLLS) break;
    await sleep(PUBLICATION_POLL_INTERVAL_MS);
  }
  throw new Error("Post-publication verification required every destination to be identical");
}

function knownUnitId(value) {
  try {
    return unitById(value).id;
  } catch {
    throw new TypeError("Release unit is unknown");
  }
}

// Validates collected evidence into one check plan per unit, in the collector's (plan) order.
function collectedUnitPlans(collected, commit) {
  const values = ownData(collected, ["releaseSet", "units"], "Collected release evidence");
  const releaseSet = parseReleaseSetId(values.releaseSet, commit);
  if (!Array.isArray(values.units) || utilTypes.isProxy(values.units) || values.units.length === 0) {
    throw new TypeError("Collected release evidence must name at least one unit");
  }
  const entries = Array.from(values.units, (candidate) => {
    const entry = ownData(candidate, ["id", "version", "tag", "evidence"], "Collected unit evidence");
    const plan = createUnitCheckPlan({ unit: entry.id, version: entry.version, sourceCommit: commit, evidence: entry.evidence });
    if (entry.tag !== plan[0].tag) throw new TypeError("Collected unit evidence has a foreign tag");
    return Object.freeze({ id: plan[0].unit, version: plan[0].version, tag: plan[0].tag, plan });
  });
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new TypeError("Collected release evidence names a unit twice");
  }
  return Object.freeze({ releaseSet, entries });
}

export async function checkReleasePublication(options, dependencyOverrides) {
  const values = ownData(
    options,
    ["releaseDirectory", "sourceCommit", "requireIdentical", "unit"],
    "Release publication check options",
  );
  const releaseDirectory = syntacticAbsolutePath(values.releaseDirectory, "Release directory");
  const commit = sourceCommit(values.sourceCommit);
  if (typeof values.requireIdentical !== "boolean") {
    throw new TypeError("Release publication requireIdentical must be boolean");
  }
  const unit = values.unit === null ? null : knownUnitId(values.unit);
  const dependencies = dependencySet(dependencyOverrides);
  const collected = collectedUnitPlans(
    await dependencies.collectEvidence({ releaseDirectory, sourceCommit: commit }),
    commit,
  );
  const selected = unit === null ? collected.entries : collected.entries.filter(({ id }) => id === unit);
  if (selected.length === 0) throw new TypeError(`Release unit ${unit} is not in release set ${collected.releaseSet}`);
  const plans = selected.map(({ plan }) => plan);
  const states = [];
  if (!values.requireIdentical) {
    for (const { state } of await checkUnitDestinations({ plans, probe: dependencies.probe })) states.push(state);
  } else {
    for (const plan of plans) states.push(await verifyPublishedArtifactsWithRetry(plan, dependencies.probe, dependencies.sleep));
  }
  return Object.freeze({
    releaseSet: collected.releaseSet,
    units: Object.freeze(selected.map(({ id, version, tag }, index) => Object.freeze({
      id,
      kind: unitById(id).kind,
      version,
      tag,
      state: states[index],
    }))),
  });
}

export async function checkDraftReleasePublication(options) {
  try {
    const values = ownData(options, ["releaseDirectory", "sourceCommit", "unit"], "Draft release verification options");
    const releaseDirectory = canonicalDirectory(
      syntacticAbsolutePath(values.releaseDirectory, "Release directory"),
      "Release directory",
    );
    const commit = sourceCommit(values.sourceCommit);
    const unit = unitById(values.unit);
    const { manifest } = readStagedManifest(releaseDirectory, commit);
    const entry = manifestUnit(manifest, unit.id);
    const finalized = localFinalizedUnit(releaseDirectory, manifest, unit.id);
    if (finalized === undefined) throw new Error();
    if (unit.id === "gauntlet" && finalized.receipt.imageDigest !== await stagedImageDigest(releaseDirectory, manifest)) {
      throw new Error();
    }
    const check = Object.freeze({
      id: `github:${entry.tag}`,
      unit: entry.id,
      kind: "release",
      destination: `${GITHUB_RELEASES}/${entry.tag}`,
      expectedEvidence: githubReleaseEvidence(
        entry.id,
        entry.version,
        commit,
        unitAssetHashes(releaseDirectory, manifest, entry.id, finalized.generated),
      ),
      version: entry.version,
      tag: entry.tag,
    });
    const observation = observationValue(await probeDraftRelease(validatedCheck(check)), check);
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
    ["releaseDirectory", "unit", "imageDigest", "chartDigest"],
    "Published unit finalization options",
  );
  const releaseDirectory = canonicalDirectory(values.releaseDirectory, "Release directory");
  const unit = unitById(knownUnitId(values.unit));
  const digestsValid = unit.id === "gauntlet"
    ? [values.imageDigest, values.chartDigest].every((digest) => typeof digest === "string" && OCI_DIGEST.test(digest))
    : values.imageDigest === null && values.chartDigest === null;
  if (!digestsValid) throw new TypeError("Published OCI digests are required exactly for the gauntlet unit");
  const { manifest } = readStagedManifest(releaseDirectory);
  let entry;
  let unitManifest;
  try {
    entry = manifestUnit(manifest, unit.id);
    unitManifest = unitReleaseManifest(manifest, unit.id);
  } catch {
    throw new Error(FAILURE);
  }
  const manifestBytes = unitManifestBytes(manifest, unit.id);
  const receiptBytes = publicationReceiptBytes({
    schemaVersion: 2,
    releaseSet: manifest.releaseSet,
    unit: unit.id,
    version: entry.version,
    sourceCommit: manifest.sourceCommit,
    manifestSha256: sha256Bytes(manifestBytes),
    imageDigest: values.imageDigest,
    chartDigest: values.chartDigest,
  });
  const directory = privateDirectory(join(privateDirectory(join(releaseDirectory, "units")), unit.id));
  createOrRequireIdentical(join(directory, "release-manifest.json"), manifestBytes, GENERATED_ASSETS[0].maximumBytes);
  createOrRequireIdentical(join(directory, "publication-receipt.json"), receiptBytes, GENERATED_ASSETS[1].maximumBytes);
  const checksums = finalizedUnitChecksums(unitManifest, manifestBytes, receiptBytes);
  atomicReplace(join(directory, "SHA256SUMS"), checksums);
  return Object.freeze({ unit: unit.id, files: checksums.toString("ascii").split("\n").length - 1 });
}

// Creates a task-owned private directory or accepts an existing real one; a symlink, a non-directory
// or a directory reached through a symlink fails closed.
function privateDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error(FAILURE);
  }
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
  } catch {
    throw new Error(FAILURE);
  }
  return path;
}

function createOrRequireIdentical(path, bytes, maximumBytes) {
  let exists = true;
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(FAILURE);
    exists = false;
  }
  if (!exists) {
    atomicCreate(path, bytes);
  } else {
    let existing;
    try {
      existing = readCanonicalFile(path, "Finalized release file", maximumBytes);
    } catch {
      throw new Error(FAILURE);
    }
    if (!existing.equals(bytes)) throw new Error(FAILURE);
  }
  if (digestFile(path) !== sha256Bytes(bytes)) throw new Error(FAILURE);
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

// Reads a canonical file without following a symlink at any point of its path.
function readCanonicalFile(path, label, maximumBytes) {
  canonicalFile(path, label, BigInt(maximumBytes));
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maximumBytes)) throw new Error();
    const bytes = Buffer.alloc(Number(before.size));
    let position = 0;
    while (position < bytes.length) {
      const count = readSync(descriptor, bytes, position, bytes.length - position, position);
      if (count <= 0) throw new Error();
      position += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error();
    return bytes;
  } catch {
    throw new Error(FAILURE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// Reads the canonical schema 2 manifest of a staged release-set root: it must be bound to `commit`
// (when given) and to the directory's own set id, name exactly the artifacts of its units, and every
// artifact file must still hash to its record.
function readStagedManifest(releaseDirectory, commit) {
  try {
    const staged = readReleaseManifest(releaseDirectory);
    const { manifest } = staged;
    if ((commit !== undefined && manifest.sourceCommit !== commit) || manifest.releaseSet !== basename(releaseDirectory)) {
      throw new Error();
    }
    const expected = expectedReleaseArtifacts(manifest.units);
    const actual = manifest.artifacts.map(({ unit, kind, name, path }) => ({ unit, kind, name, path }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error();
    for (const artifact of manifest.artifacts) releaseArtifactPath(releaseDirectory, artifact);
    return staged;
  } catch {
    throw new Error(FAILURE);
  }
}

function oneArtifact(artifacts, kind, name) {
  const matches = artifacts.filter((record) => record.kind === kind && record.name === name);
  if (matches.length !== 1) throw new Error(FAILURE);
  return matches[0];
}

function finalizedUnitChecksums(unitManifest, manifestBytes, receiptBytes) {
  const records = [
    { path: "release-manifest.json", sha256: sha256Bytes(manifestBytes) },
    { path: "publication-receipt.json", sha256: sha256Bytes(receiptBytes) },
    ...unitManifest.artifacts.map(({ path, sha256 }) => ({ path, sha256 })),
  ];
  if (new Set(records.map(({ path }) => path)).size !== records.length) throw new Error(FAILURE);
  records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return Buffer.from(records.map(({ path, sha256 }) => `${sha256}  ${path}\n`).join(""), "ascii");
}

// Hashes one unit's GitHub Release assets: staged artifacts are re-verified on disk, the three generated
// files come from `generated` (name to exact bytes).
function unitAssetHashes(releaseDirectory, manifest, unitId, generated) {
  const result = Object.create(null);
  for (const asset of unitReleaseAssets(manifest, unitId)) {
    const bytes = generated.get(asset.name);
    if ((bytes !== undefined) !== asset.path.startsWith(`units/${unitId}/`)) throw new Error(FAILURE);
    if (bytes !== undefined) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > asset.maximumBytes) throw new Error(FAILURE);
      result[asset.name] = sha256Bytes(bytes);
    } else {
      const matches = manifest.artifacts.filter((record) => record.unit === unitId && record.path === asset.path);
      if (matches.length !== 1) throw new Error(FAILURE);
      const [artifact] = matches;
      const path = releaseArtifactPath(releaseDirectory, artifact);
      const size = lstatSync(path, { bigint: true }).size;
      if (size <= 0n || size > BigInt(asset.maximumBytes)) throw new Error(FAILURE);
      result[asset.name] = artifact.sha256;
    }
  }
  return Object.freeze(result);
}

function githubReleaseEvidence(unitId, version, commit, assetHashes) {
  const unit = unitById(unitId);
  const releaseVersion = stableVersion(version);
  const source = sourceCommit(commit);
  const expected = githubReleaseAssetCatalog(unit.id, releaseVersion).map(({ name }) => name);
  const hashes = ownData(assetHashes, expected, "GitHub Release asset hashes");
  const assets = expected.map((name) => {
    if (typeof hashes[name] !== "string" || !SHA256.test(hashes[name])) throw new Error(FAILURE);
    return { name, sha256: hashes[name] };
  });
  return sha256Bytes(JSON.stringify({
    schemaVersion: 2,
    unit: unit.id,
    tag: unitTag(unit, releaseVersion),
    sourceCommit: source,
    assets,
  }));
}

function localUnitPublication(releaseDirectory, manifest, unitId) {
  const entry = manifestUnit(manifest, unitId);
  const path = join(releaseDirectory, "units", entry.id, "publication-receipt.json");
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(FAILURE);
  }
  const bytes = readCanonicalFile(path, "Publication receipt", GENERATED_ASSETS[1].maximumBytes);
  const receipt = parsePublicationReceipt(bytes.toString("utf8"), {
    releaseSet: manifest.releaseSet,
    unit: entry.id,
    version: entry.version,
    sourceCommit: manifest.sourceCommit,
    manifestSha256: sha256Bytes(unitManifestBytes(manifest, entry.id)),
  });
  if (!bytes.equals(publicationReceiptBytes(receipt))) throw new Error(FAILURE);
  return Object.freeze({ receipt, bytes });
}

// A finalized unit's three generated files; each must equal the bytes computed from the staged manifest
// and the unit's own receipt. Absent receipt means the unit is not finalized.
function localFinalizedUnit(releaseDirectory, manifest, unitId) {
  const publication = localUnitPublication(releaseDirectory, manifest, unitId);
  if (publication === undefined) return undefined;
  const directory = join(releaseDirectory, "units", unitId);
  const manifestBytes = unitManifestBytes(manifest, unitId);
  if (!readCanonicalFile(join(directory, "release-manifest.json"), "Unit release manifest", GENERATED_ASSETS[0].maximumBytes)
    .equals(manifestBytes)) throw new Error(FAILURE);
  const checksums = finalizedUnitChecksums(unitReleaseManifest(manifest, unitId), manifestBytes, publication.bytes);
  if (!readCanonicalFile(join(directory, "SHA256SUMS"), "Unit release checksums", GENERATED_ASSETS[2].maximumBytes)
    .equals(checksums)) throw new Error(FAILURE);
  return Object.freeze({
    receipt: publication.receipt,
    bytes: publication.bytes,
    generated: new Map([
      ["release-manifest.json", manifestBytes],
      ["publication-receipt.json", publication.bytes],
      ["SHA256SUMS", checksums],
    ]),
  });
}

async function stagedImageDigest(releaseDirectory, manifest) {
  const artifacts = manifest.artifacts.filter(({ unit }) => unit === "gauntlet");
  return ociLayoutDigest(releaseArtifactPath(releaseDirectory, oneArtifact(artifacts, "oci", RELEASE_ARTIFACTS.image.name)));
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

function optionalDigest(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  if (!OCI_DIGEST.test(value)) throw new Error(FAILURE);
  return value;
}

async function collectUnitEvidence(releaseDirectory, manifest, entry, expected) {
  const unit = unitById(entry.id);
  const commit = manifest.sourceCommit;
  const artifacts = manifest.artifacts.filter((artifact) => artifact.unit === unit.id);
  const name = unit.artifacts[0];
  const values = new Map();
  const finalized = localFinalizedUnit(releaseDirectory, manifest, unit.id);
  const remote = await publishedUnitReceipt(manifest, unit.id);
  if (finalized !== undefined && remote !== undefined && !finalized.bytes.equals(remote.bytes)) throw new Error(FAILURE);
  const publication = finalized ?? remote;

  if (unit.kind === "npm") {
    const path = releaseArtifactPath(releaseDirectory, oneArtifact(artifacts, "npm", name));
    values.set(unitDestinations(unit.id)[0].id, `sha512-${hashFile(path, "sha512", "base64")}`);
  } else if (unit.kind === "maven") {
    const record = oneArtifact(artifacts, "maven", name);
    const artifactId = name.split(":")[1];
    values.set(unitDestinations(unit.id)[0].id, await consumeManifestTree({
      archivePath: releaseArtifactPath(releaseDirectory, record),
      expectedPrefix: `gauntlet-${artifactId}-${entry.version}`,
      expectedSha256: record.sha256,
    }, (source) => digestFile(canonicalFile(
      resolve(source, `${artifactId}-${entry.version}.jar`),
      "Materialized Maven binary",
      512n * 1024n * 1024n,
    ))));
  } else if (unit.kind === "composer") {
    const record = oneArtifact(artifacts, "composer", name);
    const composer = RELEASE_ARTIFACTS.composer.find((artifact) => artifact.name === name);
    values.set(unitDestinations(unit.id)[0].id, await consumeManifestTree({
      archivePath: releaseArtifactPath(releaseDirectory, record),
      expectedPrefix: `${composer.repository.split("/").at(-1)}-${entry.version}`,
      expectedSha256: record.sha256,
    }, (source) => composerTreeEvidence(source, entry.version, commit)));
  }

  let digests = {};
  if (unit.id === "gauntlet") {
    const imageDigest = await stagedImageDigest(releaseDirectory, manifest);
    if (expected.imageDigest !== undefined && expected.imageDigest !== imageDigest) throw new Error(FAILURE);
    if (publication !== undefined && publication.receipt.imageDigest !== imageDigest) throw new Error(FAILURE);
    values.set("image:semantic", imageDigest);
    values.set("image:commit", imageDigest);
    const chartSha256 = digestFile(releaseArtifactPath(releaseDirectory, oneArtifact(artifacts, "helm", RELEASE_ARTIFACTS.chart.name)));
    values.set("chart:semantic", chartSha256);
    if (expected.chartDigest !== undefined && publication !== undefined
        && expected.chartDigest !== publication.receipt.chartDigest) throw new Error(FAILURE);
    digests = { imageDigest, chartDigest: expected.chartDigest ?? `sha256:${chartSha256}` };
  }

  let generated = finalized?.generated;
  if (generated === undefined) {
    const manifestBytes = unitManifestBytes(manifest, unit.id);
    const receiptBytes = remote?.bytes ?? publicationReceiptBytes({
      schemaVersion: 2,
      releaseSet: manifest.releaseSet,
      unit: unit.id,
      version: entry.version,
      sourceCommit: commit,
      manifestSha256: sha256Bytes(manifestBytes),
      ...digests,
    });
    generated = new Map([
      ["release-manifest.json", manifestBytes],
      ["publication-receipt.json", receiptBytes],
      ["SHA256SUMS", finalizedUnitChecksums(unitReleaseManifest(manifest, unit.id), manifestBytes, receiptBytes)],
    ]);
  }
  values.set(`github:${entry.tag}`, githubReleaseEvidence(
    unit.id,
    entry.version,
    commit,
    unitAssetHashes(releaseDirectory, manifest, unit.id, generated),
  ));
  const evidence = Object.freeze(Object.fromEntries(unitTemplates(unit.id, entry.tag).map(({ id }) => [id, values.get(id)])));
  createUnitCheckPlan({ unit: unit.id, version: entry.version, sourceCommit: commit, evidence });
  return Object.freeze({ id: unit.id, version: entry.version, tag: entry.tag, evidence });
}

export async function collectReleaseEvidence(options) {
  const values = ownData(options, ["releaseDirectory", "sourceCommit"], "Release evidence options");
  const releaseDirectory = canonicalDirectory(values.releaseDirectory, "Release directory");
  const commit = sourceCommit(values.sourceCommit);
  const expected = Object.freeze({
    imageDigest: optionalDigest("GAUNTLET_EXPECTED_IMAGE_DIGEST"),
    chartDigest: optionalDigest("GAUNTLET_EXPECTED_CHART_DIGEST"),
  });
  const { manifest } = readStagedManifest(releaseDirectory, commit);
  const units = [];
  for (const entry of manifest.units) units.push(await collectUnitEvidence(releaseDirectory, manifest, entry, expected));
  return Object.freeze({ releaseSet: manifest.releaseSet, units: Object.freeze(units) });
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

async function githubDraftByTag(tag, token) {
  // GitHub's release-by-tag endpoint omits drafts and returns 404 for them.
  // Authenticated list releases includes drafts, so use it for the pre-publication gate.
  const listing = await githubJson("/repos/8lines/gauntlet/releases?per_page=100", token);
  if (listing.state !== "present") return listing;
  if (!Array.isArray(listing.value)) throw new Error(FAILURE);
  const matches = listing.value.filter((release) => release?.tag_name === tag);
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

async function publishedUnitReceipt(manifest, unitId) {
  if (process.env.GAUNTLET_USE_REMOTE_RECEIPT !== "true") return undefined;
  const entry = manifestUnit(manifest, unitId);
  const token = validatedToken("GH_TOKEN");
  const release = await githubJson(`/repos/8lines/gauntlet/releases/tags/${entry.tag}`, token);
  if (release.state === "absent") return undefined;
  if (release.value?.tag_name !== entry.tag || release.value?.draft !== false || release.value?.prerelease !== false
      || release.value?.immutable !== true || !Array.isArray(release.value?.assets)) throw new Error(FAILURE);
  const assets = parseReleaseAssets(release.value.assets, entry.id, entry.version);
  const downloaded = await downloadGithubReleaseAsset(
    assets["publication-receipt.json"],
    token,
    GENERATED_ASSETS[1].maximumBytes,
    true,
  );
  const receipt = parsePublicationReceipt(downloaded.bytes.toString("utf8"), {
    releaseSet: manifest.releaseSet,
    unit: entry.id,
    version: entry.version,
    sourceCommit: manifest.sourceCommit,
    manifestSha256: sha256Bytes(unitManifestBytes(manifest, entry.id)),
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
  const template = unitDestinations(check.unit).find(({ id }) => id === check.id);
  if (template === undefined) throw new Error(FAILURE);
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
  const template = unitDestinations(check.unit).find(({ id }) => id === check.id);
  const artifact = RELEASE_ARTIFACTS.composer.find(({ repositoryUrl }) => repositoryUrl === template?.target);
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
    ? await githubDraftByTag(check.tag, token)
    : await githubJson(`/repos/8lines/gauntlet/releases/tags/${check.tag}`, token);
  if (release.state === "absent") return { id: check.id, state: "absent" };
  if (release.value?.tag_name !== check.tag || release.value?.draft !== expectedDraft
      || release.value?.prerelease !== false || release.value?.immutable !== !expectedDraft) {
    throw new Error(FAILURE);
  }
  const assets = parseReleaseAssets(release.value?.assets, check.unit, check.version);
  const downloads = await Promise.allSettled(githubReleaseAssetCatalog(check.unit, check.version).map(async ({ name, maximumBytes }) => {
    const downloaded = await downloadGithubReleaseAsset(assets[name], token, maximumBytes);
    return Object.freeze({ name, sha256: downloaded.sha256 });
  }));
  if (downloads.some(({ status }) => status === "rejected")) throw new Error(FAILURE);
  const hashes = Object.fromEntries(downloads.map(({ value }) => [value.name, value.sha256]));
  const tagged = await githubTagCommit("gauntlet", check.tag, token);
  if (tagged.state !== "present") throw new Error(FAILURE);
  return {
    id: check.id,
    state: "present",
    evidence: githubReleaseEvidence(check.unit, check.version, tagged.commit, hashes),
  };
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
    validated = validatedCheck(check);
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

const CLI_USAGE = "Usage: check-published.mjs --release-directory ABSOLUTE_PATH --source-commit SHA [--unit ID] [--require-identical | --require-draft-identical] | --finalize ABSOLUTE_PATH --unit ID [--image-digest sha256:... --chart-digest sha256:...] (--require-draft-identical needs --unit; the digests are given exactly for the gauntlet unit)";

export function parsePublishedArguments(argv) {
  try {
    if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) throw new Error();
    if (argv[0] === "--finalize") {
      if (![4, 8].includes(argv.length) || argv[2] !== "--unit") throw new Error();
      const releaseDirectory = syntacticAbsolutePath(argv[1], "Release directory");
      const unit = unitById(argv[3]).id;
      if (argv.length === 4) {
        if (unit === "gauntlet") throw new Error();
        return Object.freeze({ command: "finalize", releaseDirectory, unit, imageDigest: null, chartDigest: null });
      }
      if (unit !== "gauntlet" || argv[4] !== "--image-digest" || argv[6] !== "--chart-digest"
          || !OCI_DIGEST.test(argv[5]) || !OCI_DIGEST.test(argv[7])) throw new Error();
      return Object.freeze({ command: "finalize", releaseDirectory, unit, imageDigest: argv[5], chartDigest: argv[7] });
    }
    if (argv.length < 4 || argv[0] !== "--release-directory" || argv[2] !== "--source-commit") throw new Error();
    const releaseDirectory = syntacticAbsolutePath(argv[1], "Release directory");
    const commit = sourceCommit(argv[3]);
    let rest = argv.slice(4);
    let unit = null;
    if (rest[0] === "--unit") {
      if (rest.length < 2) throw new Error();
      unit = unitById(rest[1]).id;
      rest = rest.slice(2);
    }
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "--require-identical")) {
      return Object.freeze({ command: "check", releaseDirectory, sourceCommit: commit, unit, requireIdentical: rest.length === 1 });
    }
    if (rest.length === 1 && rest[0] === "--require-draft-identical" && unit !== null) {
      return Object.freeze({ command: "verify-draft", releaseDirectory, sourceCommit: commit, unit });
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
        unit: command.unit,
        imageDigest: command.imageDigest,
        chartDigest: command.chartDigest,
      });
      process.stdout.write(`${JSON.stringify({ command: "finalize", ...result })}\n`);
    } else if (command.command === "verify-draft") {
      const state = await checkDraftReleasePublication({
        releaseDirectory: command.releaseDirectory,
        sourceCommit: command.sourceCommit,
        unit: command.unit,
      });
      const entry = manifestUnit(readReleaseManifest(command.releaseDirectory).manifest, command.unit);
      const assets = githubReleaseAssetCatalog(entry.id, entry.version).length;
      process.stdout.write(`${JSON.stringify({ command: "verify-draft", unit: entry.id, tag: entry.tag, assets, state })}\n`);
    } else {
      const result = await checkReleasePublication({
        releaseDirectory: command.releaseDirectory,
        sourceCommit: command.sourceCommit,
        requireIdentical: command.requireIdentical,
        unit: command.unit,
      });
      process.stdout.write(`${JSON.stringify({ command: "check", releaseSet: result.releaseSet, units: result.units })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : FAILURE}\n`);
    process.exitCode = 1;
  }
}
