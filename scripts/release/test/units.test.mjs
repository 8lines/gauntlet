import assert from "node:assert/strict";
import { test } from "node:test";

import { RELEASE_ARTIFACTS } from "../release-model.mjs";
import { RELEASE_UNITS, dependencyOrder, dependentsOf, unitById, unitTag, validateUnits } from "../units.mjs";

const IDS = [
  "gauntlet", "protocol", "dashboard-client", "typescript-core", "typescript-node", "next-adapter",
  "conformance-runner", "widget", "php-core", "symfony-bundle", "java-core", "spring-boot-starter", "skills",
];

test("the catalog holds the thirteen spec units in a fixed order", () => {
  assert.deepEqual(RELEASE_UNITS.map(({ id }) => id), IDS);
  assert.equal(Object.isFrozen(RELEASE_UNITS), true);
  assert.equal(Object.isFrozen(RELEASE_UNITS[0].dependsOn), true);
});

test("tags use v for the application and <id>-v for every other unit", () => {
  assert.equal(unitTag(unitById("gauntlet"), "0.1.8"), "v0.1.8");
  assert.equal(unitTag(unitById("protocol"), "0.2.0"), "protocol-v0.2.0");
  assert.throws(() => unitById("nope"), /Unknown release unit/);
});

test("every published artifact belongs to exactly one unit", () => {
  const published = [
    ...RELEASE_ARTIFACTS.npm.map(({ name }) => name),
    ...RELEASE_ARTIFACTS.composer.map(({ name }) => name),
    ...RELEASE_ARTIFACTS.maven.map(({ name }) => name),
    RELEASE_ARTIFACTS.image.name, RELEASE_ARTIFACTS.compose.name, RELEASE_ARTIFACTS.chart.name, RELEASE_ARTIFACTS.skills.name,
  ];
  const owned = RELEASE_UNITS.flatMap(({ artifacts }) => artifacts);
  assert.deepEqual([...owned].sort(), [...published].sort());
});

test("dependency order puts dependencies first", () => {
  const order = dependencyOrder();
  for (const unit of RELEASE_UNITS) {
    for (const dependency of unit.dependsOn) assert.ok(order.indexOf(dependency) < order.indexOf(unit.id), `${dependency} before ${unit.id}`);
  }
  assert.deepEqual(dependencyOrder(["next-adapter", "protocol"]), ["protocol", "next-adapter"]);
});

test("a protocol change reaches every dependent and nothing else", () => {
  const fromProtocol = new Set(dependentsOf("protocol"));
  for (const id of ["dashboard-client", "typescript-core", "typescript-node", "next-adapter", "conformance-runner", "gauntlet", "skills"]) {
    assert.ok(fromProtocol.has(id), id);
  }
  assert.equal(fromProtocol.size, 7);
  assert.ok(!fromProtocol.has("php-core"));
  assert.deepEqual(dependentsOf("gauntlet"), ["skills"]);
  assert.deepEqual(dependentsOf("widget"), []);
  assert.deepEqual(dependentsOf("skills"), []);
});

test("validation rejects cycles, unknown dependencies and duplicate ids", () => {
  const base = RELEASE_UNITS.map((unit) => ({ ...unit, dependsOn: [...unit.dependsOn] }));
  const cyclic = base.map((unit) => (unit.id === "protocol" ? { ...unit, dependsOn: ["next-adapter"] } : unit));
  assert.throws(() => validateUnits(cyclic), /cycle/);
  const unknown = base.map((unit) => (unit.id === "widget" ? { ...unit, dependsOn: ["missing"] } : unit));
  assert.throws(() => validateUnits(unknown), /unknown dependency/);
  assert.throws(() => validateUnits([...base, base[1]]), /duplicate/);
});
