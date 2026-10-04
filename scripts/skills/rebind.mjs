#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { hashEvaluationInputs } from "./evaluation-content.mjs";
import { generateExternalInputsManifest } from "./external-inputs.mjs";
import { hashSkill } from "./skill-content.mjs";
import { validateSkill } from "./validate.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
export const REBINDING_LOG_HEADING = "## Re-binding log";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REASON = /^[A-Z][^\n—]{0,598}\.$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const PHASES = Object.freeze(["baseline", "guided", "forward"]);
const FAILURE = "Evaluation receipts could not be re-bound";
const USAGE = 'Usage: rebind.mjs --reason "<Sentence ending with a period.>" [--date YYYY-MM-DD]';

export function assertOnlyHashesChanged(before, after) {
  const frame = (text) => ({ rest: text.split(/[0-9a-f]{64}/u), count: text.match(/[0-9a-f]{64}/gu)?.length ?? 0 });
  const left = frame(before);
  const right = frame(after);
  if (left.count !== right.count || left.rest.length !== right.rest.length
      || left.rest.some((part, index) => part !== right.rest[index])) {
    throw new Error("Re-binding changed more than 64-hex hash values");
  }
}

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validReason(value) {
  return typeof value === "string" && REASON.test(value);
}

export function rebindingLogEntry(date, reason) {
  if (!validDate(date) || !validReason(reason)) throw new TypeError(USAGE);
  return `- ${date}: ${reason} Hashes were re-bound to the current bytes without new model samples; this confirms content integrity, not behaviour.`;
}

export function appendRebindingLog(source, entry) {
  const headings = source.split("\n").filter((line) => line.startsWith("## "));
  const position = headings.indexOf(REBINDING_LOG_HEADING);
  if (position >= 0 && position !== headings.length - 1) {
    throw new Error("The Re-binding log must be the last section of EVALUATING.md");
  }
  const body = source.replace(/\n+$/u, "");
  if (position < 0) return `${body}\n\n${REBINDING_LOG_HEADING}\n\n${entry}\n`;
  if (body.split("\n").at(-1) === entry) return source;
  return `${body}\n${entry}\n`;
}

export function parseRebindArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0 || argv.some((value) => typeof value !== "string")) {
    throw new TypeError(USAGE);
  }
  let reason;
  let date;
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === "--reason" && reason === undefined && validReason(value)) reason = value;
    else if (flag === "--date" && date === undefined && validDate(value)) date = value;
    else throw new TypeError(USAGE);
  }
  if (reason === undefined) throw new TypeError(USAGE);
  return Object.freeze({ reason, date: date ?? new Date().toISOString().slice(0, 10) });
}

function writeAtomically(path, text, mode) {
  const scratch = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(scratch, text, { flag: "wx", mode });
  try {
    renameSync(scratch, path);
  } catch (error) {
    unlinkSync(scratch);
    throw error;
  }
}

function replaceOnce(text, from, to) {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`${FAILURE}: ${from.split(":")[0]} does not occur exactly once`);
  return parts.join(to);
}

function evaluationNames(root) {
  return readdirSync(resolve(root, "skill-evals"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && NAME.test(entry.name))
    .map(({ name }) => name)
    .filter((name) => {
      try {
        return lstatSync(resolve(root, "skill-evals", name, "verification.json")).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

async function rebindOne(root, name, reason, date, journal) {
  const evaluationRoot = resolve(root, "skill-evals", name);
  const track = (path) => {
    if (!journal.has(path)) journal.set(path, { bytes: readFileSync(path), mode: lstatSync(path).mode & 0o777 });
    return journal.get(path);
  };
  const receiptPath = join(evaluationRoot, "verification.json");
  const externalPath = join(evaluationRoot, "external-inputs.json");
  const logPath = join(evaluationRoot, "EVALUATING.md");
  const receiptSource = readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(receiptSource);

  const external = track(externalPath);
  const manifest = JSON.parse(external.bytes.toString("utf8"));
  unlinkSync(externalPath);
  const externalInputsSha256 = generateExternalInputsManifest({
    root,
    evaluationRoot,
    sourceFiles: manifest.sourceFiles.map(({ path }) => path),
    sourceTrees: manifest.sourceTrees.map(({ path, excludedTopLevel }) => ({ path, excludedTopLevel })),
    linkedRuntimeTrees: manifest.linkedRuntimeTrees.map(({ path }) => path),
  });
  chmodSync(externalPath, external.mode);
  assertOnlyHashesChanged(external.bytes.toString("utf8"), readFileSync(externalPath, "utf8"));
  const skillSha256 = await hashSkill(resolve(root, "skills", name));
  let evaluationSha256 = hashEvaluationInputs(evaluationRoot);

  const changed = [];
  if (externalInputsSha256 !== receipt.externalInputsSha256 || skillSha256 !== receipt.skillSha256
      || evaluationSha256 !== receipt.evaluationSha256) {
    const log = track(logPath);
    const logSource = log.bytes.toString("utf8");
    const nextLog = appendRebindingLog(logSource, rebindingLogEntry(date, reason));
    if (!nextLog.startsWith(logSource.replace(/\n+$/u, ""))) throw new Error(`${FAILURE}: EVALUATING.md changed above its log`);
    writeAtomically(logPath, nextLog, log.mode);
    evaluationSha256 = hashEvaluationInputs(evaluationRoot);

    const fields = [
      ["evaluationSha256", receipt.evaluationSha256, evaluationSha256],
      ["externalInputsSha256", receipt.externalInputsSha256, externalInputsSha256],
      ["skillSha256", receipt.skillSha256, skillSha256],
    ];
    let nextReceipt = receiptSource;
    for (const [key, from, to] of fields) nextReceipt = replaceOnce(nextReceipt, `"${key}": "${from}"`, `"${key}": "${to}"`);
    for (const phase of PHASES) {
      const path = resolve(evaluationRoot, ...receipt[phase].transcript.split("/"));
      if (!path.startsWith(`${evaluationRoot}${sep}`)) throw new Error(`${FAILURE}: ${phase} transcript escapes the evaluation`);
      const transcript = track(path);
      const before = transcript.bytes.toString("utf8");
      // Baseline records carry "skillSha256":null and are never bound to a skill hash.
      const recordFields = fields.filter(([key]) => !(key === "skillSha256" && phase === "baseline"));
      const after = before.split("\n").map((line) => (line === ""
        ? line
        : recordFields.reduce((text, [key, from, to]) => replaceOnce(text, `"${key}":"${from}"`, `"${key}":"${to}"`), line)))
        .join("\n");
      assertOnlyHashesChanged(before, after);
      writeAtomically(path, after, transcript.mode);
      nextReceipt = replaceOnce(
        nextReceipt,
        `"transcriptSha256": "${receipt[phase].transcriptSha256}"`,
        `"transcriptSha256": "${createHash("sha256").update(after, "utf8").digest("hex")}"`,
      );
      changed.push(path);
    }
    assertOnlyHashesChanged(receiptSource, nextReceipt);
    writeAtomically(receiptPath, nextReceipt, track(receiptPath).mode);
    changed.push(logPath, externalPath, receiptPath);
  }

  const { errors } = await validateSkill({ root, name });
  if (errors.length > 0) throw new Error(`${FAILURE}: ${name}: ${errors.join("; ")}`);
  return Object.freeze({
    name,
    changed: Object.freeze(changed.map((path) => relative(root, path).split(sep).join("/")).sort()),
  });
}

export async function rebindEvaluations({ root, reason, date, names } = {}) {
  if (typeof root !== "string" || resolve(root) !== root) throw new TypeError(USAGE);
  rebindingLogEntry(date, reason);
  const selected = names ?? evaluationNames(root);
  if (!Array.isArray(selected) || selected.length === 0 || selected.some((name) => typeof name !== "string" || !NAME.test(name))) {
    throw new TypeError(USAGE);
  }
  const journal = new Map();
  try {
    const skills = [];
    for (const name of selected) skills.push(await rebindOne(root, name, reason, date, journal));
    return Object.freeze({ skills: Object.freeze(skills) });
  } catch (error) {
    for (const [path, { bytes, mode }] of journal) {
      try {
        unlinkSync(path);
      } catch {
        // The external-input manifest is absent when its regeneration failed.
      }
      writeFileSync(path, bytes, { flag: "wx", mode });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith(FAILURE) ? message : `${FAILURE}: ${message}`);
  }
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export async function runRebindCli(argv, { root = ROOT } = {}) {
  let options;
  try {
    options = parseRebindArguments(argv);
  } catch {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const { skills } = await rebindEvaluations({ root, ...options });
    return { exitCode: 0, stdout: jsonLine({ ok: true, skills }), stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "REBIND_FAILED", message: error instanceof Error ? error.message : FAILURE }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRebindCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
