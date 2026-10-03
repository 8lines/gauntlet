#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseVersion, readUnitVersions } from "./release-model.mjs";
import { RELEASE_UNITS, dependencyOrder, unitById, unitTag } from "./units.mjs";

const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const PLAN_FAILURE = "Release plan is invalid";
const PLAN_MISSING = "Release plan is missing or unsafe";
const PLAN_PATH_FAILURE = "Release plan path must stay inside the repository";
const SET_FAILURE = "Release set id must be release-YYYY-MM-DD.N or local-<12 hex> of the source commit";
const TAGS_FAILURE = "Repository tags are unreadable";
const USAGE = "Usage: plan.mjs [--write] | --check [--release-set release-YYYY-MM-DD.N] [--commit SHA]";
const MAX_PLAN_BYTES = 64 * 1024;
const COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_TAG = /^release-([0-9]{4})-([0-9]{2})-([0-9]{2})\.([1-9][0-9]{0,2})$/u;
const LOCAL_SET = /^local-[0-9a-f]{12}$/u;
const ARTIFACT_UNIT = new Map(RELEASE_UNITS.flatMap(({ id, artifacts }) => artifacts.map((name) => [name, id])));

export const RELEASE_PLAN_PATH = ".release/plan.json";
export const RELEASE_GATES = Object.freeze([
  "node", "php", "java", "conformance", "dashboard", "widget", "widget-panel", "deployment", "skills", "security",
]);

function stable(value) {
  if (typeof value !== "string") throw new Error(PLAN_FAILURE);
  try {
    return parseReleaseVersion(`${value}\n`);
  } catch {
    throw new Error(PLAN_FAILURE);
  }
}

export function compareVersions(left, right) {
  const a = stable(left).split(".").map(BigInt);
  const b = stable(right).split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function unitIdForArtifact(name) {
  const id = ARTIFACT_UNIT.get(name);
  if (id === undefined) throw new Error(`Artifact ${name} has no release unit`);
  return id;
}

export function isReleaseTagName(value) {
  const match = typeof value === "string" ? RELEASE_TAG.exec(value) : null;
  if (match === null) return false;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function localReleaseSetId(sourceCommit) {
  if (typeof sourceCommit !== "string" || !COMMIT.test(sourceCommit)) throw new TypeError(SET_FAILURE);
  return `local-${sourceCommit.slice(0, 12)}`;
}

export function parseReleaseSetId(value, sourceCommit) {
  if (isReleaseTagName(value)) return value;
  if (typeof value === "string" && LOCAL_SET.test(value)
      && (sourceCommit === undefined || localReleaseSetId(sourceCommit) === value)) return value;
  throw new TypeError(SET_FAILURE);
}

function planEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(PLAN_FAILURE);
  const keys = Object.keys(entry);
  if (keys.length !== 3 || !["id", "from", "to"].every((key) => keys.includes(key))) throw new Error(PLAN_FAILURE);
  let unit;
  try {
    unit = unitById(entry.id);
  } catch {
    throw new Error(PLAN_FAILURE);
  }
  const to = stable(entry.to);
  if (entry.from !== null && compareVersions(stable(entry.from), to) >= 0) throw new Error(PLAN_FAILURE);
  return Object.freeze({ id: unit.id, from: entry.from, to });
}

export function createReleasePlan(entries) {
  const list = [...entries].map(planEntry);
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  if (byId.size !== list.length) throw new Error(PLAN_FAILURE);
  const order = dependencyOrder([...byId.keys()]);
  return Object.freeze({
    schemaVersion: 1,
    units: Object.freeze(order.map((id) => byId.get(id))),
    order: Object.freeze([...order]),
  });
}

export function serializeReleasePlan(plan) {
  return `${JSON.stringify({
    schemaVersion: 1,
    units: plan.units.map(({ id, from, to }) => ({ id, from, to })),
    order: [...plan.order],
  }, null, 2)}\n`;
}

export function parseReleasePlan(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_PLAN_BYTES) throw new Error(PLAN_FAILURE);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(PLAN_FAILURE);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1
      || !Array.isArray(value.units) || !Array.isArray(value.order)) throw new Error(PLAN_FAILURE);
  const plan = createReleasePlan(value.units);
  if (serializeReleasePlan(plan) !== source) throw new Error(PLAN_FAILURE);
  return plan;
}

function versionOf(versions, id) {
  const version = versions.get(id);
  if (typeof version !== "string") throw new Error(`Release unit ${id} has no version`);
  return version;
}

export function allUnitsPlan(versions) {
  return createReleasePlan(RELEASE_UNITS.map(({ id }) => ({ id, from: null, to: versionOf(versions, id) })));
}

export function parseTagListing(output) {
  if (typeof output !== "string") throw new Error(TAGS_FAILURE);
  const tags = new Map();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\0");
    if (fields.length !== 3 || fields[0] === "" || tags.has(fields[0])) throw new Error(TAGS_FAILURE);
    const commit = fields[2] === "" ? fields[1] : fields[2];
    if (!COMMIT.test(commit)) throw new Error(TAGS_FAILURE);
    tags.set(fields[0], commit);
  }
  return tags;
}

export function readRepositoryTags(root) {
  let output;
  try {
    output = execFileSync("git", [
      "-C", root, "for-each-ref", "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)", "refs/tags",
    ], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH, HOME: "/dev/null", LANG: "C", LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  } catch {
    throw new Error(TAGS_FAILURE);
  }
  return parseTagListing(output);
}

export function latestUnitVersion(id, tags, { excludeTag } = {}) {
  const { tagPrefix } = unitById(id);
  let latest = null;
  for (const name of tags.keys()) {
    if (name === excludeTag || !name.startsWith(tagPrefix)) continue;
    const candidate = name.slice(tagPrefix.length);
    let version;
    try {
      version = parseReleaseVersion(`${candidate}\n`);
    } catch {
      continue;
    }
    if (latest === null || compareVersions(version, latest) > 0) latest = version;
  }
  return latest;
}

export function buildReleasePlan(versions, tags) {
  const entries = [];
  for (const { id } of RELEASE_UNITS) {
    const current = versionOf(versions, id);
    const latest = latestUnitVersion(id, tags);
    if (latest !== current) entries.push({ id, from: latest, to: current });
  }
  return createReleasePlan(entries);
}

export function validatePlanAgainstManifests(plan, versions) {
  return plan.units
    .filter(({ id, to }) => versions.get(id) !== to)
    .map(({ id, to }) => `${id}: plan version ${to} does not equal manifest version ${versions.get(id) ?? "missing"}`);
}

export function validatePlanAgainstTags(plan, { versions, tags, commit = null }) {
  const problems = [];
  const planned = new Map(plan.units.map((entry) => [entry.id, entry]));
  for (const entry of plan.units) {
    const unit = unitById(entry.id);
    const toTag = unitTag(unit, entry.to);
    if (tags.has(toTag) && tags.get(toTag) !== commit) problems.push(`${entry.id}: tag ${toTag} already exists at another commit`);
    const latest = latestUnitVersion(entry.id, tags, { excludeTag: toTag });
    if (latest !== entry.from) {
      problems.push(`${entry.id}: plan starts from ${entry.from ?? "nothing"} but the latest tag is ${latest ?? "absent"}`);
    }
    for (const dependency of unit.dependsOn) {
      const version = versionOf(versions, dependency);
      if (planned.get(dependency)?.to === version) continue;
      if (!tags.has(unitTag(unitById(dependency), version))) {
        problems.push(`${entry.id}: dependency ${dependency} ${version} is neither planned nor tagged`);
      }
    }
  }
  for (const unit of RELEASE_UNITS) {
    if (planned.has(unit.id)) continue;
    const version = versionOf(versions, unit.id);
    if (!tags.has(unitTag(unit, version))) problems.push(`${unit.id}: version ${version} is neither planned nor tagged`);
  }
  return problems;
}

export function planGates(plan) {
  const wanted = new Set(plan.units.flatMap(({ id }) => unitById(id).gates));
  return RELEASE_GATES.filter((gate) => wanted.has(gate));
}

function planLocation(root, path) {
  if (typeof path !== "string" || path === "" || path.includes("\0") || path.includes("\\")) throw new TypeError(PLAN_PATH_FAILURE);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const relativePath = relative(root, absolute);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new TypeError(PLAN_PATH_FAILURE);
  }
  return Object.freeze({ absolute, relativePath: relativePath.split(sep).join("/") });
}

export function readReleasePlan(root, path = RELEASE_PLAN_PATH) {
  const { absolute } = planLocation(root, path);
  let bytes;
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_PLAN_BYTES) throw new Error();
    bytes = readFileSync(absolute);
  } catch {
    throw new Error(PLAN_MISSING);
  }
  return parseReleasePlan(bytes.toString("utf8"));
}

function defaultPlanExists(root) {
  try {
    lstatSync(resolve(root, RELEASE_PLAN_PATH));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(PLAN_MISSING);
  }
}

export function resolveReleasePlan(root, path = null, { readVersions = readUnitVersions } = {}) {
  if (path !== null) {
    return Object.freeze({ plan: readReleasePlan(root, path), path: planLocation(root, path).relativePath });
  }
  if (defaultPlanExists(root)) return Object.freeze({ plan: readReleasePlan(root), path: RELEASE_PLAN_PATH });
  return Object.freeze({ plan: allUnitsPlan(readVersions(root)), path: null });
}

export function writeReleasePlan(root, plan) {
  const directory = resolve(root, ".release");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(PLAN_MISSING);
  const scratch = join(directory, `.plan-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(scratch, serializeReleasePlan(plan), { flag: "wx", mode: 0o644 });
  renameSync(scratch, resolve(root, RELEASE_PLAN_PATH));
  return RELEASE_PLAN_PATH;
}

export function parsePlanArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) throw new TypeError(USAGE);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--write")) return Object.freeze({ command: "write" });
  if (argv[0] !== "--check" || argv.length % 2 !== 1) throw new TypeError(USAGE);
  let releaseSet = null;
  let commit = null;
  for (let index = 1; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === "--release-set" && releaseSet === null && isReleaseTagName(value)) releaseSet = value;
    else if (flag === "--commit" && commit === null && COMMIT.test(value)) commit = value;
    else throw new TypeError(USAGE);
  }
  return Object.freeze({ command: "check", releaseSet, commit });
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function runPlanCli(argv, { root = REPOSITORY_ROOT, readVersions = readUnitVersions, readTags = readRepositoryTags } = {}) {
  let command;
  try {
    command = parsePlanArguments(argv);
  } catch {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const versions = readVersions(root);
    const tags = readTags(root);
    if (command.command === "write") {
      const plan = buildReleasePlan(versions, tags);
      const path = writeReleasePlan(root, plan);
      return {
        exitCode: 0,
        stdout: jsonLine({ command: "write", path, units: plan.units, order: plan.order, gates: planGates(plan) }),
        stderr: "",
      };
    }
    const plan = readReleasePlan(root);
    const problems = [
      ...(plan.units.length === 0 ? ["release plan has no units"] : []),
      ...validatePlanAgainstManifests(plan, versions),
      ...validatePlanAgainstTags(plan, { versions, tags, commit: command.commit }),
    ];
    return {
      exitCode: problems.length === 0 ? 0 : 1,
      stdout: jsonLine({
        command: "check", ok: problems.length === 0, releaseSet: command.releaseSet, units: plan.units,
        order: plan.order, gates: planGates(plan), problems,
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "PLAN_FAILED", message: error instanceof Error ? error.message : PLAN_FAILURE }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runPlanCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
