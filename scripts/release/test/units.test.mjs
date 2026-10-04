import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RELEASE_ARTIFACTS, readUnitVersion, readUnitVersions } from "../release-model.mjs";
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

const ROOT = new URL("../../..", import.meta.url).pathname;

test("every unit reads a stable version from the repository", () => {
  const versions = readUnitVersions(ROOT);
  assert.equal(versions.size, 13);
  for (const [id, version] of versions) assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/, id);
});

for (const bad of ["0.1.9\r\n", "0.1.9-rc.1\n", "0.1.9 \n", "0.1.9", ""]) {
  test(`a malformed unit VERSION file is rejected: ${JSON.stringify(bad)}`, () => {
    const root = mkdtempSync(join(tmpdir(), "units-"));
    mkdirSync(join(root, "skills"));
    writeFileSync(join(root, "skills", "VERSION"), bad);
    assert.throws(() => readUnitVersion(root, "skills"), /skills version is invalid/);
  });
}

test("a unit VERSION file that is missing or a symlink is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "units-"));
  assert.throws(() => readUnitVersion(root, "skills"), /skills version is invalid/);
  mkdirSync(join(root, "skills"));
  writeFileSync(join(root, "real"), "0.1.9\n");
  symlinkSync(join(root, "real"), join(root, "skills", "VERSION"));
  assert.throws(() => readUnitVersion(root, "skills"), /skills version is invalid/);
});

test("a JSON unit version must be a stable version string", () => {
  const root = mkdtempSync(join(tmpdir(), "units-"));
  mkdirSync(join(root, "packages", "protocol"), { recursive: true });
  writeFileSync(join(root, "packages", "protocol", "package.json"), '{"version":"1.2.3-rc.1"}\n');
  assert.throws(() => readUnitVersion(root, "protocol"), /protocol version is invalid/);
  writeFileSync(join(root, "packages", "protocol", "package.json"), '{"version":7}\n');
  assert.throws(() => readUnitVersion(root, "protocol"), /protocol version is invalid/);
  writeFileSync(join(root, "packages", "protocol", "package.json"), '{"version":"1.2.3"}\n');
  assert.equal(readUnitVersion(root, "protocol"), "1.2.3");
});
