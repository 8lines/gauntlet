import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseVersion } from "./release-model.mjs";
import { RELEASE_UNITS, unitTag } from "./units.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = "Usage: node scripts/release/baseline-tags.mjs --commit <sha> [--apply]";
const MAX_GIT_OUTPUT = 1024 * 1024;

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitOrThrow(root, args, message) {
  const result = git(root, args);
  if (result.status !== 0) throw new Error(`${message}: ${result.stderr.trim()}`);
  return result.stdout;
}

function resolveCommit(root, commit) {
  if (typeof commit !== "string" || commit === "" || commit.startsWith("-")) {
    throw new Error("baseline commit is missing or malformed");
  }
  const result = git(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (result.status !== 0) throw new Error(`baseline commit ${commit} does not resolve to a commit`);
  return result.stdout.trim();
}

function readBlob(root, sha, path) {
  const spec = `${sha}:${path}`;
  if (git(root, ["cat-file", "-e", spec]).status !== 0) return undefined;
  return gitOrThrow(root, ["show", spec], `cannot read ${path} at ${sha}`);
}

function jsonVersion(text, path, keyPath) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Release version in ${path} is not valid JSON`);
  }
  for (const key of keyPath) value = value !== null && typeof value === "object" ? value[key] : undefined;
  if (typeof value !== "string") throw new Error(`Manifest version in ${path} must be a string`);
  return `${value}\n`;
}

function unitVersionAt(root, sha, unit, lockstepVersion) {
  const { path } = unit.version;
  const text = readBlob(root, sha, path);
  if (text === undefined) return lockstepVersion();
  return parseReleaseVersion(unit.version.type === "json" ? jsonVersion(text, path, unit.version.keyPath) : text);
}

export function planBaselineTags({ root, commit }) {
  const sha = resolveCommit(root, commit);
  let lockstep;
  const lockstepVersion = () => {
    if (lockstep === undefined) {
      const text = readBlob(root, sha, "VERSION");
      if (text === undefined) throw new Error(`VERSION does not exist at ${sha}`);
      lockstep = parseReleaseVersion(text);
    }
    return lockstep;
  };

  const create = [];
  const existing = [];
  for (const unit of RELEASE_UNITS) {
    const version = unitVersionAt(root, sha, unit, lockstepVersion);
    const tag = unitTag(unit, version);
    const found = git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
    // The application tag v<version> is the published application release, so this tool never creates
    // it: it must already exist and peel to the baseline commit.
    if (unit.id === "gauntlet" && (found.status !== 0 || found.stdout.trim() !== sha)) {
      throw new Error(`baseline requires existing tag ${tag} at ${sha}`);
    }
    if (found.status !== 0) {
      create.push({ tag, unit: unit.id, version });
      continue;
    }
    const target = found.stdout.trim();
    if (target !== sha) throw new Error(`baseline tag ${tag} already points at ${target}`);
    existing.push({ tag, target });
  }
  return { create, existing };
}

export function applyBaselineTags({ root, commit }) {
  const plan = planBaselineTags({ root, commit });
  const sha = resolveCommit(root, commit);
  for (const { tag, unit, version } of plan.create) {
    gitOrThrow(root, ["tag", "-a", tag, "-m", `${unit} ${version} baseline`, sha], `cannot create tag ${tag}`);
  }
  return plan;
}

function parseArguments(argv) {
  let commit;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply" && !apply) apply = true;
    else if (argument === "--commit" && commit === undefined && index + 1 < argv.length) {
      index += 1;
      commit = argv[index];
    } else throw new Error(USAGE);
  }
  if (commit === undefined) throw new Error(USAGE);
  return { commit, apply };
}

function formatPlan({ create, existing }, applied) {
  const lines = [
    ...create.map(({ tag, unit, version }) => `${applied ? "created" : "create"} ${tag} ${unit} ${version}`),
    ...existing.map(({ tag, target }) => `exists ${tag} ${target}`),
  ];
  if (!applied) lines.push(`${create.length} to create, ${existing.length} existing (dry run; pass --apply to create tags locally)`);
  else lines.push(`${create.length} created, ${existing.length} already existed (nothing was pushed)`);
  return `${lines.join("\n")}\n`;
}

export function runBaselineTagsCli(argv, { root = ROOT } = {}) {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${error.message}\n` };
  }
  try {
    const plan = parsed.apply ? applyBaselineTags({ root, commit: parsed.commit }) : planBaselineTags({ root, commit: parsed.commit });
    return { exitCode: 0, stdout: formatPlan(plan, parsed.apply), stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${error.message}\n` };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runBaselineTagsCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
