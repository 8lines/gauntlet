#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  collectVersionMismatches,
  parseReleaseVersion,
  readReleaseVersion,
  readUnitVersions,
  setReleaseVersion,
  setUnitVersions,
} from "./release-model.mjs";
import { readReleasePlan, validatePlanAgainstManifests } from "./plan.mjs";
import { unitById } from "./units.mjs";

const USAGE = "Usage: version.mjs --check [--plan PATH] | --set X.Y.Z | --set-unit UNIT X.Y.Z";
// readReleasePlan fails with one of these fixed, value-free messages; anything else is reported generically.
const PLAN_MISSING = "Release plan is missing or unsafe";
const PLAN_MESSAGES = new Set(["Release plan is invalid", PLAN_MISSING, "Release plan path must stay inside the repository"]);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function invalidArguments() {
  return new Error(USAGE);
}

function parseArgumentVersion(value) {
  if (typeof value !== "string") throw invalidArguments();
  try {
    return parseReleaseVersion(`${value}\n`);
  } catch {
    throw invalidArguments();
  }
}

export function parseVersionCommand(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) throw invalidArguments();
  if (argv.length === 1 && argv[0] === "--check") return { command: "check" };
  if (argv.length === 3 && argv[0] === "--check" && argv[1] === "--plan" && argv[2].length > 0) {
    return { command: "check", plan: argv[2] };
  }
  if (argv.length === 2 && argv[0] === "--set") {
    return { command: "set", version: parseArgumentVersion(argv[1]) };
  }
  if (argv.length === 3 && argv[0] === "--set-unit") {
    try {
      unitById(argv[1]);
    } catch {
      throw invalidArguments();
    }
    return { command: "set-unit", unit: argv[1], version: parseArgumentVersion(argv[2]) };
  }
  throw invalidArguments();
}

function planMismatches(root, path) {
  let plan;
  try {
    plan = readReleasePlan(root, path);
  } catch (error) {
    return [`plan: ${error instanceof Error && PLAN_MESSAGES.has(error.message) ? error.message : PLAN_MISSING}`];
  }
  let versions;
  try {
    versions = readUnitVersions(root);
  } catch {
    // An unreadable unit is already a version mismatch; the plan is compared once every unit reads.
    return [];
  }
  return validatePlanAgainstManifests(plan, versions).map((problem) => `plan: ${problem}`);
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function runVersionCli(argv, { root = REPOSITORY_ROOT } = {}) {
  let command;
  try {
    command = parseVersionCommand(argv);
  } catch {
    return {
      exitCode: 2,
      stdout: "",
      stderr: jsonLine({
        error: { code: "INVALID_ARGUMENTS", message: USAGE },
        ok: false,
      }),
    };
  }

  if (typeof root !== "string" || root.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "VERSION_COMMAND_FAILED", message: "Version command failed safely" }, ok: false }),
    };
  }

  try {
    if (command.command === "check") {
      const version = readReleaseVersion(root);
      const mismatches = collectVersionMismatches(root);
      if (command.plan !== undefined) mismatches.push(...planMismatches(root, command.plan));
      // stage, verify and dry-run parse stdout as exactly one JSON line, so the per-unit
      // "<unit> <version>" lines travel inside that record instead of as extra output lines.
      const units = mismatches.length === 0
        ? [...readUnitVersions(root)].map(([id, unitVersion]) => `${id} ${unitVersion}`)
        : [];
      return {
        exitCode: mismatches.length === 0 ? 0 : 1,
        stdout: jsonLine({
          command: "check",
          mismatches,
          ok: mismatches.length === 0,
          plan: command.plan ?? null,
          units,
          version,
        }),
        stderr: "",
      };
    }

    if (command.command === "set-unit") {
      const result = setUnitVersions(root, { [command.unit]: command.version });
      return {
        exitCode: 0,
        stdout: jsonLine({
          changedPaths: result.changedPaths,
          command: "set-unit",
          ok: true,
          unit: command.unit,
          version: command.version,
        }),
        stderr: "",
      };
    }

    const result = setReleaseVersion(root, command.version);
    return {
      exitCode: 0,
      stdout: jsonLine({
        changedPaths: result.changedPaths,
        command: "set",
        ok: true,
        version: result.version,
      }),
      stderr: "",
    };
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "VERSION_COMMAND_FAILED", message: "Version command failed safely" }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runVersionCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
