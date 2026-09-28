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

import { createReleaseManifest, verifyReleaseInventory, writeReleaseInventory } from "../inventory.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const requireFromProtocol = createRequire(resolve(ROOT, "packages/protocol/package.json"));
const Ajv2020 = requireFromProtocol("ajv/dist/2020").default;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function artifact(kind, name, path, sha256) {
  return { kind, name, path, ...(sha256 === undefined ? {} : { sha256 }) };
}

function sandbox() {
  const path = mkdtempSync(resolve(tmpdir(), "gauntlet-inventory-test-"));
  chmodSync(path, 0o700);
  return path;
}

const RELEASE_ARTIFACT_FIXTURES = Object.freeze([
  ["npm", "@8lines/gauntlet-protocol", "npm/8lines-gauntlet-protocol-0.1.0.tgz"],
  ["npm", "@8lines/gauntlet-dashboard-client", "npm/8lines-gauntlet-dashboard-client-0.1.0.tgz"],
  ["npm", "@8lines/gauntlet-typescript-core", "npm/8lines-gauntlet-typescript-core-0.1.0.tgz"],
  ["npm", "@8lines/gauntlet-typescript-node", "npm/8lines-gauntlet-typescript-node-0.1.0.tgz"],
  ["npm", "@8lines/gauntlet-next-adapter", "npm/8lines-gauntlet-next-adapter-0.1.0.tgz"],
  ["npm", "@8lines/gauntlet-conformance-runner", "npm/8lines-gauntlet-conformance-runner-0.1.0.tgz"],
  ["npm", "@8lines/gauntlet-widget", "npm/8lines-gauntlet-widget-0.1.0.tgz"],
  ["composer", "8lines/gauntlet-php-core", "composer/artifacts/gauntlet-php-core-0.1.0.tar.gz"],
  ["composer", "8lines/gauntlet-symfony-bundle", "composer/artifacts/gauntlet-symfony-bundle-0.1.0.tar.gz"],
  ["maven", "dev.eightlines.gauntlet:core", "maven/artifacts/gauntlet-core-0.1.0.tar.gz"],
  ["maven", "dev.eightlines.gauntlet:spring-boot-starter", "maven/artifacts/gauntlet-spring-boot-starter-0.1.0.tar.gz"],
  ["compose", "gauntlet-compose", "compose/gauntlet-compose-0.1.0.tar.gz"],
  ["helm", "gauntlet", "helm/gauntlet-0.1.0.tgz"],
  ["docker", "gauntlet.local/gauntlet", "image/gauntlet-0.1.0.docker.tar"],
  ["oci", "ghcr.io/8lines/gauntlet", "image/gauntlet-0.1.0.oci.tar"],
  ["provenance", "ghcr.io/8lines/gauntlet@buildkit-unsigned", "image/gauntlet-0.1.0.provenance.json"],
  ["sbom", "ghcr.io/8lines/gauntlet@linux/amd64", "sbom/gauntlet-linux-amd64.spdx.json"],
  ["sbom", "ghcr.io/8lines/gauntlet@linux/arm64", "sbom/gauntlet-linux-arm64.spdx.json"],
  ["skills", "gauntlet-skills", "skills/gauntlet-skills-0.1.0.tgz"],
]);

function writeCanonicalReleaseArtifacts(root) {
  return RELEASE_ARTIFACT_FIXTURES.map(([kind, name, path], index) => {
    mkdirSync(resolve(root, path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(resolve(root, path), `artifact-${index}\n`, { mode: 0o600 });
    return artifact(kind, name, path);
  });
}

test("creates a closed, sorted and deeply frozen release manifest", () => {
  const manifest = createReleaseManifest({
    version: "0.1.0",
    sourceCommit: COMMIT,
    artifacts: [
      artifact("npm", "@8lines/z", "npm/z.tgz", SHA_B),
      artifact("composer", "8lines/a", "composer/a.tar.gz", SHA_A),
    ],
  });
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    version: "0.1.0",
    sourceTag: "v0.1.0",
    sourceCommit: COMMIT,
    artifacts: [
      artifact("composer", "8lines/a", "composer/a.tar.gz", SHA_A),
      artifact("npm", "@8lines/z", "npm/z.tgz", SHA_B),
    ],
  });
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.artifacts), true);
  assert.equal(Object.isFrozen(manifest.artifacts[0]), true);

  const schema = JSON.parse(readFileSync(resolve(ROOT, "scripts/release/release-manifest.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  assert.equal(ajv.validate(schema, manifest), true, JSON.stringify(ajv.errors));
});

test("inventories the explicit unsigned BuildKit provenance classification as an ordinary artifact", () => {
  const manifest = createReleaseManifest({
    version: "0.1.0",
    sourceCommit: COMMIT,
    artifacts: [artifact(
      "provenance",
      "ghcr.io/8lines/gauntlet@buildkit-unsigned",
      "image/gauntlet-0.1.0.provenance.json",
      SHA_A,
    )],
  });
  const schema = JSON.parse(readFileSync(resolve(ROOT, "scripts/release/release-manifest.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  assert.equal(ajv.validate(schema, manifest), true, JSON.stringify(ajv.errors));
  assert.equal(manifest.artifacts[0].kind, "provenance");
});

test("rejects open, exotic, duplicate and malformed manifest input", () => {
  const valid = {
    version: "0.1.0",
    sourceCommit: COMMIT,
    artifacts: [artifact("npm", "@8lines/a", "npm/a.tgz", SHA_A)],
  };
  for (const options of [
    null,
    [],
    { ...valid, extra: true },
    { ...valid, version: "v0.1.0" },
    { ...valid, sourceCommit: COMMIT.toUpperCase() },
    { ...valid, artifacts: [] },
    { ...valid, artifacts: [artifact("unknown", "a", "a", SHA_A)] },
    { ...valid, artifacts: [artifact("npm", "", "a", SHA_A)] },
    { ...valid, artifacts: [artifact("npm", "a", "../a", SHA_A)] },
    { ...valid, artifacts: [artifact("npm", "a", "/a", SHA_A)] },
    { ...valid, artifacts: [artifact("npm", "a", "a\\b", SHA_A)] },
    { ...valid, artifacts: [artifact("npm", "a", "a", "A".repeat(64))] },
    { ...valid, artifacts: [{ ...artifact("npm", "a", "a", SHA_A), extra: true }] },
    { ...valid, artifacts: [artifact("npm", "a", "a", SHA_A), artifact("npm", "a", "b", SHA_B)] },
    { ...valid, artifacts: [artifact("npm", "a", "a", SHA_A), artifact("npm", "b", "a", SHA_B)] },
    Object.create({ inherited: true }, Object.getOwnPropertyDescriptors(valid)),
  ]) {
    assert.throws(() => createReleaseManifest(options), { message: "Release inventory input is invalid" });
  }
  assert.throws(() => createReleaseManifest(new Proxy(valid, {})), { message: "Release inventory input is invalid" });
  let touched = false;
  assert.throws(
    () => createReleaseManifest({
      version: "0.1.0",
      sourceCommit: COMMIT,
      get artifacts() { touched = true; return []; },
    }),
    { message: "Release inventory input is invalid" },
  );
  assert.equal(touched, false);
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
        version: "0.1.0",
        sourceCommit: COMMIT,
        artifacts: [
          artifact("npm", "@8lines/z", "npm/z.tgz"),
          artifact("composer", "8lines/a", "composer/a.tar.gz"),
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
      outputDirectory: realpathSync(root),
      version: "0.1.0",
      sourceCommit: COMMIT,
      artifacts,
    });

    const report = verifyReleaseInventory({
      outputDirectory: realpathSync(root),
      version: "0.1.0",
      sourceCommit: COMMIT,
    });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.ok, true);
    assert.equal(report.artifacts, 19);
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

test("inventory verification rejects wrong counts, incomplete checksum identity, changed artifacts and extra files", async () => {
  for (const mutation of ["count", "checksums", "artifact", "extra"]) {
    const root = sandbox();
    try {
      const artifacts = writeCanonicalReleaseArtifacts(root);
      if (mutation === "count") artifacts.pop();
      await writeReleaseInventory({
        outputDirectory: realpathSync(root),
        version: "0.1.0",
        sourceCommit: COMMIT,
        artifacts,
      });
      if (mutation === "checksums") {
        const [first] = readFileSync(resolve(root, "SHA256SUMS"), "utf8").split("\n");
        writeFileSync(resolve(root, "SHA256SUMS"), `${first}\n`, { mode: 0o600 });
      }
      if (mutation === "artifact") {
        writeFileSync(resolve(root, RELEASE_ARTIFACT_FIXTURES[0][2]), "changed\n", { mode: 0o600 });
      }
      if (mutation === "extra") writeFileSync(resolve(root, "unexpected-debug.log"), "unexpected\n", { mode: 0o600 });
      assert.throws(
        () => verifyReleaseInventory({ outputDirectory: realpathSync(root), version: "0.1.0", sourceCommit: COMMIT }),
        { message: "Release inventory verification failed closed" },
        mutation,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      version: "0.1.0",
      sourceCommit: COMMIT,
    };
    for (const path of ["link.bin", "hard.bin"]) {
      await assert.rejects(
        writeReleaseInventory({ ...base, artifacts: [artifact("sbom", "unsafe", path)] }),
        { message: "Release inventory generation failed closed" },
      );
      assert.deepEqual(readdirSync(root).sort(), ["good.bin", "hard.bin", "link.bin"]);
    }
    for (const path of ["../secret.bin", "/etc/passwd"]) {
      await assert.rejects(
        writeReleaseInventory({ ...base, artifacts: [artifact("sbom", "unsafe", path)] }),
        { message: "Release inventory input is invalid" },
      );
      assert.deepEqual(readdirSync(root).sort(), ["good.bin", "hard.bin", "link.bin"]);
    }
    writeFileSync(resolve(root, "release-manifest.json"), "FOREIGN\n");
    await assert.rejects(
      writeReleaseInventory({ ...base, artifacts: [artifact("sbom", "safe", "good.bin")] }),
      { message: "Release inventory generation failed closed" },
    );
    assert.equal(readFileSync(resolve(root, "release-manifest.json"), "utf8"), "FOREIGN\n");
    assert.equal(readdirSync(root).some((name) => name.includes("gauntlet-inventory")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
