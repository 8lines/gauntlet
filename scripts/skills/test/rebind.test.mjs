import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  REBINDING_LOG_HEADING, appendRebindingLog, assertOnlyHashesChanged, parseRebindArguments, rebindEvaluations,
  rebindingLogEntry,
} from "../rebind.mjs";
import { validateSkill } from "../validate.mjs";
import { cleanup, validFixture } from "./support.mjs";

const NAME = "safe-integration";
const REASON = "Fixture input changed.";
const DATE = "2026-10-04";
const RECORDS = ["verification.json", "external-inputs.json", "results/baseline.jsonl", "results/guided.jsonl", "results/forward.jsonl"];

function evaluationFile(root, path) {
  return join(root, "skill-evals", NAME, path);
}

function snapshot(root) {
  return Object.fromEntries([...RECORDS, "EVALUATING.md"].map((path) => [path, readFileSync(evaluationFile(root, path), "utf8")]));
}

test("only 64-hex hash values may differ", () => {
  const before = `{"a":"${"1".repeat(64)}","b":"keep"}`;
  assertOnlyHashesChanged(before, before.replace("1".repeat(64), "f".repeat(64)));
  for (const after of [before.replace("keep", "kept"), before.replace("1".repeat(64), "1".repeat(63)), `${before}\n`]) {
    assert.throws(() => assertOnlyHashesChanged(before, after), /Re-binding changed more than 64-hex hash values/u);
  }
});

test("the re-binding log is created once, appended to and stays the last section", () => {
  const entry = rebindingLogEntry(DATE, REASON);
  assert.equal(entry, "- 2026-10-04: Fixture input changed. Hashes were re-bound to the current bytes without new model samples; this confirms content integrity, not behaviour.");
  const created = appendRebindingLog("# Protocol\n\nText.\n", entry);
  assert.equal(created, `# Protocol\n\nText.\n\n${REBINDING_LOG_HEADING}\n\n${entry}\n`);
  assert.equal(appendRebindingLog(created, entry), created);
  const second = rebindingLogEntry("2026-10-05", "Another input changed.");
  assert.equal(appendRebindingLog(created, second), `${created}${second}\n`);
  assert.throws(() => appendRebindingLog(`${created}\n## Later\n`, second), /must be the last section/u);
});

test("arguments name one sentence and an optional calendar date", () => {
  assert.deepEqual(parseRebindArguments(["--reason", REASON, "--date", DATE]), { reason: REASON, date: DATE });
  assert.match(parseRebindArguments(["--reason", REASON]).date, /^\d{4}-\d{2}-\d{2}$/u);
  for (const argv of [
    [], ["--reason"], ["--reason", "lower case."], ["--reason", "No period"], ["--reason", "Dash — here."],
    ["--reason", REASON, "--date", "2026-02-30"], ["--reason", REASON, "--date", "2026-13-01"], ["--reason", REASON, "--extra", "x"],
  ]) {
    assert.throws(() => parseRebindArguments(argv), /Usage: rebind\.mjs/u, JSON.stringify(argv));
  }
});

test("re-binding makes a receipt current again and changes only hash values", async (t) => {
  const root = await validFixture(NAME);
  t.after(() => cleanup(root));
  writeFileSync(evaluationFile(root, "EVALUATING.md"), "# Fixture protocol\n", { mode: 0o600 });
  writeFileSync(join(root, "fixtures/evaluation-input.txt"), "changed external input\n");
  assert.notDeepEqual((await validateSkill({ root, name: NAME })).errors, []);
  const before = snapshot(root);

  const result = await rebindEvaluations({ root, reason: REASON, date: DATE, names: [NAME] });

  assert.deepEqual((await validateSkill({ root, name: NAME })).errors, []);
  assert.deepEqual(result.skills.map(({ name }) => name), [NAME]);
  assert.deepEqual([...result.skills[0].changed], [
    "skill-evals/safe-integration/EVALUATING.md",
    "skill-evals/safe-integration/external-inputs.json",
    "skill-evals/safe-integration/results/baseline.jsonl",
    "skill-evals/safe-integration/results/forward.jsonl",
    "skill-evals/safe-integration/results/guided.jsonl",
    "skill-evals/safe-integration/verification.json",
  ]);
  const after = snapshot(root);
  for (const path of RECORDS) assertOnlyHashesChanged(before[path], after[path]);
  assert.equal(after["EVALUATING.md"], `# Fixture protocol\n\n${REBINDING_LOG_HEADING}\n\n${rebindingLogEntry(DATE, REASON)}\n`);
});

test("re-binding current receipts changes nothing and adds no log entry", async (t) => {
  const root = await validFixture(NAME);
  t.after(() => cleanup(root));
  writeFileSync(evaluationFile(root, "EVALUATING.md"), "# Fixture protocol\n", { mode: 0o600 });
  await rebindEvaluations({ root, reason: REASON, date: DATE, names: [NAME] });
  const before = snapshot(root);
  const again = await rebindEvaluations({ root, reason: "Nothing changed.", date: DATE, names: [NAME] });
  assert.deepEqual(again.skills, [{ name: NAME, changed: [] }]);
  assert.deepEqual(snapshot(root), before);
});

test("a re-binding that cannot make the receipt valid restores every file", async (t) => {
  const root = await validFixture(NAME);
  t.after(() => cleanup(root));
  writeFileSync(evaluationFile(root, "EVALUATING.md"), "# Fixture protocol\n", { mode: 0o600 });
  // A changed prompt is re-bound like any input, but the recorded prompts no longer match it.
  writeFileSync(evaluationFile(root, "prompts/forward-scenario.md"), "a different prompt\n");
  const before = snapshot(root);
  await assert.rejects(
    rebindEvaluations({ root, reason: REASON, date: DATE, names: [NAME] }),
    /Evaluation receipts could not be re-bound/u,
  );
  assert.deepEqual(snapshot(root), before);
});
