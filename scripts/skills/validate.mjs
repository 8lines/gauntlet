#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";
import { parseDocument } from "yaml";

import { hashSkill, listSkillFiles } from "./skill-content.mjs";
import { hashEvaluationInputs } from "./evaluation-content.mjs";
import { hashExternalInputs } from "./external-inputs.mjs";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INPUT_FAILURE = "Skill validation input is invalid";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

function closedRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) return undefined;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
      return undefined;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function plainArray(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isInteger(length) || length < 1 || length > 256 || Object.keys(descriptors).length !== length + 1) return undefined;
  const items = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
    items.push(descriptor.value);
  }
  return items;
}

function phaseErrors(value, phaseName) {
  const errors = [];
  const phase = closedRecord(value, ["transcript", "transcriptSha256", "scenarioResults"]);
  if (phase === undefined) return [`${phaseName} phase shape is invalid`];
  if (phase.transcript !== `results/${phaseName}.jsonl`) {
    errors.push(`${phaseName} transcript path is invalid`);
  }
  if (typeof phase.transcriptSha256 !== "string" || !SHA256.test(phase.transcriptSha256)) {
    errors.push(`${phaseName} transcript hash is invalid`);
  }
  const results = plainArray(phase.scenarioResults);
  if (results === undefined) return [...errors, `${phaseName} scenario results are invalid`];
  const scenarios = new Set();
  for (const candidate of results) {
    const result = closedRecord(candidate, ["scenario", "samples", "reviewedSamples", "verdict"]);
    if (result === undefined) {
      errors.push(`${phaseName} scenario result shape is invalid`);
      continue;
    }
    if (typeof result.scenario !== "string" || !NAME.test(result.scenario) || result.scenario.length > 200
        || scenarios.has(result.scenario)) {
      errors.push(`${phaseName} scenario identity is invalid`);
    } else scenarios.add(result.scenario);
    const minimum = phaseName === "forward" || result.scenario.startsWith("valid-") ? 1 : 5;
    if (!Number.isInteger(result.samples) || result.samples < minimum || result.samples > 100
        || result.reviewedSamples !== result.samples) errors.push(`${phaseName} samples are not fully reviewed`);
    const allowedVerdicts = phaseName === "baseline" ? ["expected-failure-observed", "pass"] : ["pass"];
    if (!allowedVerdicts.includes(result.verdict)) errors.push(`${phaseName} verdict is invalid`);
  }
  return errors;
}

export function validateEvaluationReceiptShape(value, expectedName, expectedHash) {
  try {
    const errors = [];
    const receipt = closedRecord(value, [
      "schemaVersion", "skill", "skillSha256", "evaluationSha256", "externalInputsSha256", "evaluatedAt",
      "baseline", "guided", "forward", "verdict",
    ]);
    if (receipt === undefined) return ["evaluation receipt shape is invalid"];
    if (receipt.schemaVersion !== 1) errors.push("evaluation schema version is invalid");
    if (typeof receipt.skill !== "string" || !NAME.test(receipt.skill) || receipt.skill !== expectedName) {
      errors.push("evaluation skill identity is invalid");
    }
    if (typeof receipt.skillSha256 !== "string" || !SHA256.test(receipt.skillSha256)
        || receipt.skillSha256 !== expectedHash) errors.push("evaluation hash does not match skill content");
    if (typeof receipt.evaluationSha256 !== "string" || !SHA256.test(receipt.evaluationSha256)) {
      errors.push("evaluation input hash is invalid");
    }
    if (typeof receipt.externalInputsSha256 !== "string" || !SHA256.test(receipt.externalInputsSha256)) {
      errors.push("external input hash is invalid");
    }
    if (typeof receipt.evaluatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.evaluatedAt)
        || Number.isNaN(Date.parse(receipt.evaluatedAt)) || new Date(receipt.evaluatedAt).toISOString() !== receipt.evaluatedAt) {
      errors.push("evaluation timestamp is invalid");
    }
    errors.push(...phaseErrors(receipt.baseline, "baseline"));
    errors.push(...phaseErrors(receipt.guided, "guided"));
    errors.push(...phaseErrors(receipt.forward, "forward"));
    if (receipt.verdict !== "pass") errors.push("evaluation verdict is invalid");
    return errors;
  } catch {
    return ["evaluation receipt shape is invalid"];
  }
}

function parseFrontmatter(source, name, errors) {
  if (source.includes("\r") || source.includes("\0")) {
    errors.push("SKILL.md encoding is invalid");
    return;
  }
  const match = /^---\n([\s\S]*?)\n---\n(?:\n|$)([\s\S]*)$/.exec(source);
  if (match === null) {
    errors.push("SKILL.md frontmatter is invalid");
    return;
  }
  const fields = new Map();
  for (const line of match[1].split("\n")) {
    const field = /^([a-z_]+):[ \t]+(.+)$/.exec(line);
    if (field === null || fields.has(field[1])) {
      errors.push("SKILL.md frontmatter is invalid");
      return;
    }
    fields.set(field[1], field[2]);
  }
  if ([...fields.keys()].sort().join("\0") !== ["description", "name"].sort().join("\0")) {
    errors.push("SKILL.md frontmatter is invalid");
    return;
  }
  if (fields.get("name") !== name) errors.push("frontmatter name does not match skill directory");
  const description = fields.get("description");
  if (description.length > 500 || !description.startsWith("Use when ")
      || /\b(?:then|workflow)\b|(?:^|\s)\d+[.)][ \t]/i.test(description)) {
    errors.push("frontmatter description must contain triggering conditions only");
  }
  const words = match[2].trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 500) errors.push("SKILL.md body must contain at most 500 words");
}

function parseOpenAiMetadata(source, name, errors) {
  if (source.includes("\r") || source.includes("\0")) {
    errors.push("UI metadata is invalid");
    return;
  }
  const match = /^interface:\n  display_name: ("(?:[^"\\]|\\.)*")\n  short_description: ("(?:[^"\\]|\\.)*")\n  default_prompt: ("(?:[^"\\]|\\.)*")\npolicy:\n  allow_implicit_invocation: true\n$/.exec(source);
  if (match === null) {
    errors.push("UI metadata must use the exact quoted closed shape");
    return;
  }
  let displayName;
  let shortDescription;
  let defaultPrompt;
  try {
    [displayName, shortDescription, defaultPrompt] = match.slice(1).map((value) => JSON.parse(value));
  } catch {
    errors.push("UI metadata is invalid");
    return;
  }
  if (displayName.length < 1 || displayName.length > 80 || shortDescription.length < 1 || shortDescription.length > 120
      || defaultPrompt.length < 1 || defaultPrompt.length > 500 || !defaultPrompt.includes(`$${name}`)) {
    errors.push("UI metadata values are invalid");
  }
}

function markdownReferences(source) {
  return [...source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]);
}

function regularText(path, maximumBytes) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(maximumBytes)) {
    throw new Error();
  }
  const bytes = readFileSync(path);
  if (bytes.includes(0)) throw new Error();
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error();
  return source;
}

function transcriptErrors(
  source,
  phaseName,
  phase,
  evaluationRoot,
  evaluationSha256,
  externalInputsSha256,
  skillSha256,
  scorecardCriteria,
  scenarioContracts,
  evaluatedAt,
) {
  const errors = [];
  const expected = new Map(phase.scenarioResults.map((result) => [result.scenario, result]));
  const observed = new Map([...expected].map(([scenario]) => [scenario, new Map()]));
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : [];
  if (lines.length === 0 || lines.some((line) => line.length === 0)) return [`${phaseName} transcript lines are invalid`];
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { errors.push(`${phaseName} transcript JSON is invalid`); continue; }
    const transcriptRecord = closedRecord(record, [
      "phase", "scenario", "sample", "synthetic", "evaluationSha256", "externalInputsSha256", "skillSha256",
      "prompt", "response", "model", "reasoningEffort", "recordedAt", "chosenAction",
      "filesystemDiff", "testOutput", "exitState", "review",
    ]);
    if (transcriptRecord === undefined || transcriptRecord.phase !== phaseName || transcriptRecord.synthetic !== true
        || record.evaluationSha256 !== evaluationSha256
        || record.externalInputsSha256 !== externalInputsSha256
        || record.skillSha256 !== (phaseName === "baseline" ? null : skillSha256)
        || !expected.has(record.scenario)
        || !Number.isInteger(record.sample)) {
      errors.push(`${phaseName} transcript record identity is invalid`);
      continue;
    }
    const result = expected.get(record.scenario);
    if (record.sample < 1 || record.sample > result.samples || observed.get(record.scenario).has(record.sample)) {
      errors.push(`${phaseName} transcript samples are invalid`);
      continue;
    }
    let prompt;
    try {
      prompt = regularText(resolve(evaluationRoot, "prompts", `${record.scenario}.md`), 1024 * 1024);
    } catch {
      errors.push(`${phaseName} transcript prompt source is missing or invalid`);
    }
    if (prompt !== undefined && record.prompt !== prompt) errors.push(`${phaseName} transcript prompt is stale`);
    if (["prompt", "response", "model", "reasoningEffort", "recordedAt", "chosenAction", "filesystemDiff", "testOutput", "exitState"]
      .some((key) => typeof record[key] !== "string" || record[key].length === 0)) {
      errors.push(`${phaseName} transcript record fields are invalid`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.recordedAt)
        || Number.isNaN(Date.parse(record.recordedAt))
        || new Date(record.recordedAt).toISOString() !== record.recordedAt
        || Date.parse(record.recordedAt) > Date.parse(evaluatedAt)) {
      errors.push(`${phaseName} transcript timestamp is invalid`);
    }
    const scenarioContract = scenarioContracts.get(record.scenario);
    // An honest baseline may pick an unsafe action; it is then an observed failure.
    // Guided and forward records must always choose the expected action.
    const unexpectedPressureAction = scenarioContract?.kind === "pressure"
      && record.chosenAction !== scenarioContract.expectedAction;
    if (unexpectedPressureAction && phaseName !== "baseline") {
      errors.push(`${phaseName} transcript selected the wrong pressure action`);
    }
    const review = closedRecord(record.review, ["scorecardFailures", "verdict"]);
    const failures = review?.scorecardFailures;
    if (review === undefined || !Array.isArray(failures)
        || failures.some((failure) => typeof failure !== "string" || failure.length === 0)
        || typeof review.verdict !== "string" || review.verdict.length === 0) {
      errors.push(`${phaseName} transcript review is invalid`);
      continue;
    }
    if (failures.some((failure) => !scorecardCriteria.has(failure))) {
      errors.push(`${phaseName} transcript names an unknown scorecard failure`);
    }
    const passingReviewVerdict = review.verdict === "pass";
    const failingReviewVerdict = review.verdict === "fail";
    if (!passingReviewVerdict && !failingReviewVerdict) {
      errors.push(`${phaseName} transcript review verdict is invalid`);
    }
    if ((passingReviewVerdict && failures.length !== 0) || (failingReviewVerdict && failures.length === 0)) {
      errors.push(`${phaseName} transcript review verdict is invalid`);
    }
    if (unexpectedPressureAction && phaseName === "baseline" && !failingReviewVerdict) {
      errors.push(`${phaseName} transcript selected an unexpected pressure action without a failing review`);
    }
    if (result.verdict === "pass" && !passingReviewVerdict) {
      errors.push(`${phaseName} passing transcript has an invalid review verdict`);
    }
    observed.get(record.scenario).set(record.sample, review.verdict);
  }
  for (const [scenario, result] of expected) {
    const samples = observed.get(scenario);
    if (samples.size !== result.samples || result.reviewedSamples !== samples.size
        || [...samples.keys()].sort((left, right) => left - right)
          .some((sample, index) => sample !== index + 1)) {
      errors.push(`${phaseName} transcript does not reconcile scenario ${scenario}`);
    }
    if (result.verdict === "expected-failure-observed" && ![...samples.values()].includes("fail")) {
      errors.push(`${phaseName} expected failure is not present in the transcript`);
    }
  }
  return errors;
}

function strictYaml(path) {
  const document = parseDocument(regularText(path, 1024 * 1024), {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error();
  return document.toJS({ maxAliasCount: 0, mapAsMap: false });
}

function evaluationContract(evaluationRoot, receipt) {
  const errors = [];
  const scenariosByPhase = {
    baseline: new Map(),
    guided: new Map(),
    forward: new Map(),
  };
  let matrix;
  let scorecard;
  try {
    matrix = strictYaml(resolve(evaluationRoot, "scenarios.yaml"));
    scorecard = strictYaml(resolve(evaluationRoot, "scorecard.yaml"));
  } catch {
    return {
      errors: ["evaluation scenario matrix or scorecard is missing or invalid"],
      scorecardCriteria: new Set(),
      scenariosByPhase,
    };
  }
  const root = closedRecord(matrix, [
    "schemaVersion", "skill", "syntheticOnly", "baselineGuidance", "scenarios", "forwardScenarios",
  ]);
  if (root === undefined || root.schemaVersion !== 1 || root.skill !== receipt.skill
      || root.syntheticOnly !== true || root.baselineGuidance !== "none") {
    errors.push("evaluation scenario matrix root is invalid");
  }
  const matrices = {
    baseline: root?.scenarios,
    guided: root?.scenarios,
    forward: root?.forwardScenarios,
  };
  for (const [phaseName, candidates] of Object.entries(matrices)) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      errors.push(`${phaseName} scenario matrix is invalid`);
      continue;
    }
    const expected = [];
    const identities = new Set();
    for (const candidate of candidates) {
      const scenario = phaseName === "forward"
        ? closedRecord(candidate, ["id", "samples", "prompt"])
        : candidate?.kind === "pressure"
          ? closedRecord(candidate, ["id", "kind", "samples", "expectedAction", "prompt"])
          : closedRecord(candidate, ["id", "kind", "samples", "expectedOverallVerdict", "prompt"]);
      const kindFieldsValid = phaseName === "forward"
        || (scenario?.kind === "pressure" && typeof scenario.expectedAction === "string" && /^[A-Z][A-Z0-9_-]{0,15}$/u.test(scenario.expectedAction))
        || (scenario?.kind === "valid" && typeof scenario.expectedOverallVerdict === "string"
          && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(scenario.expectedOverallVerdict));
      if (scenario === undefined || typeof scenario.id !== "string" || !NAME.test(scenario.id) || identities.has(scenario.id)
          || !Number.isInteger(scenario.samples) || scenario.samples < 1 || scenario.samples > 100
          || scenario.prompt !== `prompts/${scenario.id}.md` || !kindFieldsValid) {
        errors.push(`${phaseName} scenario matrix entry is invalid`);
        continue;
      }
      identities.add(scenario.id);
      scenariosByPhase[phaseName].set(scenario.id, {
        kind: phaseName === "forward" ? "forward" : scenario.kind,
        ...(scenario.kind === "pressure" ? { expectedAction: scenario.expectedAction } : {}),
      });
      expected.push({
        scenario: scenario.id,
        samples: scenario.samples,
        reviewedSamples: scenario.samples,
      });
    }
    const actual = receipt[phaseName].scenarioResults;
    const sameMatrix = Array.isArray(actual) && actual.length === expected.length
      && expected.every((entry, index) => actual[index]?.scenario === entry.scenario
        && actual[index]?.samples === entry.samples
        && actual[index]?.reviewedSamples === entry.reviewedSamples
        && (phaseName === "baseline"
          ? ["pass", "expected-failure-observed"].includes(actual[index]?.verdict)
          : actual[index]?.verdict === "pass"));
    if (!sameMatrix) {
      errors.push(`${phaseName} receipt does not match the scenario matrix`);
    }
  }
  const scorecardRoot = closedRecord(scorecard, [
    "schemaVersion", "required", "forbidden", "validScenarioRequired", "nextjsRequired",
  ]);
  const scorecardCriteria = new Set();
  if (scorecardRoot === undefined || scorecardRoot.schemaVersion !== 1) {
    errors.push("evaluation scorecard root is invalid");
  } else {
    for (const key of ["required", "forbidden", "validScenarioRequired", "nextjsRequired"]) {
      const criteria = plainArray(scorecardRoot[key]);
      if (criteria === undefined || criteria.some((criterion) => typeof criterion !== "string"
          || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(criterion) || scorecardCriteria.has(criterion))) {
        errors.push(`evaluation scorecard ${key} is invalid`);
        continue;
      }
      for (const criterion of criteria) scorecardCriteria.add(criterion);
    }
  }
  return { errors, scorecardCriteria, scenariosByPhase };
}

export async function validateSkill(options) {
  const values = closedRecord(options, ["root", "name"]);
  if (values === undefined || typeof values.root !== "string" || !isAbsolute(values.root) || resolve(values.root) !== values.root
      || typeof values.name !== "string" || !NAME.test(values.name)) throw new Error(INPUT_FAILURE);
  const errors = [];
  const skillDirectory = resolve(values.root, "skills", values.name);
  let files = [];
  let sha256;
  try {
    const rootStat = lstatSync(values.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    files = [...await listSkillFiles(skillDirectory)];
    sha256 = await hashSkill(skillDirectory);
  } catch {
    errors.push("skill layout must contain only regular required files");
  }
  if (sha256 !== undefined) {
    try {
      const sources = new Map(files.map((relativePath) => [
        relativePath,
        regularText(resolve(skillDirectory, ...relativePath.split("/")), 1024 * 1024),
      ]));
      const skillSource = sources.get("SKILL.md");
      parseFrontmatter(skillSource, values.name, errors);
      parseOpenAiMetadata(sources.get("agents/openai.yaml"), values.name, errors);
      const referenceFiles = new Set(files.filter((path) => path.startsWith("references/")));
      const referenced = new Set();
      for (const [owner, source] of sources) {
        if (!owner.endsWith(".md")) continue;
        for (const link of markdownReferences(source)) {
          if (!link.startsWith("references/") || link.includes("\\") || link.split("/").some((part) => part === ".." || part === "." || part === "")) {
            errors.push("Markdown reference escapes the skill");
          } else if (!referenceFiles.has(link)) errors.push("Markdown reference does not resolve");
          else referenced.add(link);
        }
      }
      for (const reference of referenceFiles) {
        if (!referenced.has(reference)) errors.push("skill contains an unused reference file");
      }
      if ([...sources.values()].some((source) => /\b(?:TODO|FIXME|PLACEHOLDER|Lorem ipsum)\b/i.test(source))) {
        errors.push("skill contains scaffold text");
      }
    } catch {
      errors.push("skill regular text could not be validated");
    }
    const evaluationRoot = resolve(values.root, "skill-evals", values.name);
    try {
      const receipt = JSON.parse(regularText(resolve(evaluationRoot, "verification.json"), MAX_RECEIPT_BYTES));
      const receiptErrors = validateEvaluationReceiptShape(receipt, values.name, sha256);
      errors.push(...receiptErrors);
      if (receiptErrors.length === 0) {
        const contract = evaluationContract(evaluationRoot, receipt);
        errors.push(...contract.errors);
        let externalInputsSha256;
        try {
          externalInputsSha256 = hashExternalInputs({ root: values.root, evaluationRoot });
        } catch {
          errors.push("external inputs are missing or invalid");
        }
        if (externalInputsSha256 !== undefined && externalInputsSha256 !== receipt.externalInputsSha256) {
          errors.push("external input hash is stale");
        }
        if (hashEvaluationInputs(evaluationRoot) !== receipt.evaluationSha256) {
          errors.push("evaluation input hash is stale");
        }
        for (const phaseName of ["baseline", "guided", "forward"]) {
          const transcript = receipt[phaseName].transcript;
          const transcriptPath = resolve(evaluationRoot, ...transcript.split("/"));
          if (!transcriptPath.startsWith(`${evaluationRoot}${sep}`)) throw new Error();
          const source = regularText(transcriptPath, MAX_TRANSCRIPT_BYTES);
          const transcriptSha256 = createHash("sha256").update(source, "utf8").digest("hex");
          if (transcriptSha256 !== receipt[phaseName].transcriptSha256) {
            errors.push(`${phaseName} transcript hash is stale`);
          }
          errors.push(...transcriptErrors(
            source,
            phaseName,
            receipt[phaseName],
            evaluationRoot,
            receipt.evaluationSha256,
            receipt.externalInputsSha256,
            receipt.skillSha256,
            contract.scorecardCriteria,
            contract.scenariosByPhase[phaseName],
            receipt.evaluatedAt,
          ));
        }
      }
    } catch {
      errors.push("evaluation receipt or transcript is missing or invalid");
    }
  }
  return Object.freeze({
    name: values.name,
    files: Object.freeze(files),
    ...(sha256 === undefined ? {} : { sha256 }),
    errors: Object.freeze([...new Set(errors)]),
  });
}

export async function runValidationCli(args, root = fileURLToPath(new URL("../..", import.meta.url))) {
  if (!Array.isArray(args) || args.some((name) => typeof name !== "string" || !NAME.test(name))
      || new Set(args).size !== args.length) throw new Error("Invalid skill validator arguments");
  const repositoryRoot = typeof root === "string" && isAbsolute(root) ? resolve(root) : root;
  let names = args;
  if (names.length === 0) {
    try {
      names = readdirSync(resolve(repositoryRoot, "skills"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && NAME.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      names = [];
    }
  }
  const results = [];
  for (const name of names) results.push(await validateSkill({ root: repositoryRoot, name }));
  const summary = { ok: results.every(({ errors }) => errors.length === 0), skills: results };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.ok) process.exitCode = 1;
  return summary;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runValidationCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
