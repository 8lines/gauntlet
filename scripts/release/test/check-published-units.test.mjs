import assert from "node:assert/strict";
import test from "node:test";

import {
  checkUnitDestinations, createUnitCheckPlan, evaluateReleaseSetState, evaluateUnitState, unitDestinations,
} from "../check-published.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function evidenceFor(unit, tag) {
  const ids = [...unitDestinations(unit).map(({ id, kind }) => [id, kind]), [`github:${tag}`, "release"]];
  return Object.fromEntries(ids.map(([id, kind], index) => [id,
    kind === "npm" ? `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`
      : kind === "image" ? `sha256:${String(index + 1).repeat(64).slice(0, 64)}`
        : kind === "composer" ? String(index + 1).repeat(40).slice(0, 40)
          : String(index + 1).repeat(64).slice(0, 64)]));
}

function plan(unit, version, tag) {
  return createUnitCheckPlan({ unit, version, sourceCommit: COMMIT, evidence: evidenceFor(unit, tag) });
}

const absent = (checks) => checks.map(({ id }) => ({ id, state: "absent" }));
const identical = (checks) => checks.map(({ id, expectedEvidence }) => ({ id, state: "present", evidence: expectedEvidence }));

test("every unit has its own destinations and its own GitHub Release", () => {
  assert.deepEqual(plan("gauntlet", "0.1.9", "v0.1.9").map(({ id }) => id), ["image:semantic", "image:commit", "chart:semantic", "github:v0.1.9"]);
  assert.deepEqual(plan("skills", "0.1.9", "skills-v0.1.9").map(({ id }) => id), ["github:skills-v0.1.9"]);
  assert.deepEqual(plan("protocol", "0.2.0", "protocol-v0.2.0").map(({ id }) => id), ["npm:protocol", "github:protocol-v0.2.0"]);
  assert.deepEqual(plan("php-core", "0.1.9", "php-core-v0.1.9").map(({ id, destination }) => [id, destination]), [
    ["composer:php-core", "https://github.com/8lines/gauntlet-php-core.git#v0.1.9"],
    ["github:php-core-v0.1.9", "https://github.com/8lines/gauntlet/releases/tag/php-core-v0.1.9"],
  ]);
  assert.deepEqual(plan("spring-boot-starter", "0.1.9", "spring-boot-starter-v0.1.9").map(({ id }) => id), [
    "maven:spring-boot-starter", "github:spring-boot-starter-v0.1.9",
  ]);
  assert.throws(() => createUnitCheckPlan({ unit: "skills", version: "0.1.9", sourceCommit: COMMIT, evidence: {} }));
  assert.throws(() => createUnitCheckPlan({ unit: "skills", version: "0.1.9", sourceCommit: COMMIT, evidence: evidenceFor("skills", "skills-v0.1.8") }));
});

test("a unit is clean or identical as a whole and fails closed when partially published", () => {
  const checks = plan("protocol", "0.2.0", "protocol-v0.2.0");
  assert.equal(evaluateUnitState(checks, absent(checks)), "clean");
  assert.equal(evaluateUnitState(checks, identical(checks)), "already-identical");
  const registryOnly = [identical(checks)[0], absent(checks)[1]];
  assert.throws(() => evaluateUnitState(checks, registryOnly), /Release unit protocol is partially published/u);
  const releaseOnly = [absent(checks)[0], identical(checks)[1]];
  assert.throws(() => evaluateUnitState(checks, releaseOnly), /Release unit protocol is partially published/u);
  const different = identical(checks).map((observation, index) => index === 0 ? { ...observation, evidence: `sha512-${Buffer.alloc(64, 9).toString("base64")}` } : observation);
  assert.throws(() => evaluateUnitState(checks, different), /Remote destination npm:protocol has different evidence/u);
  assert.throws(() => evaluateUnitState(checks, absent(checks).slice(1)), /complete observation set/u);
});

test("a single-destination unit is identical or clean and never partial", () => {
  const checks = plan("skills", "0.1.9", "skills-v0.1.9");
  assert.equal(evaluateUnitState(checks, absent(checks)), "clean");
  assert.equal(evaluateUnitState(checks, identical(checks)), "already-identical");
});

test("partial publication is detected in either direction for every multi-destination unit", () => {
  for (const [unit, version, tag] of [["gauntlet", "0.1.9", "v0.1.9"], ["php-core", "0.1.9", "php-core-v0.1.9"], ["spring-boot-starter", "0.1.9", "spring-boot-starter-v0.1.9"]]) {
    const checks = plan(unit, version, tag);
    const last = checks.length - 1;
    const releaseMissing = checks.map((check, index) => (index === last ? absent(checks)[index] : identical(checks)[index]));
    const releaseOnly = checks.map((check, index) => (index === last ? identical(checks)[index] : absent(checks)[index]));
    assert.throws(() => evaluateUnitState(checks, releaseMissing), new RegExp(`Release unit ${unit} is partially published`, "u"));
    assert.throws(() => evaluateUnitState(checks, releaseOnly), new RegExp(`Release unit ${unit} is partially published`, "u"));
    if (checks.length > 2) {
      const oneImage = checks.map((check, index) => (index === 0 ? identical(checks)[index] : absent(checks)[index]));
      assert.throws(() => evaluateUnitState(checks, oneImage), /partially published/u);
    }
  }
});

test("observations for unknown or duplicated destinations never satisfy a unit", () => {
  const checks = plan("protocol", "0.2.0", "protocol-v0.2.0");
  assert.throws(() => evaluateUnitState(checks, [absent(checks)[0], { id: "npm:other", state: "absent" }]), /complete observation set/u);
  assert.throws(() => evaluateUnitState(checks, [absent(checks)[0], absent(checks)[0]]), /complete observation set/u);
  assert.throws(() => evaluateUnitState(checks, "absent"), /complete observation set/u);
});

test("a release set may mix clean and identical units but one partial unit fails the set", () => {
  const plans = [plan("protocol", "0.2.0", "protocol-v0.2.0"), plan("gauntlet", "0.1.9", "v0.1.9"), plan("skills", "0.1.9", "skills-v0.1.9")];
  assert.deepEqual(evaluateReleaseSetState(plans, [...identical(plans[0]), ...absent(plans[1]), ...absent(plans[2])]), [
    { id: "protocol", state: "already-identical" },
    { id: "gauntlet", state: "clean" },
    { id: "skills", state: "clean" },
  ]);
  const partialGauntlet = [...identical(plans[0]), ...identical(plans[1]).slice(0, 3), ...absent(plans[1]).slice(3), ...absent(plans[2])];
  assert.throws(() => evaluateReleaseSetState(plans, partialGauntlet), /Release unit gauntlet is partially published/u);
  assert.throws(() => evaluateReleaseSetState(plans, [...absent(plans[0]), ...absent(plans[1])]), /complete observation set/u);
});

test("a partial unit is never masked by identical or clean units in the set, in either direction", () => {
  const plans = [plan("protocol", "0.2.0", "protocol-v0.2.0"), plan("php-core", "0.1.9", "php-core-v0.1.9"), plan("skills", "0.1.9", "skills-v0.1.9")];
  const registryOnly = [identical(plans[1])[0], absent(plans[1])[1]];
  const releaseOnly = [absent(plans[1])[0], identical(plans[1])[1]];
  for (const partial of [registryOnly, releaseOnly]) {
    for (const others of [
      [identical(plans[0]), identical(plans[2])],
      [absent(plans[0]), absent(plans[2])],
      [identical(plans[0]), absent(plans[2])],
    ]) {
      assert.throws(
        () => evaluateReleaseSetState(plans, [...others[0], ...partial, ...others[1]]),
        /Release unit php-core is partially published/u,
      );
    }
  }
});

test("a release set reports different evidence of one unit even when others are clean", () => {
  const plans = [plan("protocol", "0.2.0", "protocol-v0.2.0"), plan("skills", "0.1.9", "skills-v0.1.9")];
  const different = identical(plans[1]).map((observation) => ({ ...observation, evidence: "f".repeat(64) }));
  assert.throws(() => evaluateReleaseSetState(plans, [...absent(plans[0]), ...different]), /Remote destination github:skills-v0.1.9 has different evidence/u);
});

test("every probe of every unit runs before the set is evaluated", async () => {
  const plans = [plan("protocol", "0.2.0", "protocol-v0.2.0"), plan("skills", "0.1.9", "skills-v0.1.9")];
  const calls = [];
  assert.deepEqual(await checkUnitDestinations({ plans, probe: async (check) => { calls.push(check.id); return { id: check.id, state: "absent" }; } }), [
    { id: "protocol", state: "clean" }, { id: "skills", state: "clean" },
  ]);
  assert.deepEqual(calls, ["npm:protocol", "github:protocol-v0.2.0", "github:skills-v0.1.9"]);
  const failing = [];
  await assert.rejects(checkUnitDestinations({ plans, probe: async (check) => {
    failing.push(check.id);
    if (check.id === "npm:protocol") throw new Error("registry unavailable");
    return { id: check.id, state: "absent" };
  } }), /registry unavailable/u);
  assert.equal(failing.length, 3);
});
