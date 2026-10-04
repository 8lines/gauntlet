import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  createReleaseManifest,
  expectedReleaseArtifacts,
  expectedUnitArtifacts,
  readReleaseManifest,
  verifyReleaseInventory,
  verifyStagedReleaseInventory,
  writeReleaseInventory,
} from "../inventory.mjs";
import { RELEASE_UNITS, dependencyOrder } from "../units.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const requireFromProtocol = createRequire(resolve(ROOT, "packages/protocol/package.json"));
const Ajv2020 = requireFromProtocol("ajv/dist/2020").default;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SET = "release-2026-10-03.1";
const ALL_UNITS = Object.freeze(dependencyOrder().map((id) => ({ id, version: "0.1.0" })));

function artifact(unit, kind, name, path, sha256) {
  return { unit, kind, name, path, ...(sha256 === undefined ? {} : { sha256 }) };
}

function sandbox() {
  const path = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-inventory-test-")));
  chmodSync(path, 0o700);
  return path;
}

function stageFiles(root, units) {
  return expectedReleaseArtifacts(units).map(({ unit, kind, name, path }, index) => {
    mkdirSync(resolve(root, path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(resolve(root, path), `artifact-${index}\n`, { mode: 0o600 });
    return { unit, kind, name, path };
  });
}

const RELEASE_ARTIFACT_FIXTURES = Object.freeze([
  ["protocol", "npm", "@8lines/gauntlet-protocol", "npm/8lines-gauntlet-protocol-0.1.0.tgz"],
  ["dashboard-client", "npm", "@8lines/gauntlet-dashboard-client", "npm/8lines-gauntlet-dashboard-client-0.1.0.tgz"],
  ["typescript-core", "npm", "@8lines/gauntlet-typescript-core", "npm/8lines-gauntlet-typescript-core-0.1.0.tgz"],
  ["typescript-node", "npm", "@8lines/gauntlet-typescript-node", "npm/8lines-gauntlet-typescript-node-0.1.0.tgz"],
  ["next-adapter", "npm", "@8lines/gauntlet-next-adapter", "npm/8lines-gauntlet-next-adapter-0.1.0.tgz"],
  ["conformance-runner", "npm", "@8lines/gauntlet-conformance-runner", "npm/8lines-gauntlet-conformance-runner-0.1.0.tgz"],
  ["widget", "npm", "@8lines/gauntlet-widget", "npm/8lines-gauntlet-widget-0.1.0.tgz"],
  ["php-core", "composer", "8lines/gauntlet-php-core", "composer/artifacts/gauntlet-php-core-0.1.0.tar.gz"],
  ["symfony-bundle", "composer", "8lines/gauntlet-symfony-bundle", "composer/artifacts/gauntlet-symfony-bundle-0.1.0.tar.gz"],
  ["java-core", "maven", "dev.eightlines.gauntlet:core", "maven/artifacts/gauntlet-core-0.1.0.tar.gz"],
  ["spring-boot-starter", "maven", "dev.eightlines.gauntlet:spring-boot-starter", "maven/artifacts/gauntlet-spring-boot-starter-0.1.0.tar.gz"],
  ["gauntlet", "compose", "gauntlet-compose", "compose/gauntlet-compose-0.1.0.tar.gz"],
  ["gauntlet", "helm", "gauntlet", "helm/gauntlet-0.1.0.tgz"],
  ["gauntlet", "docker", "gauntlet.local/gauntlet", "image/gauntlet-0.1.0.docker.tar"],
  ["gauntlet", "oci", "ghcr.io/8lines/gauntlet", "image/gauntlet-0.1.0.oci.tar"],
  ["gauntlet", "provenance", "ghcr.io/8lines/gauntlet@buildkit-unsigned", "image/gauntlet-0.1.0.provenance.json"],
  ["gauntlet", "sbom", "ghcr.io/8lines/gauntlet@linux/amd64", "sbom/gauntlet-linux-amd64.spdx.json"],
  ["gauntlet", "sbom", "ghcr.io/8lines/gauntlet@linux/arm64", "sbom/gauntlet-linux-arm64.spdx.json"],
  ["skills", "skills", "gauntlet-skills", "skills/gauntlet-skills-0.1.0.tgz"],
]);

function writeCanonicalReleaseArtifacts(root) {
  return RELEASE_ARTIFACT_FIXTURES.map(([unit, kind, name, path], index) => {
    mkdirSync(resolve(root, path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(resolve(root, path), `artifact-${index}\n`, { mode: 0o600 });
    return artifact(unit, kind, name, path);
  });
}

function validateSchema(manifest) {
  const schema = JSON.parse(readFileSync(resolve(ROOT, "scripts/release/release-manifest.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  assert.equal(ajv.validate(schema, manifest), true, JSON.stringify(ajv.errors));
}

test("creates a closed, sorted and deeply frozen schema 2 release manifest", () => {
  const manifest = createReleaseManifest({
    releaseSet: SET,
    sourceCommit: COMMIT,
    units: [{ id: "protocol", version: "0.2.0" }, { id: "php-core", version: "0.1.0" }],
    artifacts: [
      artifact("protocol", "npm", "@8lines/z", "npm/z.tgz", SHA_B),
      artifact("php-core", "composer", "8lines/a", "composer/a.tar.gz", SHA_A),
    ],
  });
  assert.deepEqual(manifest, {
    schemaVersion: 2,
    releaseSet: SET,
    sourceCommit: COMMIT,
    units: [
      { id: "protocol", version: "0.2.0", tag: "protocol-v0.2.0" },
      { id: "php-core", version: "0.1.0", tag: "php-core-v0.1.0" },
    ],
    artifacts: [
      artifact("php-core", "composer", "8lines/a", "composer/a.tar.gz", SHA_A),
      artifact("protocol", "npm", "@8lines/z", "npm/z.tgz", SHA_B),
    ],
  });
  assert.deepEqual(Object.keys(manifest), ["schemaVersion", "releaseSet", "sourceCommit", "units", "artifacts"]);
  assert.deepEqual(Object.keys(manifest.artifacts[0]), ["unit", "kind", "name", "path", "sha256"]);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.units), true);
  assert.equal(Object.isFrozen(manifest.units[0]), true);
  assert.equal(Object.isFrozen(manifest.artifacts), true);
  assert.equal(Object.isFrozen(manifest.artifacts[0]), true);
  validateSchema(manifest);
  validateSchema(createReleaseManifest({
    releaseSet: "local-0123456789ab",
    sourceCommit: COMMIT,
    units: ALL_UNITS,
    artifacts: [artifact("gauntlet", "helm", "gauntlet", "helm/gauntlet-0.1.0.tgz", SHA_A)],
  }));
});

test("inventories the explicit unsigned BuildKit provenance classification as an ordinary artifact", () => {
  const manifest = createReleaseManifest({
    releaseSet: SET,
    sourceCommit: COMMIT,
    units: [{ id: "gauntlet", version: "0.1.0" }],
    artifacts: [artifact(
      "gauntlet",
      "provenance",
      "ghcr.io/8lines/gauntlet@buildkit-unsigned",
      "image/gauntlet-0.1.0.provenance.json",
      SHA_A,
    )],
  });
  validateSchema(manifest);
  assert.equal(manifest.artifacts[0].kind, "provenance");
});

test("rejects open, exotic, duplicate and malformed manifest input", () => {
  const valid = {
    releaseSet: SET,
    sourceCommit: COMMIT,
    units: [{ id: "protocol", version: "0.1.0" }],
    artifacts: [artifact("protocol", "npm", "@8lines/a", "npm/a.tgz", SHA_A)],
  };
  for (const options of [
    null,
    [],
    { ...valid, extra: true },
    { ...valid, releaseSet: "v0.1.0" },
    { ...valid, releaseSet: "release-2026-02-30.1" },
    { ...valid, sourceCommit: COMMIT.toUpperCase() },
    { ...valid, units: [{ id: "protocol", version: "v0.1.0" }] },
    { ...valid, units: [{ id: "protocol", version: "0.1.0", tag: "v0.1.0" }] },
    { ...valid, units: [{ id: "protocol", version: "0.1.0" }, { id: "protocol", version: "0.1.0" }] },
    { ...valid, units: [{ id: "protocol", version: "0.1.0", extra: true }] },
    { ...valid, artifacts: [] },
    { ...valid, artifacts: [artifact("protocol", "unknown", "a", "a", SHA_A)] },
    { ...valid, artifacts: [artifact("widget", "npm", "@8lines/a", "npm/a.tgz", SHA_A)] },
    { ...valid, artifacts: [{ kind: "npm", name: "@8lines/a", path: "npm/a.tgz", sha256: SHA_A }] },
    { ...valid, artifacts: [artifact("protocol", "npm", "", "a", SHA_A)] },
    { ...valid, artifacts: [artifact("protocol", "npm", "a", "../a", SHA_A)] },
    { ...valid, artifacts: [artifact("protocol", "npm", "a", "/a", SHA_A)] },
    { ...valid, artifacts: [artifact("protocol", "npm", "a", "a\\b", SHA_A)] },
    { ...valid, artifacts: [artifact("protocol", "npm", "a", "a", "A".repeat(64))] },
    { ...valid, artifacts: [{ ...artifact("protocol", "npm", "a", "a", SHA_A), extra: true }] },
    { ...valid, artifacts: [artifact("protocol", "npm", "a", "a", SHA_A), artifact("protocol", "npm", "a", "b", SHA_B)] },
    { ...valid, artifacts: [artifact("protocol", "npm", "a", "a", SHA_A), artifact("protocol", "npm", "b", "a", SHA_B)] },
    Object.create({ inherited: true }, Object.getOwnPropertyDescriptors(valid)),
  ]) {
    assert.throws(() => createReleaseManifest(options), { message: "Release inventory input is invalid" });
  }
  assert.throws(() => createReleaseManifest(new Proxy(valid, {})), { message: "Release inventory input is invalid" });
  let touched = false;
  assert.throws(
    () => createReleaseManifest({
      releaseSet: SET,
      sourceCommit: COMMIT,
      units: valid.units,
      get artifacts() { touched = true; return []; },
    }),
    { message: "Release inventory input is invalid" },
  );
  assert.equal(touched, false);
});

test("manifests reject unknown units, wrong order and malformed release sets", () => {
  const artifacts = [{ unit: "skills", kind: "skills", name: "gauntlet-skills", path: "skills/gauntlet-skills-0.1.9.tgz", sha256: SHA_A }];
  for (const options of [
    { releaseSet: SET, sourceCommit: COMMIT, units: [{ id: "nope", version: "0.1.9" }], artifacts },
    { releaseSet: SET, sourceCommit: COMMIT, units: [{ id: "skills", version: "0.1.9" }, { id: "gauntlet", version: "0.1.9" }], artifacts },
    { releaseSet: "0.1.9", sourceCommit: COMMIT, units: [{ id: "skills", version: "0.1.9" }], artifacts },
    { releaseSet: SET, sourceCommit: COMMIT, units: [], artifacts },
  ]) assert.throws(() => createReleaseManifest(options), /input is invalid/u);
});

test("expected artifacts are one archive per package unit and seven for the application", () => {
  assert.deepEqual(expectedUnitArtifacts("protocol", "0.2.0"), [
    { unit: "protocol", kind: "npm", name: "@8lines/gauntlet-protocol", path: "npm/8lines-gauntlet-protocol-0.2.0.tgz" },
  ]);
  assert.deepEqual(expectedUnitArtifacts("symfony-bundle", "0.1.9"), [{
    unit: "symfony-bundle", kind: "composer", name: "8lines/gauntlet-symfony-bundle",
    path: "composer/artifacts/gauntlet-symfony-bundle-0.1.9.tar.gz",
  }]);
  assert.deepEqual(expectedUnitArtifacts("spring-boot-starter", "0.1.9").map(({ path }) => path), [
    "maven/artifacts/gauntlet-spring-boot-starter-0.1.9.tar.gz",
  ]);
  assert.deepEqual(expectedUnitArtifacts("skills", "0.1.9").map(({ path }) => path), ["skills/gauntlet-skills-0.1.9.tgz"]);
  assert.deepEqual(expectedUnitArtifacts("gauntlet", "0.1.9").map(({ kind }) => kind), [
    "compose", "docker", "helm", "oci", "provenance", "sbom", "sbom",
  ]);
  assert.equal(expectedReleaseArtifacts(RELEASE_UNITS.map(({ id }) => ({ id, version: "0.1.8" }))).length, 19);
  assert.deepEqual(
    expectedReleaseArtifacts(ALL_UNITS).map(({ unit, kind, name, path }) => [unit, kind, name, path]),
    [...RELEASE_ARTIFACT_FIXTURES].sort((left, right) => Buffer.compare(
      Buffer.from(`${left[1]}\0${left[2]}\0${left[3]}`), Buffer.from(`${right[1]}\0${right[2]}\0${right[3]}`),
    )),
  );
  assert.throws(() => expectedUnitArtifacts("nope", "0.1.0"));
  assert.throws(() => expectedUnitArtifacts("skills", "v0.1.0"));
});

test("hashes regular owned files and writes byte-identical canonical inventory", async () => {
  const roots = [sandbox(), sandbox()];
  try {
    let expected;
    for (const root of roots) {
      mkdirSync(resolve(root, "npm"));
      mkdirSync(resolve(root, "composer"));
      writeFileSync(resolve(root, "npm/z.tgz"), "z bytes\n", { mode: 0o644 });
      writeFileSync(resolve(root, "composer/a.tar.gz"), "a bytes\n", { mode: 0o644 });
      const manifest = await writeReleaseInventory({
        outputDirectory: root,
        releaseSet: SET,
        sourceCommit: COMMIT,
        units: [{ id: "protocol", version: "0.1.0" }, { id: "php-core", version: "0.1.0" }],
        artifacts: [
          artifact("protocol", "npm", "@8lines/z", "npm/z.tgz"),
          artifact("php-core", "composer", "8lines/a", "composer/a.tar.gz"),
        ],
      });
      const manifestBytes = readFileSync(resolve(root, "release-manifest.json"));
      const sumsBytes = readFileSync(resolve(root, "SHA256SUMS"));
      assert.equal(statSync(resolve(root, "release-manifest.json")).mode & 0o777, 0o644);
      assert.equal(statSync(resolve(root, "SHA256SUMS")).mode & 0o777, 0o644);
      assert.deepEqual(manifest, JSON.parse(manifestBytes));
      assert.equal(manifest.artifacts[0].sha256, createHash("sha256").update("a bytes\n").digest("hex"));
      assert.equal(manifest.artifacts[1].sha256, createHash("sha256").update("z bytes\n").digest("hex"));
      assert.equal(
        sumsBytes.toString("utf8"),
        [...manifest.artifacts]
          .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
          .map(({ path, sha256 }) => `${sha256}  ${path}\n`)
          .join(""),
      );
      const snapshot = Buffer.concat([manifestBytes, Buffer.from([0]), sumsBytes]);
      if (expected === undefined) expected = snapshot;
      else assert.deepEqual(snapshot, expected);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("verifies the exact canonical 19-artifact inventory without external checksum tools", async () => {
  const root = sandbox();
  try {
    const artifacts = writeCanonicalReleaseArtifacts(root);
    await writeReleaseInventory({
      outputDirectory: root,
      releaseSet: SET,
      sourceCommit: COMMIT,
      units: ALL_UNITS,
      artifacts,
    });

    const report = verifyReleaseInventory({
      outputDirectory: root,
      releaseSet: SET,
      sourceCommit: COMMIT,
    });

    assert.equal(report.schemaVersion, 2);
    assert.equal(report.ok, true);
    assert.equal(report.releaseSet, SET);
    assert.equal(report.sourceCommit, COMMIT);
    assert.deepEqual(report.units.map(({ id }) => id), [
      "protocol", "dashboard-client", "gauntlet", "typescript-core", "typescript-node", "next-adapter",
      "conformance-runner", "widget", "php-core", "symfony-bundle", "java-core", "spring-boot-starter", "skills",
    ]);
    assert.equal(report.artifacts, 19);
    assert.deepEqual(Object.keys(report), [
      "schemaVersion", "ok", "releaseSet", "sourceCommit", "units", "artifacts", "manifestSha256",
      "checksumsSha256", "nativeImage", "multiPlatformOci", "helmChart",
    ]);
    assert.match(report.manifestSha256, /^[0-9a-f]{64}$/u);
    assert.match(report.checksumsSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(report.nativeImage, {
      path: "image/gauntlet-0.1.0.docker.tar",
      sha256: createHash("sha256").update("artifact-13\n").digest("hex"),
    });
    assert.deepEqual(report.multiPlatformOci, {
      path: "image/gauntlet-0.1.0.oci.tar",
      sha256: createHash("sha256").update("artifact-14\n").digest("hex"),
      platforms: ["linux/amd64", "linux/arm64"],
      verification: "deeply-validated-during-staging",
    });
    assert.deepEqual(report.helmChart, {
      path: "helm/gauntlet-0.1.0.tgz",
      sha256: createHash("sha256").update("artifact-12\n").digest("hex"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a schema 2 inventory verifies only the planned units' closed artifact set", async () => {
  const root = sandbox();
  try {
    const units = [{ id: "gauntlet", version: "0.1.9" }, { id: "skills", version: "0.1.9" }];
    const manifest = await writeReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT, units, artifacts: stageFiles(root, units) });
    assert.deepEqual(manifest.units, [{ id: "gauntlet", version: "0.1.9", tag: "v0.1.9" }, { id: "skills", version: "0.1.9", tag: "skills-v0.1.9" }]);
    const report = verifyReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT });
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.artifacts, 8);
    assert.equal(report.helmChart.path, "helm/gauntlet-0.1.9.tgz");
    assert.throws(() => verifyReleaseInventory({ outputDirectory: root, releaseSet: "release-2026-10-03.2", sourceCommit: COMMIT }));
    assert.throws(() => verifyReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: "f".repeat(40) }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package-only inventory has no application evidence", async () => {
  const root = sandbox();
  try {
    const units = [{ id: "php-core", version: "0.1.9" }];
    await writeReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT, units, artifacts: stageFiles(root, units) });
    const report = verifyReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT });
    assert.equal(report.artifacts, 1);
    assert.deepEqual(report.units, [{ id: "php-core", version: "0.1.9", tag: "php-core-v0.1.9" }]);
    assert.equal(report.nativeImage, null);
    assert.equal(report.multiPlatformOci, null);
    assert.equal(report.helmChart, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory rejects an artifact of an unplanned unit and a missing application artifact", async () => {
  const unplanned = sandbox();
  const missing = sandbox();
  try {
    const php = [{ id: "php-core", version: "0.1.9" }];
    const extra = { unit: "protocol", kind: "npm", name: "@8lines/gauntlet-protocol", path: "npm/8lines-gauntlet-protocol-0.1.9.tgz" };
    mkdirSync(resolve(unplanned, "npm"), { mode: 0o700 });
    writeFileSync(resolve(unplanned, extra.path), "extra\n", { mode: 0o600 });
    await assert.rejects(writeReleaseInventory({
      outputDirectory: unplanned, releaseSet: SET, sourceCommit: COMMIT, units: php, artifacts: [...stageFiles(unplanned, php), extra],
    }), /input is invalid/u);

    const units = [{ id: "gauntlet", version: "0.1.9" }];
    const artifacts = stageFiles(missing, units).filter(({ name }) => !name.endsWith("@linux/arm64"));
    rmSync(resolve(missing, "sbom/gauntlet-linux-arm64.spdx.json"));
    await writeReleaseInventory({ outputDirectory: missing, releaseSet: SET, sourceCommit: COMMIT, units, artifacts });
    assert.throws(() => verifyReleaseInventory({ outputDirectory: missing, releaseSet: SET, sourceCommit: COMMIT }), /failed closed/u);
  } finally {
    rmSync(unplanned, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("inventory verification rejects an artifact labelled with another planned unit", async () => {
  const root = sandbox();
  try {
    const units = [{ id: "gauntlet", version: "0.1.9" }, { id: "skills", version: "0.1.9" }];
    const artifacts = stageFiles(root, units)
      .map((record) => record.kind === "helm" ? { ...record, unit: "skills" } : record);
    const manifest = await writeReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT, units, artifacts });
    assert.equal(manifest.artifacts.find(({ kind }) => kind === "helm").unit, "skills");
    assert.throws(
      () => verifyReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT }),
      { message: "Release inventory verification failed closed" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory verification rejects wrong counts, incomplete checksum identity, changed artifacts and extra files", async () => {
  for (const mutation of ["count", "checksums", "artifact", "extra"]) {
    const root = sandbox();
    try {
      const artifacts = writeCanonicalReleaseArtifacts(root);
      if (mutation === "count") artifacts.pop();
      await writeReleaseInventory({
        outputDirectory: root,
        releaseSet: SET,
        sourceCommit: COMMIT,
        units: ALL_UNITS,
        artifacts,
      });
      if (mutation === "checksums") {
        const [first] = readFileSync(resolve(root, "SHA256SUMS"), "utf8").split("\n");
        writeFileSync(resolve(root, "SHA256SUMS"), `${first}\n`, { mode: 0o600 });
      }
      if (mutation === "artifact") {
        writeFileSync(resolve(root, RELEASE_ARTIFACT_FIXTURES[0][3]), "changed\n", { mode: 0o600 });
      }
      if (mutation === "extra") writeFileSync(resolve(root, "unexpected-debug.log"), "unexpected\n", { mode: 0o600 });
      assert.throws(
        () => verifyReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT }),
        { message: "Release inventory verification failed closed" },
        mutation,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("staged verification binds the release-set root name and canonical manifests read back exactly", async () => {
  const parent = sandbox();
  try {
    const units = [{ id: "skills", version: "0.1.9" }];
    for (const name of [SET, "release-2026-10-03.2"]) {
      const root = resolve(parent, name);
      mkdirSync(root, { mode: 0o700 });
      await writeReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT, units, artifacts: stageFiles(root, units) });
    }
    const report = verifyStagedReleaseInventory(resolve(parent, SET));
    assert.equal(report.releaseSet, SET);
    assert.equal(report.artifacts, 1);
    assert.throws(
      () => verifyStagedReleaseInventory(resolve(parent, "release-2026-10-03.2")),
      { message: "Release inventory verification failed closed" },
    );

    const { manifest, bytes } = readReleaseManifest(resolve(parent, SET));
    assert.deepEqual(bytes, readFileSync(resolve(parent, SET, "release-manifest.json")));
    assert.equal(manifest.releaseSet, SET);
    assert.deepEqual(manifest.units, [{ id: "skills", version: "0.1.9", tag: "skills-v0.1.9" }]);
    writeFileSync(resolve(parent, SET, "extra-after-finalization"), "allowed\n");
    assert.equal(readReleaseManifest(resolve(parent, SET)).manifest.releaseSet, SET);
    writeFileSync(resolve(parent, SET, "release-manifest.json"), JSON.stringify(manifest));
    assert.throws(() => readReleaseManifest(resolve(parent, SET)), /failed closed/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("fails closed for unsafe files, outputs and descriptors without clobbering bytes", async () => {
  const root = sandbox();
  const outside = sandbox();
  try {
    writeFileSync(resolve(root, "good.bin"), "good");
    writeFileSync(resolve(outside, "secret.bin"), "secret");
    symlinkSync(resolve(outside, "secret.bin"), resolve(root, "link.bin"));
    linkSync(resolve(root, "good.bin"), resolve(root, "hard.bin"));
    const base = {
      outputDirectory: root,
      releaseSet: SET,
      sourceCommit: COMMIT,
      units: [{ id: "gauntlet", version: "0.1.0" }],
    };
    for (const path of ["link.bin", "hard.bin"]) {
      await assert.rejects(
        writeReleaseInventory({ ...base, artifacts: [artifact("gauntlet", "sbom", "unsafe", path)] }),
        { message: "Release inventory generation failed closed" },
      );
      assert.deepEqual(readdirSync(root).sort(), ["good.bin", "hard.bin", "link.bin"]);
    }
    for (const path of ["../secret.bin", "/etc/passwd"]) {
      await assert.rejects(
        writeReleaseInventory({ ...base, artifacts: [artifact("gauntlet", "sbom", "unsafe", path)] }),
        { message: "Release inventory input is invalid" },
      );
      assert.deepEqual(readdirSync(root).sort(), ["good.bin", "hard.bin", "link.bin"]);
    }
    writeFileSync(resolve(root, "release-manifest.json"), "FOREIGN\n");
    await assert.rejects(
      writeReleaseInventory({ ...base, artifacts: [artifact("gauntlet", "sbom", "safe", "good.bin")] }),
      { message: "Release inventory generation failed closed" },
    );
    assert.equal(readFileSync(resolve(root, "release-manifest.json"), "utf8"), "FOREIGN\n");
    assert.equal(readdirSync(root).some((name) => name.includes("gauntlet-inventory")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
