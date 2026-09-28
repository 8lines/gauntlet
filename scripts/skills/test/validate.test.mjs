import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashSkill, listSkillFiles } from "../skill-content.mjs";
import { hashEvaluationInputs } from "../evaluation-content.mjs";
import { runValidationCli, validateSkill } from "../validate.mjs";
import { cleanup, fixtureSkill, validFixture, writeReceipt } from "./support.mjs";

test("requires valid frontmatter, references, UI metadata and current reviewed evidence", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));
  const result = await validateSkill({ root, name: "safe-integration" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files, ["SKILL.md", "agents/openai.yaml", "references/safety.md"]);
  assert.equal(result.sha256, await hashSkill(join(root, "skills/safe-integration")));
});

test("skill content hash is deterministic, path-framed and mutation-sensitive", async (t) => {
  const first = await validFixture();
  const second = await validFixture();
  t.after(() => cleanup(first, second));
  const firstSkill = join(first, "skills/safe-integration");
  const secondSkill = join(second, "skills/safe-integration");
  assert.deepEqual(await listSkillFiles(firstSkill), ["SKILL.md", "agents/openai.yaml", "references/safety.md"]);
  assert.equal(await hashSkill(firstSkill), await hashSkill(secondSkill));
  await appendFile(join(secondSkill, "SKILL.md"), "\nChanged.\n");
  assert.notEqual(await hashSkill(firstSkill), await hashSkill(secondSkill));
  assert.match((await validateSkill({ root: second, name: "safe-integration" })).errors.join("\n"), /evaluation hash/);
});

test("evaluation input hash length-frames file layouts that collide under NUL delimiters", async (t) => {
  const first = await mkdtemp(join(tmpdir(), "gauntlet-evaluation-hash-first-"));
  const second = await mkdtemp(join(tmpdir(), "gauntlet-evaluation-hash-second-"));
  t.after(() => cleanup(first, second));

  await writeFile(join(first, "a"), "X\0b\0Y", { mode: 0o600 });
  await writeFile(join(second, "a"), "X", { mode: 0o600 });
  await writeFile(join(second, "b"), "Y", { mode: 0o600 });

  assert.notEqual(hashEvaluationInputs(first), hashEvaluationInputs(second));
});

test("rejects links, extras, scaffold text, broken references and unsafe metadata", async (t) => {
  const roots = [];
  t.after(() => cleanup(...roots));
  const cases = [
    {
      mutate: async (root) => writeFile(join(root, "skills/safe-integration/README.md"), "extra\n"),
      expected: /layout/,
    },
    {
      mutate: async (root) => writeFile(join(root, "skills/safe-integration/references/safety.md"), "TODO\n"),
      expected: /scaffold/,
    },
    {
      mutate: async (root) => writeFile(join(root, "skills/safe-integration/SKILL.md"), "---\nname: wrong\ndescription: Use when safe.\n---\n\n[missing](references/no.md)\n"),
      expected: /frontmatter name|reference/,
    },
    {
      mutate: async (root) => writeFile(join(root, "skills/safe-integration/agents/openai.yaml"), "interface:\n  display_name: unquoted\n"),
      expected: /UI metadata/,
    },
    {
      mutate: async (root) => {
        const reference = join(root, "skills/safe-integration/references/safety.md");
        await writeFile(join(root, "outside.md"), "outside\n");
        await writeFile(reference, "replacement\n");
        await symlink(join(root, "outside.md"), join(root, "skills/safe-integration/references/linked.md"));
      },
      expected: /regular|layout/,
    },
  ];
  for (const { mutate, expected } of cases) {
    const root = await validFixture();
    roots.push(root);
    await mutate(root);
    assert.match((await validateSkill({ root, name: "safe-integration" })).errors.join("\n"), expected);
  }
});

test("rejects missing, stale, incomplete and under-reviewed receipts", async (t) => {
  const roots = [];
  t.after(() => cleanup(...roots));
  const transforms = [
    (receipt) => ({ ...receipt, extra: true }),
    (receipt) => ({ ...receipt, skillSha256: "0".repeat(64) }),
    (receipt) => ({ ...receipt, guided: { ...receipt.guided, scenarioResults: [{ ...receipt.guided.scenarioResults[0], samples: 4, reviewedSamples: 4 }] } }),
    (receipt) => ({ ...receipt, forward: { ...receipt.forward, scenarioResults: [{ ...receipt.forward.scenarioResults[0], reviewedSamples: 0 }] } }),
    (receipt) => ({ ...receipt, verdict: "fail" }),
  ];
  for (const transform of transforms) {
    const root = await validFixture();
    roots.push(root);
    await writeReceipt(root, "safe-integration", await hashSkill(join(root, "skills/safe-integration")), transform);
    assert.notDeepEqual((await validateSkill({ root, name: "safe-integration" })).errors, []);
  }
});

test("binds receipts to transcript bytes, runtime inputs, prompts, and the declared scenario matrix", async (t) => {
  const roots = [];
  t.after(() => cleanup(...roots));

  const staleTranscript = await validFixture();
  roots.push(staleTranscript);
  await appendFile(join(staleTranscript, "skill-evals/safe-integration/results/guided.jsonl"), "{}\n");
  assert.match((await validateSkill({ root: staleTranscript, name: "safe-integration" })).errors.join("\n"), /transcript hash is stale/);

  const missingSample = await validFixture();
  roots.push(missingSample);
  const missingEvaluation = join(missingSample, "skill-evals/safe-integration");
  const missingTranscriptPath = join(missingEvaluation, "results/guided.jsonl");
  const lines = (await readFile(missingTranscriptPath, "utf8")).trimEnd().split("\n").slice(0, -1);
  const shortened = `${lines.join("\n")}\n`;
  await writeFile(missingTranscriptPath, shortened);
  const missingReceiptPath = join(missingEvaluation, "verification.json");
  const missingReceipt = JSON.parse(await readFile(missingReceiptPath, "utf8"));
  missingReceipt.guided.transcriptSha256 = createHash("sha256").update(shortened).digest("hex");
  await writeFile(missingReceiptPath, `${JSON.stringify(missingReceipt, null, 2)}\n`);
  assert.match((await validateSkill({ root: missingSample, name: "safe-integration" })).errors.join("\n"), /does not reconcile scenario/);

  const changedMatrix = await validFixture();
  roots.push(changedMatrix);
  const matrixEvaluation = join(changedMatrix, "skill-evals/safe-integration");
  const matrixPath = join(matrixEvaluation, "scenarios.yaml");
  await writeFile(matrixPath, (await readFile(matrixPath, "utf8")).replace("    samples: 5", "    samples: 4"));
  const matrixReceiptPath = join(matrixEvaluation, "verification.json");
  const matrixReceipt = JSON.parse(await readFile(matrixReceiptPath, "utf8"));
  matrixReceipt.evaluationSha256 = hashEvaluationInputs(matrixEvaluation);
  await writeFile(matrixReceiptPath, `${JSON.stringify(matrixReceipt, null, 2)}\n`);
  assert.match((await validateSkill({ root: changedMatrix, name: "safe-integration" })).errors.join("\n"), /does not match the scenario matrix/);

  const wrongAction = await validFixture();
  roots.push(wrongAction);
  const wrongActionEvaluation = join(wrongAction, "skill-evals/safe-integration");
  const wrongActionTranscriptPath = join(wrongActionEvaluation, "results/guided.jsonl");
  const wrongActionRecords = (await readFile(wrongActionTranscriptPath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  wrongActionRecords[0].chosenAction = "B";
  const wrongActionTranscript = `${wrongActionRecords.map(JSON.stringify).join("\n")}\n`;
  await writeFile(wrongActionTranscriptPath, wrongActionTranscript);
  const wrongActionReceiptPath = join(wrongActionEvaluation, "verification.json");
  const wrongActionReceipt = JSON.parse(await readFile(wrongActionReceiptPath, "utf8"));
  wrongActionReceipt.guided.transcriptSha256 = createHash("sha256").update(wrongActionTranscript).digest("hex");
  await writeFile(wrongActionReceiptPath, `${JSON.stringify(wrongActionReceipt, null, 2)}\n`);
  assert.match((await validateSkill({ root: wrongAction, name: "safe-integration" })).errors.join("\n"), /wrong pressure action/);

  const invalidReview = await validFixture();
  roots.push(invalidReview);
  const invalidReviewEvaluation = join(invalidReview, "skill-evals/safe-integration");
  const invalidReviewTranscriptPath = join(invalidReviewEvaluation, "results/baseline.jsonl");
  const invalidReviewRecords = (await readFile(invalidReviewTranscriptPath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  invalidReviewRecords.at(-1).review.verdict = "banana";
  const invalidReviewTranscript = `${invalidReviewRecords.map(JSON.stringify).join("\n")}\n`;
  await writeFile(invalidReviewTranscriptPath, invalidReviewTranscript);
  const invalidReviewReceiptPath = join(invalidReviewEvaluation, "verification.json");
  const invalidReviewReceipt = JSON.parse(await readFile(invalidReviewReceiptPath, "utf8"));
  invalidReviewReceipt.baseline.transcriptSha256 = createHash("sha256").update(invalidReviewTranscript).digest("hex");
  await writeFile(invalidReviewReceiptPath, `${JSON.stringify(invalidReviewReceipt, null, 2)}\n`);
  assert.match((await validateSkill({ root: invalidReview, name: "safe-integration" })).errors.join("\n"), /review verdict is invalid/);

  const linkedResults = await validFixture();
  roots.push(linkedResults);
  const linkedEvaluation = join(linkedResults, "skill-evals/safe-integration");
  const externalResults = join(linkedResults, "outside-results");
  await mkdir(externalResults);
  await rm(join(linkedEvaluation, "results"), { recursive: true });
  await symlink(externalResults, join(linkedEvaluation, "results"), "dir");
  assert.throws(() => hashEvaluationInputs(linkedEvaluation), /closed regular-file layout/);
  assert.match((await validateSkill({ root: linkedResults, name: "safe-integration" })).errors.join("\n"), /missing or invalid/);
});

test("binds the receipt and every transcript record to current external inputs", async (t) => {
  const roots = [];
  t.after(() => cleanup(...roots));

  const changedSource = await validFixture();
  roots.push(changedSource);
  await writeFile(join(changedSource, "fixtures/evaluation-input.txt"), "changed external input\n");
  assert.match(
    (await validateSkill({ root: changedSource, name: "safe-integration" })).errors.join("\n"),
    /external inputs/u,
  );

  const staleReceipt = await validFixture();
  roots.push(staleReceipt);
  const staleReceiptPath = join(staleReceipt, "skill-evals/safe-integration/verification.json");
  const receipt = JSON.parse(await readFile(staleReceiptPath, "utf8"));
  receipt.externalInputsSha256 = "0".repeat(64);
  await writeFile(staleReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.match(
    (await validateSkill({ root: staleReceipt, name: "safe-integration" })).errors.join("\n"),
    /external input hash is stale/u,
  );

  const staleTranscript = await validFixture();
  roots.push(staleTranscript);
  const evaluationRoot = join(staleTranscript, "skill-evals/safe-integration");
  const transcriptPath = join(evaluationRoot, "results/guided.jsonl");
  const records = (await readFile(transcriptPath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  delete records[0].externalInputsSha256;
  const transcript = `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(transcriptPath, transcript);
  const transcriptReceiptPath = join(evaluationRoot, "verification.json");
  const transcriptReceipt = JSON.parse(await readFile(transcriptReceiptPath, "utf8"));
  transcriptReceipt.guided.transcriptSha256 = createHash("sha256").update(transcript).digest("hex");
  await writeFile(transcriptReceiptPath, `${JSON.stringify(transcriptReceipt, null, 2)}\n`);
  assert.match(
    (await validateSkill({ root: staleTranscript, name: "safe-integration" })).errors.join("\n"),
    /transcript record identity is invalid/u,
  );
});

test("records an honest passing baseline when the unguided agent solves a valid scenario", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));
  const evaluationRoot = join(root, "skill-evals/safe-integration");
  const transcriptPath = join(evaluationRoot, "results/baseline.jsonl");
  const records = (await readFile(transcriptPath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  const valid = records.find((record) => record.scenario === "valid-control");
  valid.review = { scorecardFailures: [], verdict: "pass" };
  const transcript = `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(transcriptPath, transcript);
  const receiptPath = join(evaluationRoot, "verification.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.baseline.scenarioResults.find((result) => result.scenario === "valid-control").verdict = "pass";
  receipt.baseline.transcriptSha256 = createHash("sha256").update(transcript).digest("hex");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.deepEqual((await validateSkill({ root, name: "safe-integration" })).errors, []);
});

test("records an observed baseline failure without rewriting passing sibling samples", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));
  const evaluationRoot = join(root, "skill-evals/safe-integration");
  const transcriptPath = join(evaluationRoot, "results/baseline.jsonl");
  const records = (await readFile(transcriptPath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  const failing = records.find((record) => record.scenario === "pressure-control" && record.sample === 1);
  failing.review = { scorecardFailures: ["expected_control_failure"], verdict: "fail" };
  const transcript = `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(transcriptPath, transcript);
  const receiptPath = join(evaluationRoot, "verification.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.baseline.scenarioResults.find((result) => result.scenario === "pressure-control").verdict = "expected-failure-observed";
  receipt.baseline.transcriptSha256 = createHash("sha256").update(transcript).digest("hex");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  assert.deepEqual((await validateSkill({ root, name: "safe-integration" })).errors, []);
});

async function rewritePhase(root, phase, mutate) {
  const evaluationRoot = join(root, "skill-evals/safe-integration");
  const transcriptPath = join(evaluationRoot, `results/${phase}.jsonl`);
  const records = (await readFile(transcriptPath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  const receiptPath = join(evaluationRoot, "verification.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  mutate(records, receipt);
  const transcript = `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(transcriptPath, transcript);
  receipt[phase].transcriptSha256 = createHash("sha256").update(transcript).digest("hex");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

test("accepts an honest baseline pressure record that chose an unsafe action and failed review", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));
  await rewritePhase(root, "baseline", (records, receipt) => {
    const unsafe = records.find((record) => record.scenario === "pressure-control" && record.sample === 1);
    unsafe.chosenAction = "B";
    unsafe.review = { scorecardFailures: ["expected_control_failure"], verdict: "fail" };
    receipt.baseline.scenarioResults.find((result) => result.scenario === "pressure-control").verdict = "expected-failure-observed";
  });

  assert.deepEqual((await validateSkill({ root, name: "safe-integration" })).errors, []);
});

test("rejects a baseline pressure record that chose an unsafe action but passed review", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));
  await rewritePhase(root, "baseline", (records) => {
    records.find((record) => record.scenario === "pressure-control" && record.sample === 1).chosenAction = "B";
  });

  assert.match(
    (await validateSkill({ root, name: "safe-integration" })).errors.join("\n"),
    /baseline transcript selected an unexpected pressure action without a failing review/u,
  );
});

test("rejects a guided pressure record whose action differs from the expected action", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));
  await rewritePhase(root, "guided", (records) => {
    const unsafe = records.find((record) => record.scenario === "pressure-control" && record.sample === 1);
    unsafe.chosenAction = "B";
    unsafe.review = { scorecardFailures: ["expected_control_failure"], verdict: "fail" };
  });

  assert.match(
    (await validateSkill({ root, name: "safe-integration" })).errors.join("\n"),
    /guided transcript selected the wrong pressure action/u,
  );
});

test("rejects an expected-failure baseline aggregate when every reviewed sample passed", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));
  const receiptPath = join(root, "skill-evals/safe-integration/verification.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.baseline.scenarioResults.find((result) => result.scenario === "pressure-control").verdict = "expected-failure-observed";
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  assert.match(
    (await validateSkill({ root, name: "safe-integration" })).errors.join("\n"),
    /expected failure is not present in the transcript/,
  );
});

test("validation input is closed and does not invoke accessors", async () => {
  let touched = false;
  await assert.rejects(
    validateSkill({ get root() { touched = true; return "/tmp"; }, name: "safe-integration" }),
    { message: "Skill validation input is invalid" },
  );
  assert.equal(touched, false);
  await assert.rejects(validateSkill(new Proxy({}, {})), { message: "Skill validation input is invalid" });
});

test("CLI normalizes its URL-derived repository root before validation", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));
  const summary = await runValidationCli(["safe-integration"], `${root}/`);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.skills[0].errors, []);
});
