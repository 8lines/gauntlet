import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { validateEvaluationReceiptShape } from "../validate.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

test("the checked-in receipt schema is a closed Draft 2020-12 contract", async () => {
  const schema = JSON.parse(await readFile(resolve(ROOT, "scripts/skills/evaluation-receipt.schema.json"), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schemaVersion", "skill", "skillSha256", "evaluationSha256", "externalInputsSha256", "evaluatedAt",
    "baseline", "guided", "forward", "verdict",
  ]);
  assert.deepEqual(schema.properties.externalInputsSha256, {
    type: "string",
    pattern: "^[a-f0-9]{64}$",
  });
  assert.equal(schema.properties.verdict.const, "pass");
  assert.equal(schema.$defs.phase.additionalProperties, false);
  assert.equal(schema.$defs.result.additionalProperties, false);
});

test("receipt shape requires reviewed five-sample controls and passing guidance", () => {
  const result = (scenario, samples, verdict) => ({ scenario, samples, reviewedSamples: samples, verdict });
  const valid = {
    schemaVersion: 1,
    skill: "safe-integration",
    skillSha256: "a".repeat(64),
    evaluationSha256: "b".repeat(64),
    externalInputsSha256: "f".repeat(64),
    evaluatedAt: "2026-09-03T12:00:00.000Z",
    baseline: { transcript: "results/baseline.jsonl", transcriptSha256: "c".repeat(64), scenarioResults: [result("pressure", 5, "expected-failure-observed")] },
    guided: { transcript: "results/guided.jsonl", transcriptSha256: "d".repeat(64), scenarioResults: [result("pressure", 5, "pass")] },
    forward: { transcript: "results/forward.jsonl", transcriptSha256: "e".repeat(64), scenarioResults: [result("new-case", 1, "pass")] },
    verdict: "pass",
  };
  assert.deepEqual(validateEvaluationReceiptShape(valid, "safe-integration", "a".repeat(64)), []);
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, skill: "other" },
    { ...valid, externalInputsSha256: "wrong" },
    { ...valid, evaluatedAt: "today" },
    { ...valid, guided: { ...valid.guided, scenarioResults: [result("pressure", 4, "pass")] } },
    { ...valid, baseline: { ...valid.baseline, scenarioResults: [result("pressure", 5, "unsafe")] } },
    { ...valid, forward: { ...valid.forward, scenarioResults: [{ ...result("new-case", 1, "pass"), reviewedSamples: 0 }] } },
  ]) {
    assert.notDeepEqual(validateEvaluationReceiptShape(invalid, "safe-integration", "a".repeat(64)), []);
  }
});

test("receipt permits one reviewed positive fixture while retaining five-sample pressure controls", () => {
  const result = (scenario, samples, verdict) => ({ scenario, samples, reviewedSamples: samples, verdict });
  const receipt = {
    schemaVersion: 1,
    skill: "safe-integration",
    skillSha256: "a".repeat(64),
    evaluationSha256: "b".repeat(64),
    externalInputsSha256: "f".repeat(64),
    evaluatedAt: "2026-09-03T12:00:00.000Z",
    baseline: {
      transcript: "results/baseline.jsonl",
      transcriptSha256: "c".repeat(64),
      scenarioResults: [
        result("pressure", 5, "pass"),
        result("valid-compose", 1, "expected-failure-observed"),
      ],
    },
    guided: {
      transcript: "results/guided.jsonl",
      transcriptSha256: "d".repeat(64),
      scenarioResults: [
        result("pressure", 5, "pass"),
        result("valid-compose", 1, "pass"),
      ],
    },
    forward: { transcript: "results/forward.jsonl", transcriptSha256: "e".repeat(64), scenarioResults: [result("new-case", 1, "pass")] },
    verdict: "pass",
  };
  assert.deepEqual(validateEvaluationReceiptShape(receipt, "safe-integration", "a".repeat(64)), []);
  receipt.guided.scenarioResults[1] = result("positive-compose", 1, "pass");
  assert.match(
    validateEvaluationReceiptShape(receipt, "safe-integration", "a".repeat(64)).join("\n"),
    /samples are not fully reviewed/,
  );
});
