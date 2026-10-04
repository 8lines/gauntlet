import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { changelogPath, changelogSection } from "./changelog.mjs";
import { unitReleaseAssets } from "./check-published.mjs";
import { compatibilityLine, readCompatibilityDocument } from "./compatibility.mjs";
import { readReleaseManifest } from "./inventory.mjs";
import { RELEASE_GATES, readReleasePlan } from "./plan.mjs";
import { dependencyOrder, unitById, unitTag } from "./units.mjs";

export { changelogPath, changelogSection } from "./changelog.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const PUBLISHABLE_STATES = Object.freeze(["clean", "already-identical"]);
const ARCHIVE_KINDS = Object.freeze(["npm", "composer", "maven"]);
const FIELDS = Object.freeze(["version", "tag", "title", "previous-tag"]);
const PACKAGE_KINDS = Object.freeze(["npm", "maven", "composer"]);
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAXIMUM_INPUT_BYTES = 1024 * 1024;
const REQUIRABLE_STATES = Object.freeze(["clean", "already-identical", "published-artifacts-identical", "draft-identical"]);
const PLAN_FAILURE = "Release plan check did not pass";
const PREFLIGHT_FAILURE = "Release preflight state is not publishable";
const READ_FAILURE = "Release set input could not be read";
const USAGE = [
  "Usage: release-set.mjs outputs --plan-result FILE",
  "| preflight-outputs --state-file FILE",
  "| field --release-directory DIR --unit ID --field version|tag|title|previous-tag",
  "| artifact --release-directory DIR --unit ID",
  "| assets --release-directory DIR --unit ID",
  "| notes --release-directory DIR --unit ID --output FILE",
  "| require-state --state-file FILE --unit ID --state STATE",
].join(" ");
const COMMANDS = Object.freeze({
  outputs: Object.freeze(["--plan-result"]),
  "preflight-outputs": Object.freeze(["--state-file"]),
  field: Object.freeze(["--release-directory", "--unit", "--field"]),
  artifact: Object.freeze(["--release-directory", "--unit"]),
  assets: Object.freeze(["--release-directory", "--unit"]),
  notes: Object.freeze(["--release-directory", "--unit", "--output"]),
  "require-state": Object.freeze(["--state-file", "--unit", "--state"]),
});

function distinctStrings(values) {
  return Array.isArray(values) && values.every((value) => typeof value === "string") && new Set(values).size === values.length;
}

export function planOutputs(result) {
  if (result?.command !== "check" || result.ok !== true || !distinctStrings(result.order) || result.order.length === 0
      || !distinctStrings(result.gates) || result.gates.some((gate) => !RELEASE_GATES.includes(gate))) throw new Error(PLAN_FAILURE);
  const ordered = dependencyOrder(result.order);
  if (ordered.length !== result.order.length || ordered.some((id, index) => id !== result.order[index])) throw new Error(PLAN_FAILURE);
  return `gates=${JSON.stringify(result.gates)}\nunits=${JSON.stringify(result.order)}\n`;
}

export function preflightOutputs(result) {
  if (result?.command !== "check" || !Array.isArray(result.units) || result.units.length === 0
      || !distinctStrings(result.units.map((unit) => unit?.id))
      || result.units.some((unit) => !PUBLISHABLE_STATES.includes(unit.state) || unitById(unit.id).kind !== unit.kind)) {
    throw new Error(PREFLIGHT_FAILURE);
  }
  const clean = result.units.filter(({ state }) => state === "clean");
  const ofKind = (kind) => clean.filter((unit) => unit.kind === kind).map(({ id }) => id).join(" ");
  return [
    `clean=${JSON.stringify(clean.map(({ id }) => id))}`,
    `clean_units=${clean.map(({ id }) => id).join(" ")}`,
    `gauntlet=${clean.some(({ id }) => id === "gauntlet")}`,
    `skills=${clean.some(({ id }) => id === "skills")}`,
    `npm=${ofKind("npm")}`,
    `composer=${ofKind("composer")}`,
    `maven=${ofKind("maven")}`,
    // Package units never depend on gauntlet or skills, so the workflow publishes and releases them first.
    `packages=${dependencyOrder(clean.filter(({ kind }) => PACKAGE_KINDS.includes(kind)).map(({ id }) => id)).join(" ")}`,
    "",
  ].join("\n");
}

export function unitTitle(unitId, version) {
  const unit = unitById(unitId);
  if (unit.id === "gauntlet") return `Gauntlet v${version}`;
  if (unit.id === "skills") return `Gauntlet skills ${version}`;
  return `${unit.artifacts[0]} ${version}`;
}

function manifestUnit(manifest, unitId) {
  const matches = Array.isArray(manifest?.units) ? manifest.units.filter(({ id }) => id === unitId) : [];
  if (matches.length !== 1) throw new Error(`Release unit ${String(unitId)} is not in this release set`);
  return matches[0];
}

export function unitField(manifest, unitId, field) {
  const unit = manifestUnit(manifest, unitId);
  if (field === "version") return unit.version;
  if (field === "tag") return unit.tag;
  if (field === "title") return unitTitle(unit.id, unit.version);
  throw new TypeError("Unknown release unit field");
}

// The tag a unit's generated notes start from: the plan's `from` version, which plan --check bound to
// the latest unit tag; empty for a first release.
export function previousUnitTag(manifest, plan, unitId) {
  const unit = manifestUnit(manifest, unitId);
  const planned = plan.units.find(({ id }) => id === unit.id);
  if (planned === undefined || planned.to !== unit.version) throw new Error(`Release unit ${unit.id} is not planned at its staged version`);
  return planned.from === null ? "" : unitTag(unitById(unit.id), planned.from);
}

// Resolves a manifest-relative path to a regular file that is canonical (no symbolic link at any
// component) and lies inside the canonical release directory.
function stagedFile(releaseDirectory, relativePath) {
  const segments = typeof relativePath === "string" ? relativePath.split("/") : [];
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\")
      || segment.includes("\0"))) throw new Error(`Staged release file ${String(relativePath)} is invalid`);
  const path = resolve(releaseDirectory, ...segments);
  let stat;
  try {
    if (realpathSync(releaseDirectory) !== releaseDirectory) throw new Error();
    stat = lstatSync(path);
    if (!path.startsWith(`${releaseDirectory}${sep}`) || realpathSync(path) !== path || !stat.isFile()) throw new Error();
  } catch {
    throw new Error(`Staged release file ${relativePath} is missing or not canonical`);
  }
  return path;
}

// Hashes one canonical staged file through a descriptor that refuses a symbolic link.
function stagedFileSha256(path, relativePath) {
  const failure = `Staged release file ${relativePath} is missing or not canonical`;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
  } catch {
    throw new Error(failure);
  }
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(failure);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } catch {
    throw new Error(failure);
  } finally {
    closeSync(descriptor);
  }
}

export function unitArtifactPath(releaseDirectory, manifest, unitId) {
  const unit = manifestUnit(manifest, unitId);
  if (!ARCHIVE_KINDS.includes(unitById(unit.id).kind)) throw new Error(`Release unit ${unit.id} has no registry archive`);
  const artifacts = manifest.artifacts.filter((artifact) => artifact.unit === unit.id);
  if (artifacts.length !== 1) throw new Error(`Release unit ${unit.id} must stage exactly one archive`);
  const path = stagedFile(releaseDirectory, artifacts[0].path);
  if (stagedFileSha256(path, artifacts[0].path) !== artifacts[0].sha256) {
    throw new Error(`Staged release file ${artifacts[0].path} does not match its manifest hash`);
  }
  return path;
}

export function unitAssetPaths(releaseDirectory, manifest, unitId) {
  return Object.freeze(unitReleaseAssets(manifest, unitId).map(({ path }) => stagedFile(releaseDirectory, path)));
}

export function releaseNotes({ changelog, compatibility, releaseSet }) {
  const tail = `${compatibility}\n\nRelease set \`${releaseSet}\`.\n`;
  return changelog === null
    ? Object.freeze({ mode: "generated", text: tail })
    : Object.freeze({ mode: "changelog", text: `${changelog}\n\n${tail}` });
}

export function requireUnitState(result, unitId, state) {
  const unit = Array.isArray(result?.units) ? result.units.find((entry) => entry?.id === unitId) : undefined;
  if (unit?.state !== state) throw new Error(`Release unit ${String(unitId)} is not ${String(state)}`);
}

// Reads one regular file without following a symbolic link at the final component; null when absent.
function readRegularFile(path, { optional }) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAXIMUM_INPUT_BYTES) throw new Error(READ_FAILURE);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(READ_FAILURE);
      offset += count;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new Error(READ_FAILURE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readRegularFile(path, { optional: false }));
  } catch {
    throw new Error(READ_FAILURE);
  }
}

function unitChangelog(root, unitId, version) {
  const absolute = resolve(root, ...changelogPath(unitId).split("/"));
  const entry = lstatSync(absolute, { throwIfNoEntry: false });
  if (entry === undefined || entry.isDirectory()) return null;
  let real;
  try {
    real = realpathSync(absolute);
  } catch {
    return null;
  }
  if (!real.startsWith(`${root}${sep}`)) throw new Error(READ_FAILURE);
  const source = readRegularFile(absolute, { optional: true });
  return source === null ? null : changelogSection(source, version);
}

function unitCompatibility(root, unitId, version) {
  let entries;
  try {
    entries = readCompatibilityDocument(root);
  } catch {
    throw new Error(READ_FAILURE);
  }
  const entry = entries.find(({ id }) => id === unitId);
  if (entry.version !== version) throw new Error(`Compatibility document records ${unitId} ${entry.version}, not the released ${version}`);
  return compatibilityLine(unitId, entries);
}

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string") || argv.length === 0) throw new TypeError(USAGE);
  const [command, ...rest] = argv;
  const flags = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (flags === undefined || rest.length !== flags.length * 2) throw new TypeError(USAGE);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if (!flags.includes(flag) || Object.hasOwn(values, flag) || value === "" || value.startsWith("--")) throw new TypeError(USAGE);
    values[flag] = value;
  }
  for (const flag of ["--plan-result", "--state-file", "--release-directory", "--output"]) {
    if (Object.hasOwn(values, flag) && (!isAbsolute(values[flag]) || values[flag].includes("\0"))) throw new TypeError(USAGE);
  }
  if (Object.hasOwn(values, "--unit")) unitById(values["--unit"]);
  if (command === "field" && !FIELDS.includes(values["--field"])) throw new TypeError(USAGE);
  if (command === "require-state" && !REQUIRABLE_STATES.includes(values["--state"])) throw new TypeError(USAGE);
  return Object.freeze({ command, values: Object.freeze(values) });
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function runReleaseSetCli(argv, { root = ROOT } = {}) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const { command, values } = parsed;
    let stdout;
    if (command === "outputs") {
      stdout = planOutputs(readJson(values["--plan-result"]));
    } else if (command === "preflight-outputs") {
      stdout = preflightOutputs(readJson(values["--state-file"]));
    } else if (command === "require-state") {
      requireUnitState(readJson(values["--state-file"]), values["--unit"], values["--state"]);
      stdout = "";
    } else {
      const unitId = values["--unit"];
      const { manifest } = readReleaseManifest(values["--release-directory"]);
      const releaseDirectory = realpathSync(values["--release-directory"]);
      if (command === "field" && values["--field"] === "previous-tag") {
        stdout = `${previousUnitTag(manifest, readReleasePlan(root), unitId)}\n`;
      } else if (command === "field") {
        stdout = `${unitField(manifest, unitId, values["--field"])}\n`;
      } else if (command === "artifact") {
        stdout = `${unitArtifactPath(releaseDirectory, manifest, unitId)}\n`;
      } else if (command === "assets") {
        stdout = unitAssetPaths(releaseDirectory, manifest, unitId).map((path) => `${path}\n`).join("");
      } else {
        const { version } = manifestUnit(manifest, unitId);
        const notes = releaseNotes({
          changelog: unitChangelog(root, unitId, version),
          compatibility: unitCompatibility(root, unitId, version),
          releaseSet: manifest.releaseSet,
        });
        writeFileSync(values["--output"], notes.text, { flag: "wx", mode: 0o644 });
        stdout = `${notes.mode}\n`;
      }
    }
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "RELEASE_SET_FAILED", message: error instanceof Error ? error.message : READ_FAILURE }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runReleaseSetCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
