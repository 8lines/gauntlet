import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hashSkill } from "../skill-content.mjs";
import { hashEvaluationInputs } from "../evaluation-content.mjs";
import { hashExternalInputs } from "../external-inputs.mjs";

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function fixtureSkill({ name = "safe-integration", skill, references, openai }) {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-skill-test-"));
  const skillRoot = join(root, "skills", name);
  await mkdir(join(skillRoot, "agents"), { recursive: true, mode: 0o700 });
  await writeFile(join(skillRoot, "SKILL.md"), skill, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(skillRoot, "agents", "openai.yaml"), openai, { encoding: "utf8", mode: 0o600 });
  for (const [relativePath, contents] of Object.entries(references)) {
    const destination = join(skillRoot, "references", relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, contents, { encoding: "utf8", mode: 0o600 });
  }
  return root;
}

export async function writeReceipt(root, name, skillSha256, transform = (receipt) => receipt) {
  const evaluationRoot = join(root, "skill-evals", name);
  const resultsRoot = join(evaluationRoot, "results");
  await mkdir(resultsRoot, { recursive: true, mode: 0o700 });
  const promptsRoot = join(evaluationRoot, "prompts");
  await mkdir(promptsRoot, { recursive: true, mode: 0o700 });
  const result = (scenario, samples, verdict) => ({ scenario, samples, reviewedSamples: samples, verdict });
  const phases = {
    baseline: [
      result("pressure-control", 5, "pass"),
      result("valid-control", 1, "expected-failure-observed"),
    ],
    guided: [
      result("pressure-control", 5, "pass"),
      result("valid-control", 1, "pass"),
    ],
    forward: [result("forward-scenario", 1, "pass")],
  };
  for (const scenario of new Set(Object.values(phases).flat().map(({ scenario: value }) => value))) {
    await writeFile(join(promptsRoot, `${scenario}.md`), `${scenario} prompt\n`, { encoding: "utf8", mode: 0o600 });
  }
  await writeFile(join(evaluationRoot, "scenarios.yaml"), [
    "schemaVersion: 1",
    `skill: ${name}`,
    "syntheticOnly: true",
    "baselineGuidance: none",
    "scenarios:",
    "  - id: pressure-control",
    "    kind: pressure",
    "    samples: 5",
    "    expectedAction: A",
    "    prompt: prompts/pressure-control.md",
    "  - id: valid-control",
    "    kind: valid",
    "    samples: 1",
    "    expectedOverallVerdict: synthetic-control",
    "    prompt: prompts/valid-control.md",
    "forwardScenarios:",
    "  - id: forward-scenario",
    "    samples: 1",
    "    prompt: prompts/forward-scenario.md",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  await writeFile(join(evaluationRoot, "scorecard.yaml"), [
    "schemaVersion: 1",
    "required:",
    "  - expected_control_failure",
    "forbidden:",
    "  - forbidden_control",
    "validScenarioRequired:",
    "  - valid_control_evidence",
    "nextjsRequired:",
    "  - raw_target_evidence",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  const externalSource = "external fixture input\n";
  const externalSourcePath = join(root, "fixtures", "evaluation-input.txt");
  await mkdir(dirname(externalSourcePath), { recursive: true, mode: 0o700 });
  await writeFile(externalSourcePath, externalSource, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(evaluationRoot, "external-inputs.json"), `${JSON.stringify({
    schemaVersion: 1,
    sourceFiles: [{
      path: "fixtures/evaluation-input.txt",
      sha256: createHash("sha256").update(externalSource).digest("hex"),
    }],
    sourceTrees: [],
    linkedRuntimeTrees: [],
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const externalInputsSha256 = hashExternalInputs({ root, evaluationRoot });
  const evaluationSha256 = hashEvaluationInputs(evaluationRoot);
  const phaseReceipts = {};
  for (const [phase, scenarioResults] of Object.entries(phases)) {
    const records = scenarioResults.flatMap(({ scenario, samples, verdict }) => Array.from({ length: samples }, (_, index) => ({
      phase,
      scenario,
      sample: index + 1,
      synthetic: true,
      evaluationSha256,
      externalInputsSha256,
      skillSha256: phase === "baseline" ? null : skillSha256,
      prompt: `${scenario} prompt\n`,
      response: "synthetic response",
      model: "synthetic-model",
      reasoningEffort: "test",
      recordedAt: "2026-09-03T12:00:00.000Z",
      chosenAction: scenario === "pressure-control" ? "A" : "synthetic-action",
      filesystemDiff: "none",
      testOutput: "synthetic test output",
      exitState: "synthetic-exit",
      review: {
        scorecardFailures: verdict === "pass" ? [] : ["expected_control_failure"],
        verdict: verdict === "pass" ? "pass" : "fail",
      },
    })));
    const transcript = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(join(resultsRoot, `${phase}.jsonl`), transcript, { encoding: "utf8", mode: 0o600 });
    phaseReceipts[phase] = {
      transcript: `results/${phase}.jsonl`,
      transcriptSha256: createHash("sha256").update(transcript).digest("hex"),
      scenarioResults,
    };
  }
  const receipt = transform({
    schemaVersion: 1,
    skill: name,
    skillSha256,
    evaluationSha256,
    externalInputsSha256,
    evaluatedAt: "2026-09-03T12:00:00.000Z",
    ...phaseReceipts,
    verdict: "pass",
  });
  await writeFile(join(evaluationRoot, "verification.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function validFixture(name = "safe-integration") {
  const root = await fixtureSkill({
    name,
    skill: `---\nname: ${name}\ndescription: Use when integrating a safe synthetic fixture.\n---\n\n# Safe integration\n\nRead [safety](references/safety.md).\n`,
    references: { "safety.md": "# Safety\n\nUse synthetic non-production data.\n" },
    openai: `interface:\n  display_name: "Safe Integration"\n  short_description: "Connect a safe fixture application"\n  default_prompt: "Use $${name} to connect this fixture."\npolicy:\n  allow_implicit_invocation: true\n`,
  });
  await writeReceipt(root, name, await hashSkill(join(root, "skills", name)));
  return root;
}

export async function occupiedDestination(name) {
  const destination = await mkdtemp(join(tmpdir(), "gauntlet-skills-destination-"));
  await mkdir(join(destination, name), { recursive: true, mode: 0o700 });
  await writeFile(join(destination, name, "SKILL.md"), "occupied\n", { encoding: "utf8", mode: 0o600 });
  return destination;
}

export async function cleanup(...paths) {
  await Promise.all(paths.filter(Boolean).map((path) => rm(path, { recursive: true, force: true })));
}
