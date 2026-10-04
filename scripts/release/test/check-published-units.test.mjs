import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  checkReleasePublication, checkUnitDestinations, collectReleaseEvidence, createUnitCheckPlan, evaluateReleaseSetState,
  evaluateUnitState, githubReleaseAssetCatalog, parsePublishedArguments, unitDestinations, unitReleaseAssets,
  unitReleaseManifest, writePublicationReceipt,
} from "../check-published.mjs";
import { releaseFixture } from "./release-fixture.mjs";

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

test("a unit check plan is accepted only in its exact frozen created shape", () => {
  const checks = plan("protocol", "0.2.0", "protocol-v0.2.0");
  const observations = absent(checks);
  assert.equal(evaluateUnitState(checks, observations), "clean");
  const variants = [
    new Proxy(checks, {}),
    [...checks],
    checks.map((check) => Object.freeze({ ...check, unit: "nope" })),
    checks.map((check) => Object.freeze({ ...check, unit: "dashboard-client" })),
    checks.map((check, index) => Object.freeze({ ...check, kind: index === 0 ? "maven" : check.kind })),
    checks.map((check, index) => Object.freeze({ ...check, destination: index === 0 ? "https://example.invalid/foreign" : check.destination })),
    checks.map((check) => Object.freeze({ ...check, extra: true })),
    checks.map(({ tag, ...check }) => Object.freeze(check)),
    checks.map((check) => Object.freeze({ ...check, tag: "protocol-v0.2.1" })),
    checks.map((check, index) => Object.freeze({ ...check, expectedEvidence: index === 0 ? "f".repeat(64) : check.expectedEvidence })),
    Object.freeze([checks[1], checks[0]]),
    Object.freeze(checks.slice(0, 1)),
    Object.freeze([...checks, ...plan("skills", "0.1.9", "skills-v0.1.9")]),
    Object.freeze([...checks].map((check) => new Proxy(check, {}))),
  ];
  for (const variant of variants) {
    assert.throws(() => evaluateUnitState(variant, observations), /Published unit check plan is invalid/u);
  }
});

test("a release set with the same unit twice fails before any probe runs", async () => {
  const protocol = plan("protocol", "0.2.0", "protocol-v0.2.0");
  const calls = [];
  const probe = async (check) => { calls.push(check.id); return { id: check.id, state: "absent" }; };
  await assert.rejects(checkUnitDestinations({ plans: [protocol, protocol], probe }), /Published unit check plan is invalid/u);
  await assert.rejects(checkUnitDestinations({ plans: [protocol, plan("protocol", "0.2.1", "protocol-v0.2.1")], probe }), /Published unit check plan is invalid/u);
  await assert.rejects(checkUnitDestinations({ plans: [], probe }), /Published unit check plan is invalid/u);
  await assert.rejects(checkUnitDestinations({ plans: new Proxy([protocol], {}), probe }), /Published unit check plan is invalid/u);
  assert.deepEqual(calls, []);
});

test("release asset catalogs are per unit and never attach image archives", () => {
  assert.deepEqual(githubReleaseAssetCatalog("gauntlet", "0.1.9").map(({ name }) => name), [
    "gauntlet-compose-0.1.9.tar.gz", "gauntlet-0.1.9.tgz", "gauntlet-0.1.9.provenance.json",
    "gauntlet-linux-amd64.spdx.json", "gauntlet-linux-arm64.spdx.json",
    "release-manifest.json", "publication-receipt.json", "SHA256SUMS",
  ]);
  assert.deepEqual(githubReleaseAssetCatalog("skills", "0.1.9").map(({ name }) => name), [
    "gauntlet-skills-0.1.9.tgz", "release-manifest.json", "publication-receipt.json", "SHA256SUMS",
  ]);
  assert.deepEqual(githubReleaseAssetCatalog("protocol", "0.2.0").map(({ name }) => name)[0], "8lines-gauntlet-protocol-0.2.0.tgz");
  assert.deepEqual(githubReleaseAssetCatalog("php-core", "0.1.9").map(({ name }) => name)[0], "gauntlet-php-core-0.1.9.tar.gz");
  assert.deepEqual(githubReleaseAssetCatalog("java-core", "0.1.9").map(({ name }) => name)[0], "gauntlet-core-0.1.9.tar.gz");
  const mib = 1024 * 1024;
  assert.deepEqual(githubReleaseAssetCatalog("gauntlet", "0.1.9").map(({ maximumBytes }) => maximumBytes), [
    512 * mib, 64 * mib, 16 * mib, 128 * mib, 128 * mib, mib, 64 * 1024, mib,
  ]);
  assert.equal(githubReleaseAssetCatalog("java-core", "0.1.9")[0].maximumBytes, 512 * mib);
  assert.equal(Object.isFrozen(githubReleaseAssetCatalog("skills", "0.1.9")), true);
  assert.equal(githubReleaseAssetCatalog("skills", "0.1.9").every(Object.isFrozen), true);
  assert.throws(() => githubReleaseAssetCatalog("nope", "0.1.9"));
  assert.throws(() => githubReleaseAssetCatalog("skills", "v0.1.9"));
});

test("finalization writes one manifest, receipt and checksum file per unit", async (t) => {
  const units = [{ id: "gauntlet", version: "0.1.0" }, { id: "skills", version: "0.1.0" }];
  const { root, digest } = releaseFixture(t, units);
  assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "skills", imageDigest: digest, chartDigest: digest }));
  assert.deepEqual(writePublicationReceipt({ releaseDirectory: root, unit: "skills", imageDigest: null, chartDigest: null }), { unit: "skills", files: 3 });
  const manifest = JSON.parse(readFileSync(resolve(root, "release-manifest.json"), "utf8"));
  const unitManifestBytes = readFileSync(resolve(root, "units/skills/release-manifest.json"));
  assert.equal(unitManifestBytes.toString("utf8"), `${JSON.stringify(unitReleaseManifest(manifest, "skills"), null, 2)}\n`);
  const receipt = JSON.parse(readFileSync(resolve(root, "units/skills/publication-receipt.json"), "utf8"));
  assert.deepEqual(Object.keys(receipt), ["schemaVersion", "releaseSet", "unit", "version", "sourceCommit", "manifestSha256"]);
  assert.equal(receipt.manifestSha256, createHash("sha256").update(unitManifestBytes).digest("hex"));
  assert.deepEqual(readFileSync(resolve(root, "units/skills/SHA256SUMS"), "utf8").trimEnd().split("\n").map((line) => line.split("  ")[1]), [
    "publication-receipt.json", "release-manifest.json", "skills/gauntlet-skills-0.1.0.tgz",
  ]);
  assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "gauntlet", imageDigest: null, chartDigest: null }));
  assert.equal(writePublicationReceipt({ releaseDirectory: root, unit: "gauntlet", imageDigest: digest, chartDigest: digest }).files, 9);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(resolve(root, "units/gauntlet/publication-receipt.json"), "utf8"))).slice(-2), ["imageDigest", "chartDigest"]);
});

test("a unit manifest and its release assets come only from that unit of the staged manifest", async (t) => {
  const units = [{ id: "gauntlet", version: "0.1.0" }, { id: "skills", version: "0.1.0" }];
  const { root } = releaseFixture(t, units);
  const manifest = JSON.parse(readFileSync(resolve(root, "release-manifest.json"), "utf8"));
  const skills = unitReleaseManifest(manifest, "skills");
  assert.deepEqual(Object.keys(skills), ["schemaVersion", "releaseSet", "sourceCommit", "units", "artifacts"]);
  assert.deepEqual(skills.units, [{ id: "skills", version: "0.1.0", tag: "skills-v0.1.0" }]);
  assert.deepEqual(skills.artifacts.map(({ path }) => path), ["skills/gauntlet-skills-0.1.0.tgz"]);
  assert.equal(Object.isFrozen(skills), true);
  assert.equal(unitReleaseManifest(manifest, "gauntlet").artifacts.length, 7);
  assert.throws(() => unitReleaseManifest(manifest, "protocol"));
  assert.deepEqual(unitReleaseAssets(manifest, "gauntlet").map(({ name, path }) => [name, path]), [
    ["gauntlet-compose-0.1.0.tar.gz", "compose/gauntlet-compose-0.1.0.tar.gz"],
    ["gauntlet-0.1.0.tgz", "helm/gauntlet-0.1.0.tgz"],
    ["gauntlet-0.1.0.provenance.json", "image/gauntlet-0.1.0.provenance.json"],
    ["gauntlet-linux-amd64.spdx.json", "sbom/gauntlet-linux-amd64.spdx.json"],
    ["gauntlet-linux-arm64.spdx.json", "sbom/gauntlet-linux-arm64.spdx.json"],
    ["release-manifest.json", "units/gauntlet/release-manifest.json"],
    ["publication-receipt.json", "units/gauntlet/publication-receipt.json"],
    ["SHA256SUMS", "units/gauntlet/SHA256SUMS"],
  ]);
  assert.deepEqual(
    unitReleaseAssets(manifest, "skills").map(({ name, maximumBytes }) => ({ name, maximumBytes })),
    githubReleaseAssetCatalog("skills", "0.1.0"),
  );
  assert.throws(() => unitReleaseAssets(manifest, "protocol"));
});

test("evidence and preflight are per unit and allow a mix of identical and clean units", async (t) => {
  const units = [{ id: "protocol", version: "0.1.0" }, { id: "skills", version: "0.1.0" }];
  const { root } = releaseFixture(t, units);
  const evidence = await collectReleaseEvidence({ releaseDirectory: root, sourceCommit: COMMIT });
  assert.deepEqual(evidence.units.map(({ id, tag, evidence: values }) => [id, tag, Object.keys(values)]), [
    ["protocol", "protocol-v0.1.0", ["npm:protocol", "github:protocol-v0.1.0"]],
    ["skills", "skills-v0.1.0", ["github:skills-v0.1.0"]],
  ]);
  assert.equal(evidence.releaseSet, "release-2026-10-03.1");
  assert.match(evidence.units[0].evidence["npm:protocol"], /^sha512-/u);
  const probe = async (check) => check.unit === "protocol"
    ? { id: check.id, state: "present", evidence: check.expectedEvidence }
    : { id: check.id, state: "absent" };
  const result = await checkReleasePublication(
    { releaseDirectory: root, sourceCommit: COMMIT, requireIdentical: false, unit: null },
    { collectEvidence: collectReleaseEvidence, probe },
  );
  assert.deepEqual(result.units.map(({ id, kind, state }) => [id, kind, state]), [
    ["protocol", "npm", "already-identical"], ["skills", "skills", "clean"],
  ]);
  const one = await checkReleasePublication(
    { releaseDirectory: root, sourceCommit: COMMIT, requireIdentical: false, unit: "skills" },
    { collectEvidence: collectReleaseEvidence, probe },
  );
  assert.deepEqual(one.units.map(({ id }) => id), ["skills"]);
  await assert.rejects(checkReleasePublication(
    { releaseDirectory: root, sourceCommit: COMMIT, requireIdentical: false, unit: "gauntlet" },
    { collectEvidence: collectReleaseEvidence, probe },
  ), TypeError);
  await assert.rejects(checkReleasePublication(
    { releaseDirectory: root, sourceCommit: COMMIT, requireIdentical: false, unit: "nope" },
    { collectEvidence: collectReleaseEvidence, probe },
  ), TypeError);
});

test("the CLI accepts only per-unit preflight, verification and finalization shapes", () => {
  const directory = "/workspace/.artifacts/release/release-2026-10-03.1";
  assert.deepEqual(parsePublishedArguments(["--release-directory", directory, "--source-commit", COMMIT]),
    { command: "check", releaseDirectory: directory, sourceCommit: COMMIT, unit: null, requireIdentical: false });
  assert.deepEqual(parsePublishedArguments(["--release-directory", directory, "--source-commit", COMMIT, "--unit", "skills", "--require-identical"]),
    { command: "check", releaseDirectory: directory, sourceCommit: COMMIT, unit: "skills", requireIdentical: true });
  assert.deepEqual(parsePublishedArguments(["--release-directory", directory, "--source-commit", COMMIT, "--require-identical"]),
    { command: "check", releaseDirectory: directory, sourceCommit: COMMIT, unit: null, requireIdentical: true });
  assert.deepEqual(parsePublishedArguments(["--release-directory", directory, "--source-commit", COMMIT, "--unit", "skills", "--require-draft-identical"]),
    { command: "verify-draft", releaseDirectory: directory, sourceCommit: COMMIT, unit: "skills" });
  assert.deepEqual(parsePublishedArguments(["--finalize", directory, "--unit", "skills"]),
    { command: "finalize", releaseDirectory: directory, unit: "skills", imageDigest: null, chartDigest: null });
  assert.deepEqual(parsePublishedArguments(["--finalize", directory, "--unit", "gauntlet", "--image-digest", `sha256:${"a".repeat(64)}`, "--chart-digest", `sha256:${"b".repeat(64)}`]),
    { command: "finalize", releaseDirectory: directory, unit: "gauntlet", imageDigest: `sha256:${"a".repeat(64)}`, chartDigest: `sha256:${"b".repeat(64)}` });
  for (const argv of [
    [],
    ["--release-directory", directory, "--source-commit", COMMIT, "--require-draft-identical"],
    ["--release-directory", directory, "--version", "0.1.0", "--source-commit", COMMIT],
    ["--finalize", directory, "--unit", "gauntlet"],
    ["--finalize", directory],
    ["--finalize", directory, "--unit", "skills", "--image-digest", `sha256:${"a".repeat(64)}`, "--chart-digest", `sha256:${"a".repeat(64)}`],
    ["--release-directory", directory, "--source-commit", COMMIT, "--unit", "nope"],
    ["--release-directory", "relative", "--source-commit", COMMIT],
    ["--release-directory", directory, "--source-commit", COMMIT, "--require-identical", "--require-draft-identical"],
    ["--release-directory", directory, "--source-commit", COMMIT, "--unknown"],
  ]) assert.throws(() => parsePublishedArguments(argv), /Usage: check-published\.mjs/u);
});
