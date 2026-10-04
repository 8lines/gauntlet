import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  COMPATIBILITY_PATH, catalogEntries, compatibilityDocumentProblems, compatibilityLine, compatibilityProblems,
  parseCompatibilityDocument, renderCompatibilityDocument, updateCompatibilityEntries,
} from "../compatibility.mjs";
import { createReleasePlan } from "../plan.mjs";
import { readUnitVersions } from "../release-model.mjs";
import { RELEASE_UNITS } from "../units.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const VERSIONS = new Map(RELEASE_UNITS.map(({ id }) => [id, "0.1.8"]));
const LEDGER = catalogEntries(VERSIONS);
const plan = (...units) => createReleasePlan(units.map(([id, to]) => ({ id, from: "0.1.8", to })));
const withContracts = (changes) => RELEASE_UNITS.map((unit) => (Object.hasOwn(changes, unit.id) ? { ...unit, contracts: changes[unit.id] } : unit));

test("renders and parses the generated ledger", () => {
  const source = renderCompatibilityDocument(LEDGER);
  assert.match(source, /^\| `gauntlet` \| 0\.1\.8 \| none \| protocol 1; widgetChannel 1 \|$/mu);
  assert.match(source, /^\| `protocol` \| 0\.1\.8 \| protocol 1 \| none \|$/mu);
  assert.match(source, /^\| `widget` \| 0\.1\.8 \| none \| none \|$/mu);
  assert.deepEqual(parseCompatibilityDocument(source), LEDGER);
  for (const broken of [
    source.replace("| `protocol` | 0.1.8 |", "| `protocol` | 0.1 |"),
    source.replace(/^\| `skills`.*\n/mu, ""),
    source.replace("# Compatibility", "# Compat"),
  ]) assert.throws(() => parseCompatibilityDocument(broken), /Compatibility document is invalid/u);
});

test("a planned unit takes the catalog contracts; unplanned rows keep what was released", () => {
  const recorded = LEDGER.map((entry) => (entry.id === "widget" ? { ...entry, implements: { widgetHost: 1 } } : entry));
  const next = updateCompatibilityEntries(recorded, plan(["protocol", "0.2.0"]));
  assert.equal(next.find(({ id }) => id === "protocol").version, "0.2.0");
  assert.deepEqual(next.find(({ id }) => id === "widget").implements, { widgetHost: 1 });
});

test("rejects a plan whose package implements a protocol major the released application does not support", () => {
  const protocolTwo = withContracts({ "typescript-core": { implements: { protocol: 2 } } });
  assert.deepEqual(compatibilityProblems(plan(["typescript-core", "0.2.0"]), LEDGER, protocolTwo), [
    "typescript-core: implements protocol 2, which gauntlet 0.1.8 does not support",
  ]);
  const both = withContracts({
    "typescript-core": { implements: { protocol: 2 } },
    gauntlet: { supports: { protocol: [1, 2], widgetChannel: [1] } },
  });
  assert.deepEqual(compatibilityProblems(plan(["gauntlet", "0.2.0"], ["typescript-core", "0.2.0"]), LEDGER, both), []);
  assert.deepEqual(compatibilityProblems(plan(["typescript-core", "0.2.0"]), LEDGER, both), [
    "gauntlet: its supported contracts changed without a gauntlet release",
    "typescript-core: implements protocol 2, which gauntlet 0.1.8 does not support",
  ]);
  assert.deepEqual(compatibilityProblems(plan(["widget", "0.1.9"]), LEDGER, protocolTwo), [
    "typescript-core: its implemented contracts changed without a typescript-core release",
  ]);
  const dropsOne = withContracts({ gauntlet: { supports: { protocol: [2], widgetChannel: [1] } } });
  assert.equal(compatibilityProblems(plan(["gauntlet", "1.0.0"]), LEDGER, dropsOne)
    .includes("php-core: implements protocol 1, which gauntlet 1.0.0 does not support"), true);
});

test("states one compatibility line per released unit", () => {
  const ledger = updateCompatibilityEntries(LEDGER, plan(["gauntlet", "0.1.9"], ["protocol", "0.2.0"]));
  assert.equal(compatibilityLine("gauntlet", ledger), "Compatibility: Gauntlet 0.1.9 supports adapter protocol 1 and widget channel 1.");
  assert.equal(compatibilityLine("protocol", ledger),
    "Compatibility: protocol 0.2.0 implements adapter protocol 1; Gauntlet 0.1.9 supports adapter protocol 1 and widget channel 1.");
  assert.equal(compatibilityLine("widget", ledger), "Compatibility: widget 0.1.8 has no versioned runtime contract with the application.");
});

test("the committed ledger must record every unit at its manifest version", () => {
  const source = renderCompatibilityDocument(LEDGER);
  assert.deepEqual(compatibilityDocumentProblems(source, VERSIONS), []);
  assert.deepEqual(compatibilityDocumentProblems(source, new Map([...VERSIONS, ["widget", "0.1.9"]])), [
    "docs/reference/compatibility.md: widget is recorded at 0.1.8 but its manifest version is 0.1.9",
  ]);
  assert.deepEqual(compatibilityDocumentProblems("# Other\n", VERSIONS), ["docs/reference/compatibility.md is not a generated compatibility document"]);
  assert.deepEqual(compatibilityDocumentProblems(readFileSync(join(ROOT, COMPATIBILITY_PATH), "utf8"), readUnitVersions(ROOT)), []);
});
