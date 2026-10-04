#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rebindEvaluations } from "../skills/rebind.mjs";
import { CHANGES_DIRECTORY, computeRelease, readChangeFiles } from "./changes.mjs";
import { changelogPath, insertChangelogSection, renderChangelogSection } from "./changelog.mjs";
import {
  COMPATIBILITY_PATH, compatibilityProblems, readCompatibilityDocument, renderCompatibilityDocument, updateCompatibilityEntries,
} from "./compatibility.mjs";
import { repinComposerLocks } from "./composer-locks.mjs";
import {
  RELEASE_PLAN_PATH, buildReleasePlan, createReleasePlan, latestUnitVersion, readRepositoryTags, serializeReleasePlan,
  writeReleasePlan,
} from "./plan.mjs";
import { collectUnitVersionMismatches, readUnitVersions, setUnitVersions } from "./release-model.mjs";
import { RELEASE_UNITS } from "./units.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: prepare.mjs";

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function defaultGit(root) {
  return (args) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/dev/null", LANG: "C", LC_ALL: "C" },
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function assertPreparable(git) {
  const tracked = git(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (tracked.status !== 0 || tracked.stdout !== "") {
    throw new Error("Tracked files have local modifications; commit or stash them before preparing a release");
  }
  const changes = git(["status", "--porcelain=v1", "--untracked-files=all", "--", CHANGES_DIRECTORY]);
  if (changes.status !== 0 || changes.stdout !== "") throw new Error("Commit every change file before preparing a release");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status !== 0 || branch.stdout.trim() === "main") throw new Error("Prepare a release on a branch from main, not on main");
  if (branch.stdout.trim() === "HEAD") throw new Error("Prepare a release on a branch from main, not on a detached HEAD");
}

export function assertVersionsAtLatestTags(versions, tags) {
  const problems = [];
  for (const { id } of RELEASE_UNITS) {
    const latest = latestUnitVersion(id, tags);
    if (latest === null) problems.push(`${id} has no release tag`);
    else if (latest !== versions.get(id)) problems.push(`${id} is at ${versions.get(id)} but its latest tag is ${latest}`);
  }
  if (problems.length > 0) {
    throw new Error(`Release preparation needs every unit at its latest tag; run git fetch --tags origin, and release an already prepared plan first: ${problems.join("; ")}`);
  }
}

function readChangelog(root, path) {
  const absolute = resolve(root, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new Error(`${path}: changelog is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path}: changelog is not a regular file`);
  return readFileSync(absolute, "utf8");
}

// Every changelog insertion is rendered and validated before the first write, so a hand-written
// Unreleased entry or an existing version section refuses before any version moves or Docker runs.
function renderChangelogs(root, units, date) {
  return Object.freeze(units.map((unit) => {
    const path = changelogPath(unit.id);
    try {
      return Object.freeze({
        path,
        source: insertChangelogSection(readChangelog(root, path), renderChangelogSection({ version: unit.to, date, entries: unit.entries })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith(`${path}: `) ? message : `${path}: ${message}`);
    }
  }));
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// Untracked, non-ignored paths with wholly untracked directories collapsed to `dir/`.
function untrackedPaths(git) {
  const result = git(["ls-files", "--others", "--exclude-standard", "--directory", "-z"]);
  if (result.status !== 0) throw new Error("git could not list untracked files");
  return new Set(result.stdout.split("\0").filter((path) => path !== ""));
}

// The preflight proved every tracked file equals HEAD, so restoring HEAD restores the starting tree;
// anything untracked that appeared during preparation is removed, and an untracked plan gets its bytes back.
function restore(git, root, { untracked, created, plan }) {
  const problems = [];
  const restored = git(["restore", "--source=HEAD", "--worktree", "--", "."]);
  if (restored.status !== 0) problems.push(`git restore failed: ${restored.stderr.trim()}`);
  let appeared = [];
  try {
    appeared = [...untrackedPaths(git)].filter((path) => !untracked.has(path));
  } catch (error) {
    problems.push(error.message);
  }
  for (const path of new Set([...appeared, ...created])) {
    try {
      rmSync(resolve(root, path), { recursive: true, force: true });
    } catch {
      problems.push(`${path} could not be removed`);
    }
  }
  if (plan !== null) {
    try {
      writeFileSync(resolve(root, RELEASE_PLAN_PATH), plan);
    } catch {
      problems.push(`${RELEASE_PLAN_PATH} could not be restored`);
    }
  }
  return problems;
}

function verifyPrepared(root, plan, tags) {
  const mismatches = collectUnitVersionMismatches(root);
  if (mismatches.length > 0) throw new Error(`Prepared version slots are inconsistent: ${mismatches.join("; ")}`);
  if (serializeReleasePlan(buildReleasePlan(readUnitVersions(root), tags)) !== serializeReleasePlan(createReleasePlan(plan.units))) {
    throw new Error("Prepared manifests do not match the release plan");
  }
  if (readChangeFiles(root).length > 0) throw new Error("Change files remain after preparation");
}

export async function prepareRelease({
  root = ROOT,
  now = new Date(),
  git = defaultGit(root),
  readTags = readRepositoryTags,
  repinComposer = repinComposerLocks,
  rebind = rebindEvaluations,
} = {}) {
  assertPreparable(git);
  const mismatches = collectUnitVersionMismatches(root);
  if (mismatches.length > 0) throw new Error(`Release version slots are inconsistent; fix them first: ${mismatches.join("; ")}`);
  const versions = readUnitVersions(root);
  const tags = readTags(root);
  assertVersionsAtLatestTags(versions, tags);
  const release = computeRelease({ versions, changes: readChangeFiles(root) });
  const plan = createReleasePlan(release.units.map(({ id, from, to }) => ({ id, from, to })), { changes: release.consumed });
  const recorded = readCompatibilityDocument(root);
  const incompatible = compatibilityProblems(plan, recorded);
  if (incompatible.length > 0) throw new Error(`Release plan is incompatible: ${incompatible.join("; ")}`);
  const date = now.toISOString().slice(0, 10);
  const changelogs = renderChangelogs(root, release.units, date);
  const created = [];
  const untracked = untrackedPaths(git);
  const previousPlan = exists(resolve(root, RELEASE_PLAN_PATH)) ? readFileSync(resolve(root, RELEASE_PLAN_PATH)) : null;
  try {
    setUnitVersions(root, new Map(release.units.map(({ id, to }) => [id, to])));
    const composerLocks = await repinComposer({ root, versions: readUnitVersions(root), moved: release.units.map(({ id }) => id) });
    for (const { path, source } of changelogs) writeFileSync(resolve(root, path), source);
    writeFileSync(resolve(root, COMPATIBILITY_PATH), renderCompatibilityDocument(updateCompatibilityEntries(recorded, plan)));
    for (const name of release.consumed) unlinkSync(resolve(root, CHANGES_DIRECTORY, name));
    if (!exists(resolve(root, ".release"))) created.push(".release");
    if (!exists(resolve(root, RELEASE_PLAN_PATH))) created.push(RELEASE_PLAN_PATH);
    writeReleasePlan(root, plan);
    await rebind({
      root,
      reason: `Release preparation moved ${plan.units.map(({ id, to }) => `${id} to ${to}`).join(", ")}.`,
      date,
    });
    verifyPrepared(root, plan, tags);
    return Object.freeze({
      command: "prepare",
      ok: true,
      date,
      units: release.units.map(({ id, from, to, bump, cascaded }) => ({ id, from, to, bump, cascaded })),
      order: [...plan.order],
      changes: [...release.consumed],
      composerLocks: [...composerLocks],
    });
  } catch (error) {
    const problems = restore(git, root, { untracked, created, plan: previousPlan });
    if (problems.length === 0) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; restoring the tree also failed, inspect git status: ${problems.join("; ")}`);
  }
}

export async function runPrepareCli(argv, dependencies = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    return { exitCode: 0, stdout: jsonLine(await prepareRelease(dependencies)), stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "PREPARE_FAILED", message: error instanceof Error ? error.message : String(error) }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPrepareCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
