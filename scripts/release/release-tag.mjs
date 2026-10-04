#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_PLAN_PATH, readReleasePlan, readRepositoryTags, validatePlanAgainstManifests, validatePlanAgainstTags,
} from "./plan.mjs";
import { readUnitVersions } from "./release-model.mjs";

const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: release-tag.mjs [--dry-run]";
const COMMIT = /^[0-9a-f]{40}$/u;
const SET_TAG = /^release-([0-9]{4}-[0-9]{2}-[0-9]{2})\.([1-9][0-9]{0,2})$/u;

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function nextReleaseTag(now, tags) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("Release tag date is invalid");
  const date = now.toISOString().slice(0, 10);
  let highest = 0;
  for (const name of tags.keys()) {
    const match = SET_TAG.exec(name);
    if (match !== null && match[1] === date) highest = Math.max(highest, Number(match[2]));
  }
  if (highest >= 999) throw new Error("No release-set tag number is left for today");
  return `release-${date}.${highest + 1}`;
}

export function releaseTagMessage(tag, plan) {
  const lines = plan.units.map(({ id, from, to }) => `${id} ${from ?? "none"} -> ${to}`);
  return `Release set ${tag}\n\n${lines.join("\n")}\n`;
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

export function prepareReleaseTag({ root, now, git, readVersions, readTags }) {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.status !== 0 || status.stdout !== "") throw new Error("Working tree is not clean");
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const commit = head.stdout.trim();
  if (head.status !== 0 || !COMMIT.test(commit)) throw new Error("HEAD is not a commit");
  if (git(["merge-base", "--is-ancestor", commit, "origin/main"]).status !== 0) {
    throw new Error("HEAD is not contained in origin/main");
  }
  const plan = readReleasePlan(root, RELEASE_PLAN_PATH);
  if (plan.units.length === 0) throw new Error("Release plan has no units");
  const versions = readVersions(root);
  const tags = readTags(root);
  const problems = [...validatePlanAgainstManifests(plan, versions), ...validatePlanAgainstTags(plan, { versions, tags })];
  if (problems.length > 0) throw new Error(`Release plan is not releasable: ${problems.join("; ")}`);
  const tag = nextReleaseTag(now, tags);
  return Object.freeze({ tag, commit, plan, message: releaseTagMessage(tag, plan) });
}

export function runReleaseTagCli(argv, {
  root = REPOSITORY_ROOT,
  now = new Date(),
  git = defaultGit(root),
  readVersions = readUnitVersions,
  readTags = readRepositoryTags,
} = {}) {
  if (!Array.isArray(argv) || !(argv.length === 0 || (argv.length === 1 && argv[0] === "--dry-run"))) {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const prepared = prepareReleaseTag({ root, now, git, readVersions, readTags });
    const dryRun = argv.length === 1;
    if (!dryRun) {
      const created = git(["tag", "--annotate", prepared.tag, "--message", prepared.message, prepared.commit]);
      const peeled = git(["rev-parse", "--verify", `refs/tags/${prepared.tag}^{commit}`]);
      const type = git(["cat-file", "-t", `refs/tags/${prepared.tag}`]);
      if (created.status !== 0 || peeled.stdout.trim() !== prepared.commit || type.stdout.trim() !== "tag") {
        throw new Error("Release-set tag creation failed");
      }
    }
    return {
      exitCode: 0,
      stdout: jsonLine({
        command: "tag", created: !dryRun, tag: prepared.tag, commit: prepared.commit, units: prepared.plan.units,
        push: `git push origin refs/tags/${prepared.tag}`,
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "RELEASE_TAG_FAILED", message: error instanceof Error ? error.message : "Release-set tag failed" }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runReleaseTagCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
