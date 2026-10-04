import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createReleaseManifest, expectedReleaseArtifacts } from "../inventory.mjs";
import { RELEASE_ARTIFACTS } from "../release-model.mjs";
import { packageCanonicalTree } from "../tree-archive.mjs";
import { dependencyOrder } from "../units.mjs";

export const SET = "release-2026-10-03.1";
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const VERSION = "0.1.0";
export const ALL_UNITS = Object.freeze(dependencyOrder().map((id) => Object.freeze({ id, version: VERSION })));

export function writeFixtureFile(root, relativePath, bytes) {
  const path = resolve(root, relativePath);
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function canonicalManifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Rewrites the staged manifest canonically, so a mutation reaches the identity checks instead of
// failing the canonical-bytes check first.
export function rewriteManifest(root, mutate) {
  const path = resolve(root, "release-manifest.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  const manifest = createReleaseManifest({
    releaseSet: value.releaseSet,
    sourceCommit: value.sourceCommit,
    units: value.units,
    artifacts: value.artifacts,
  });
  writeFileSync(path, canonicalManifestText(manifest), { mode: 0o600 });
  return manifest;
}

export function composerSourceFiles(artifact, version, commit) {
  return [
    ["composer.json", `${JSON.stringify({ name: artifact.name, version })}\n`],
    [".gauntlet-source.json", `${JSON.stringify({ repository: "8lines/gauntlet", commit, path: artifact.directory, version })}\n`],
    ["src/Fixture.php", `<?php\n// ${artifact.name}\n`],
  ];
}

export function packageFixtureTree(scratch, outputPath, expectedPrefix, files) {
  const source = resolve(scratch, `tree-${expectedPrefix}-${createHash("sha256").update(outputPath).digest("hex").slice(0, 8)}`);
  mkdirSync(source, { mode: 0o700 });
  const outputDirectory = resolve(outputPath, "..");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  for (const [path, bytes] of files) writeFixtureFile(source, path, bytes);
  const receipt = packageCanonicalTree({
    sourceDirectory: realpathSync(source),
    outputDirectory: realpathSync(outputDirectory),
    filename: outputPath.split("/").at(-1),
    archivePrefix: expectedPrefix,
  });
  rmSync(source, { recursive: true, force: false });
  return receipt.sha256;
}

// Builds a staged release-set root `<temporary>/<SET>` holding every artifact of `units` and a canonical
// schema 2 manifest, the same shape `stage.mjs` produces.
export function releaseFixture(t, units = ALL_UNITS) {
  const temporaryRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-published-evidence-test-")));
  chmodSync(temporaryRoot, 0o700);
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const root = resolve(temporaryRoot, SET);
  mkdirSync(root, { mode: 0o700 });
  const scratch = resolve(temporaryRoot, "scratch");
  mkdirSync(scratch, { mode: 0o700 });
  const digest = `sha256:${"a".repeat(64)}`;
  const versions = new Map(units.map(({ id, version }) => [id, version]));
  const artifacts = expectedReleaseArtifacts(units).map((artifact) => {
    const version = versions.get(artifact.unit);
    const path = resolve(root, ...artifact.path.split("/"));
    let sha256;
    if (artifact.kind === "composer") {
      const composer = RELEASE_ARTIFACTS.composer.find(({ name }) => name === artifact.name);
      sha256 = packageFixtureTree(scratch, path, `${composer.repository.split("/").at(-1)}-${version}`, composerSourceFiles(composer, version, COMMIT));
    } else if (artifact.kind === "maven") {
      const artifactId = artifact.name.split(":")[1];
      sha256 = packageFixtureTree(scratch, path, `gauntlet-${artifactId}-${version}`, [[`${artifactId}-${version}.jar`, `jar:${artifact.name}\n`]]);
    } else if (artifact.kind === "oci") {
      const layout = resolve(scratch, "layout");
      mkdirSync(resolve(layout, "blobs"), { recursive: true, mode: 0o700 });
      writeFixtureFile(layout, "oci-layout", '{"imageLayoutVersion":"1.0.0"}\n');
      writeFixtureFile(layout, "index.json", `${JSON.stringify({
        schemaVersion: 2,
        manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest, size: 123 }],
      })}\n`);
      mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
      const tar = spawnSync("tar", ["-cf", path, "-C", layout, "index.json", "oci-layout", "blobs"], { encoding: "utf8" });
      assert.equal(tar.status, 0, tar.stderr);
      chmodSync(path, 0o600);
      rmSync(layout, { recursive: true, force: true });
      sha256 = sha256File(path);
    } else {
      const bytes = artifact.kind === "helm" ? "chart\n"
        : artifact.kind === "provenance" ? '{"predicateType":"https://slsa.dev/provenance/v1"}\n'
          : artifact.kind === "sbom" ? "{}\n"
            : `${artifact.kind}:${artifact.name}\n`;
      writeFixtureFile(root, artifact.path, bytes);
      sha256 = sha256File(path);
    }
    return { ...artifact, sha256 };
  });
  rmSync(scratch, { recursive: true, force: false });
  const manifest = createReleaseManifest({
    releaseSet: SET,
    sourceCommit: COMMIT,
    units: units.map(({ id, version }) => ({ id, version })),
    artifacts,
  });
  writeFixtureFile(root, "release-manifest.json", canonicalManifestText(manifest));
  writeFixtureFile(root, "SHA256SUMS", [...manifest.artifacts]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    .map(({ path, sha256 }) => `${sha256}  ${path}\n`).join(""));
  return { digest, root };
}
