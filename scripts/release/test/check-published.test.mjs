import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  checkDraftReleasePublication,
  checkReleasePublication,
  collectReleaseEvidence,
  createUnitCheckPlan,
  evaluateUnitState,
  parseImageInspection,
  parseOciLayoutIndex,
  parsePublicationReceipt,
  parseReleaseAssets,
  probeRemoteDestination,
  parseProbeObservation,
  runPublishedCli,
  githubReleaseAssetCatalog,
  unitDestinations,
  unitReleaseAssets,
  unitReleaseManifest,
  writePublicationReceipt,
} from "../check-published.mjs";
import { RELEASE_ARTIFACTS } from "../release-model.mjs";
import { unitById, unitTag } from "../units.mjs";
import {
  COMMIT,
  SET,
  VERSION,
  composerSourceFiles,
  packageFixtureTree,
  releaseFixture,
  rewriteManifest,
  writeFixtureFile,
} from "./release-fixture.mjs";

const WRONG_COMMIT = "f".repeat(40);
const GAUNTLET_ONLY = Object.freeze([{ id: "gauntlet", version: VERSION }]);
const CHECK_PUBLISHED = resolve(import.meta.dirname, "../check-published.mjs");

function tagOf(unit, version = VERSION) {
  return unitTag(unitById(unit), version);
}

function unitEvidence(unit, version = VERSION) {
  const ids = [...unitDestinations(unit).map(({ id, kind }) => [id, kind]), [`github:${tagOf(unit, version)}`, "release"]];
  return Object.fromEntries(ids.map(([id, kind], index) => {
    if (kind === "npm") return [id, `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`];
    if (kind === "image") return [id, `sha256:${String(index + 1).padStart(64, "0")}`];
    if (kind === "composer") return [id, String(index + 1).padStart(40, "0")];
    return [id, String(index + 1).padStart(64, "0")];
  }));
}

function unitPlan(unit, evidence = unitEvidence(unit)) {
  return createUnitCheckPlan({ unit, version: VERSION, sourceCommit: COMMIT, evidence });
}

function collectedEvidence(units) {
  return {
    releaseSet: SET,
    units: units.map((id) => ({ id, version: VERSION, tag: tagOf(id), evidence: unitEvidence(id) })),
  };
}

function assetNames(unit) {
  return githubReleaseAssetCatalog(unit, VERSION).map(({ name }) => name);
}

function readManifest(root) {
  return JSON.parse(readFileSync(resolve(root, "release-manifest.json"), "utf8"));
}

function replaceComposerArchiveCommit(root, artifactName, commit) {
  const artifact = RELEASE_ARTIFACTS.composer.find(({ name }) => name === artifactName);
  assert.notEqual(artifact, undefined);
  const expectedPrefix = `${artifact.repository.split("/").at(-1)}-${VERSION}`;
  const archivePath = resolve(root, `composer/artifacts/${expectedPrefix}.tar.gz`);
  const scratch = resolve(root, "..", "wrong-composer-provenance");
  mkdirSync(scratch, { mode: 0o700 });
  rmSync(archivePath);
  const sha256 = packageFixtureTree(scratch, archivePath, expectedPrefix, composerSourceFiles(artifact, VERSION, commit));
  rmSync(scratch, { recursive: true, force: false });
  rewriteManifest(root, (manifest) => {
    const record = manifest.artifacts.find(({ kind, name }) => kind === "composer" && name === artifact.name);
    assert.notEqual(record, undefined);
    record.sha256 = sha256;
  });
}

function withTemporaryDirectory(root, callback) {
  const temporaryDirectory = resolve(root, "..", "consumer-tmp");
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  chmodSync(temporaryDirectory, 0o700);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporaryDirectory;
  return Promise.resolve()
    .then(() => callback(temporaryDirectory))
    .finally(() => {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    });
}

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFetch(fetch, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test("derives registry-comparable evidence from every staged release unit", async (t) => {
  const fixture = releaseFixture(t);
  assert.equal(existsSync(resolve(fixture.root, "composer/repositories")), false);
  assert.equal(existsSync(resolve(fixture.root, "maven/repository")), false);
  const collected = await collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT });
  assert.equal(collected.releaseSet, SET);
  assert.equal(Object.isFrozen(collected), true);
  assert.equal(collected.units.length, 13);
  for (const { id, version, tag, evidence } of collected.units) {
    assert.equal(version, VERSION);
    assert.equal(tag, tagOf(id));
    assert.deepEqual(Object.keys(evidence), [...unitDestinations(id).map(({ id: check }) => check), `github:${tag}`]);
    assert.match(evidence[`github:${tag}`], /^[0-9a-f]{64}$/u);
    assert.notEqual(evidence[`github:${tag}`], COMMIT);
  }
  const byId = Object.fromEntries(collected.units.map(({ id, evidence }) => [id, evidence]));
  assert.equal(byId.gauntlet["image:semantic"], fixture.digest);
  assert.equal(byId.gauntlet["image:commit"], fixture.digest);
  assert.equal(byId.gauntlet["chart:semantic"], createHash("sha256").update("chart\n").digest("hex"));
  assert.match(byId.protocol["npm:protocol"], /^sha512-/u);
  assert.match(byId["java-core"]["maven:core"], /^[0-9a-f]{64}$/u);
  assert.match(byId["php-core"]["composer:php-core"], /^[0-9a-f]{40}$/u);
  assert.notEqual(byId["php-core"]["composer:php-core"], byId["symfony-bundle"]["composer:symfony-bundle"]);
  assert.equal(new Set(collected.units.map(({ id, tag }) => collected.units.find((unit) => unit.id === id).evidence[`github:${tag}`])).size, 13);
});

test("the expected image digest cross-check treats an empty value as unset and fails closed on a difference", async (t) => {
  const fixture = releaseFixture(t, GAUNTLET_ONLY);
  for (const value of [fixture.digest, ""]) {
    const collected = await withEnvironment({ GAUNTLET_EXPECTED_IMAGE_DIGEST: value }, () => collectReleaseEvidence({
      releaseDirectory: fixture.root,
      sourceCommit: COMMIT,
    }));
    assert.equal(collected.units[0].evidence["image:semantic"], fixture.digest);
    assert.equal(collected.units[0].evidence["image:commit"], fixture.digest);
  }
  for (const value of [`sha256:${"c".repeat(64)}`, "sha256:short"]) {
    await withEnvironment({ GAUNTLET_EXPECTED_IMAGE_DIGEST: value }, () => assert.rejects(
      collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }),
      /failed closed/u,
    ));
  }
  await withEnvironment({ GAUNTLET_EXPECTED_CHART_DIGEST: "" }, async () => {
    const collected = await collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT });
    assert.match(collected.units[0].evidence["github:v0.1.0"], /^[0-9a-f]{64}$/u);
  });

  writeFileSync(resolve(fixture.root, `image/gauntlet-${VERSION}.provenance.json`), "tampered\n");
  await assert.rejects(collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }), /failed closed/u);
});

test("release evidence materializes archive consumers into owned temporary trees and removes them", async (t) => {
  const fixture = releaseFixture(t, [{ id: "php-core", version: VERSION }, { id: "java-core", version: "0.2.0" }]);
  await withTemporaryDirectory(fixture.root, async (temporaryDirectory) => {
    const collected = await collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT });
    assert.deepEqual(collected.units.map(({ id, version, tag }) => [id, version, tag]), [
      ["php-core", VERSION, "php-core-v0.1.0"],
      ["java-core", "0.2.0", "java-core-v0.2.0"],
    ]);
    assert.match(collected.units[0].evidence["composer:php-core"], /^[0-9a-f]{40}$/u);
    assert.equal(
      collected.units[1].evidence["maven:core"],
      createHash("sha256").update("jar:dev.eightlines.gauntlet:core\n").digest("hex"),
    );
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  });
});

test("release evidence rejects a rehashed non-canonical consumer archive", async (t) => {
  const fixture = releaseFixture(t, [{ id: "java-core", version: VERSION }]);
  const archivePath = resolve(fixture.root, `maven/artifacts/gauntlet-core-${VERSION}.tar.gz`);
  writeFileSync(archivePath, "not a canonical tree archive\n", { mode: 0o600 });
  rewriteManifest(fixture.root, (manifest) => {
    manifest.artifacts[0].sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  });
  await withTemporaryDirectory(fixture.root, async (temporaryDirectory) => {
    await assert.rejects(collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }), /failed closed/u);
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  });
});

test("release evidence rejects a rehashed Composer archive for a different source commit", async (t) => {
  const fixture = releaseFixture(t, [{ id: "php-core", version: VERSION }, { id: "symfony-bundle", version: VERSION }]);
  replaceComposerArchiveCommit(fixture.root, "8lines/gauntlet-symfony-bundle", WRONG_COMMIT);
  await assert.rejects(collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }), /failed closed/u);
});

test("rejects missing, unknown, foreign or legacy-path staged artifacts before probing", async (t) => {
  const units = [{ id: "gauntlet", version: VERSION }, { id: "skills", version: VERSION }];
  const mutations = [
    { name: "missing", apply(manifest) { manifest.artifacts.pop(); } },
    {
      name: "unknown",
      apply(manifest) {
        const record = manifest.artifacts.find(({ kind }) => kind === "skills");
        record.name = "8lines/not-in-the-release-catalog";
      },
    },
    {
      name: "artifact of another unit",
      apply(manifest) { manifest.artifacts.find(({ kind }) => kind === "skills").unit = "gauntlet"; },
    },
    {
      name: "legacy single SBOM",
      apply(manifest, root) {
        const artifact = manifest.artifacts.find(({ kind, name }) => kind === "sbom" && name.endsWith("@linux/amd64"));
        const bytes = readFileSync(resolve(root, artifact.path));
        artifact.path = "sbom/gauntlet.spdx.json";
        writeFixtureFile(root, artifact.path, bytes);
      },
    },
    {
      name: "unit version without its artifacts",
      apply(manifest) { manifest.units[1].version = "0.1.1"; delete manifest.units[1].tag; },
    },
  ];
  for (const mutation of mutations) {
    await t.test(mutation.name, async (t) => {
      const fixture = releaseFixture(t, units);
      rewriteManifest(fixture.root, (manifest) => mutation.apply(manifest, fixture.root));
      await assert.rejects(collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }), /failed closed/u);
    });
  }
  await t.test("duplicate manifest field", async (t) => {
    const fixture = releaseFixture(t, units);
    const manifestPath = resolve(fixture.root, "release-manifest.json");
    const source = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, source.replace('"schemaVersion": 2,', '"schemaVersion": 2,\n  "schemaVersion": 2,'));
    await assert.rejects(collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }), /failed closed/u);
  });
  await t.test("non-canonical manifest bytes", async (t) => {
    const fixture = releaseFixture(t, units);
    const manifestPath = resolve(fixture.root, "release-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8")))}\n`);
    await assert.rejects(collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }), /failed closed/u);
  });
  await t.test("different source commit", async (t) => {
    const fixture = releaseFixture(t, units);
    await assert.rejects(collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: WRONG_COMMIT }), /failed closed/u);
  });
  await t.test("release directory named after another release set", async (t) => {
    const fixture = releaseFixture(t, units);
    const moved = resolve(fixture.root, "..", "release-2026-10-03.2");
    renameSync(fixture.root, moved);
    await assert.rejects(collectReleaseEvidence({ releaseDirectory: moved, sourceCommit: COMMIT }), /failed closed/u);
  });
});

test("derives finalized GitHub Release evidence from the exact local unit receipt and checksums", async (t) => {
  const fixture = releaseFixture(t, [{ id: "gauntlet", version: VERSION }, { id: "skills", version: VERSION }]);
  const before = await collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT });
  writePublicationReceipt({ releaseDirectory: fixture.root, unit: "skills", imageDigest: null, chartDigest: null });
  writePublicationReceipt({
    releaseDirectory: fixture.root,
    unit: "gauntlet",
    imageDigest: fixture.digest,
    chartDigest: `sha256:${"b".repeat(64)}`,
  });
  const after = await collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT });
  // The predicted skills receipt equals the finalized one; the gauntlet chart digest comes from the push.
  assert.equal(after.units[1].evidence["github:skills-v0.1.0"], before.units[1].evidence["github:skills-v0.1.0"]);
  assert.notEqual(after.units[0].evidence["github:v0.1.0"], before.units[0].evidence["github:v0.1.0"]);

  for (const path of ["units/gauntlet/SHA256SUMS", "units/gauntlet/release-manifest.json"]) {
    await t.test(`tampered ${path}`, async () => {
      const original = readFileSync(resolve(fixture.root, path));
      writeFileSync(resolve(fixture.root, path), "tampered under the same name\n");
      try {
        await assert.rejects(collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }), /failed closed/u);
      } finally {
        writeFileSync(resolve(fixture.root, path), original);
      }
    });
  }
  await withEnvironment({ GAUNTLET_EXPECTED_CHART_DIGEST: `sha256:${"c".repeat(64)}` }, () => assert.rejects(
    collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }),
    /failed closed/u,
  ));
  await withEnvironment({ GAUNTLET_EXPECTED_CHART_DIGEST: `sha256:${"b".repeat(64)}` }, async () => {
    const collected = await collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT });
    assert.equal(collected.units[0].evidence["github:v0.1.0"], after.units[0].evidence["github:v0.1.0"]);
  });
});

test("parses only an exact OCI index descriptor and a single registry digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(parseOciLayoutIndex(`${JSON.stringify({
    schemaVersion: 2,
    manifests: [{
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest,
      size: 123,
    }],
  })}\n`), digest);
  assert.equal(parseImageInspection(`Name: ghcr.io/8lines/gauntlet:0.1.0\nMediaType: application/vnd.oci.image.index.v1+json\nDigest: ${digest}\n`), digest);
  for (const malformed of [
    "{}\n",
    `${JSON.stringify({ schemaVersion: 2, manifests: [] })}\n`,
    `${JSON.stringify({ schemaVersion: 2, manifests: [{ digest }, { digest }] })}\n`,
  ]) assert.throws(() => parseOciLayoutIndex(malformed), /OCI layout evidence failed closed/u);
  assert.throws(() => parseImageInspection(`Digest: ${digest}\nDigest: ${digest}\n`), /image inspection failed closed/u);
});

test("accepts only a unit receipt bound to the exact unit manifest, release set and source", () => {
  const manifestSha256 = "d".repeat(64);
  const expected = { releaseSet: SET, unit: "skills", version: VERSION, sourceCommit: COMMIT, manifestSha256 };
  const receipt = { schemaVersion: 2, releaseSet: SET, unit: "skills", version: VERSION, sourceCommit: COMMIT, manifestSha256 };
  const canonical = `${JSON.stringify(receipt, null, 2)}\n`;
  assert.deepEqual(parsePublicationReceipt(canonical, expected), receipt);
  const gauntlet = {
    ...receipt,
    unit: "gauntlet",
    imageDigest: `sha256:${"a".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
  };
  assert.deepEqual(parsePublicationReceipt(`${JSON.stringify(gauntlet, null, 2)}\n`, { ...expected, unit: "gauntlet" }), gauntlet);
  for (const [invalid, expectation] of [
    [{ ...receipt, sourceCommit: WRONG_COMMIT }, expected],
    [{ ...receipt, manifestSha256: "e".repeat(64) }, expected],
    [{ ...receipt, releaseSet: "release-2026-10-03.2" }, expected],
    [{ ...receipt, unit: "protocol" }, expected],
    [{ ...receipt, version: "0.1.1" }, expected],
    [{ ...receipt, schemaVersion: 1 }, expected],
    [{ ...receipt, extra: true }, expected],
    [{ ...receipt, imageDigest: gauntlet.imageDigest, chartDigest: gauntlet.chartDigest }, expected],
    [receipt, { ...expected, unit: "gauntlet" }],
    [{ ...gauntlet, chartDigest: "sha256:short" }, { ...expected, unit: "gauntlet" }],
    [{ ...gauntlet, imageDigest: null }, { ...expected, unit: "gauntlet" }],
  ]) {
    assert.throws(
      () => parsePublicationReceipt(`${JSON.stringify(invalid, null, 2)}\n`, expectation),
      /publication receipt failed closed/u,
    );
  }
  assert.throws(
    () => parsePublicationReceipt(canonical.replace('"schemaVersion": 2,', '"schemaVersion": 2,\n  "schemaVersion": 2,'), expected),
    /publication receipt failed closed/u,
  );
  assert.throws(() => parsePublicationReceipt(`${JSON.stringify(receipt)}\n`, expected), /publication receipt failed closed/u);
  assert.throws(() => parsePublicationReceipt(canonical, { ...expected, extra: true }), /publication receipt failed closed/u);
});

test("accepts only the complete per-unit GitHub Release asset catalog", () => {
  const names = assetNames("gauntlet");
  assert.equal(names.length, 8);
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const parsed = parseReleaseAssets(assets, "gauntlet", VERSION);
  assert.deepEqual(Object.keys(parsed), names);
  assert.equal(parsed["publication-receipt.json"], 7);
  assert.throws(() => parseReleaseAssets(assets.slice(1), "gauntlet", VERSION), /Release assets failed closed/u);
  assert.throws(
    () => parseReleaseAssets(assets.filter(({ name }) => name !== `gauntlet-compose-${VERSION}.tar.gz`), "gauntlet", VERSION),
    /Release assets failed closed/u,
  );
  assert.throws(
    () => parseReleaseAssets([...assets, { id: 99, name: `gauntlet-${VERSION}.oci.tar` }], "gauntlet", VERSION),
    /Release assets failed closed/u,
  );
  assert.throws(() => parseReleaseAssets([...assets.slice(0, -1), assets[0]], "gauntlet", VERSION), /Release assets failed closed/u);
  assert.throws(() => parseReleaseAssets(assets, "skills", VERSION), /Release assets failed closed/u);
  assert.throws(() => parseReleaseAssets(assets, "gauntlet", "0.1.1"), /Release assets failed closed/u);
  const skills = assetNames("skills").map((name, index) => ({ id: index + 1, name }));
  assert.deepEqual(Object.keys(parseReleaseAssets(skills, "skills", VERSION)), assetNames("skills"));
});

function responseJson(value, status = 200) {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubReleaseFetch({
  tag = "v0.1.0",
  assets,
  bytesByName,
  immutable,
  releaseAbsent = false,
  draft = false,
  redirectHost = "objects.githubusercontent.com",
  oversizedName,
}) {
  const calls = [];
  const byId = new Map(assets.map(({ id, name }) => [id, name]));
  const release = () => ({
    tag_name: tag, draft, prerelease: false, immutable: typeof immutable === "function" ? immutable() : immutable, assets,
  });
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, options });
    if (url.origin === "https://api.github.com" && url.pathname === "/repos/8lines/gauntlet") {
      return responseJson({ id: 1, private: true });
    }
    const byTag = /^\/repos\/8lines\/gauntlet\/releases\/tags\/([^/]+)$/u.exec(url.pathname);
    if (url.origin === "https://api.github.com" && byTag !== null) {
      if (byTag[1] !== tag || releaseAbsent || draft) return new Response(null, { status: 404 });
      return responseJson(release());
    }
    if (url.origin === "https://api.github.com" && url.pathname === "/repos/8lines/gauntlet/releases") {
      return responseJson(draft ? [{ tag_name: "v9.9.9", draft: true }, release()] : []);
    }
    if (url.origin === "https://api.github.com" && url.pathname === `/repos/8lines/gauntlet/git/ref/tags/${tag}`) {
      return responseJson({ object: { type: "commit", sha: COMMIT } });
    }
    const assetMatch = /^\/repos\/8lines\/gauntlet\/releases\/assets\/([1-9][0-9]*)$/u.exec(url.pathname);
    if (url.origin === "https://api.github.com" && assetMatch !== null) {
      assert.equal(options.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: `https://${redirectHost}/gauntlet-release/${assetMatch[1]}` },
      });
    }
    const downloadMatch = /^\/gauntlet-release\/([1-9][0-9]*)$/u.exec(url.pathname);
    if (url.hostname === redirectHost && downloadMatch !== null) {
      const name = byId.get(Number(downloadMatch[1]));
      const bytes = bytesByName.get(name);
      assert.notEqual(bytes, undefined);
      return new Response(bytes, {
        status: 200,
        headers: { "content-length": name === oversizedName ? "9999999999" : String(bytes.length) },
      });
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  };
  return { calls, fetch };
}

function canonicalReceiptBytes(root, unit, digests = {}) {
  const manifest = readManifest(root);
  const unitManifest = Buffer.from(`${JSON.stringify(unitReleaseManifest(manifest, unit), null, 2)}\n`);
  const entry = manifest.units.find(({ id }) => id === unit);
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    releaseSet: manifest.releaseSet,
    unit,
    version: entry.version,
    sourceCommit: manifest.sourceCommit,
    manifestSha256: createHash("sha256").update(unitManifest).digest("hex"),
    ...digests,
  }, null, 2)}\n`);
}

function remoteAssets(unit, label) {
  const names = assetNames(unit);
  return {
    names,
    assets: names.map((name, index) => ({ id: index + 1, name })),
    bytesByName: new Map(names.map((name) => [name, Buffer.from(`${label}:${name}\n`)])),
  };
}

const REMOTE = Object.freeze({ GH_TOKEN: "test-token-for-release-assets", GAUNTLET_USE_REMOTE_RECEIPT: "true" });

test("uses a canonical remote unit receipt only as the missing-local rerun fallback", async (t) => {
  const fixture = releaseFixture(t, GAUNTLET_ONLY);
  const { assets, bytesByName } = remoteAssets("gauntlet", "exact");
  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, "gauntlet", {
    imageDigest: fixture.digest,
    chartDigest: `sha256:${"b".repeat(64)}`,
  }));
  const remote = githubReleaseFetch({ assets, bytesByName, immutable: true });
  const collected = await withEnvironment(REMOTE, () => withFetch(remote.fetch, () => collectReleaseEvidence({
    releaseDirectory: fixture.root,
    sourceCommit: COMMIT,
  })));
  assert.equal(collected.units[0].evidence["image:semantic"], fixture.digest);
  assert.match(collected.units[0].evidence["github:v0.1.0"], /^[0-9a-f]{64}$/u);
  assert.equal(remote.calls.filter(({ url }) => url.includes("/releases/assets/")).length, 1);
  assert.equal(remote.calls.some(({ url }) => url.endsWith("/releases/tags/v0.1.0")), true);

  const predicted = await collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT });
  assert.notEqual(predicted.units[0].evidence["github:v0.1.0"], collected.units[0].evidence["github:v0.1.0"]);
});

test("a remote receipt is looked up under each unit's own tag", async (t) => {
  const fixture = releaseFixture(t, [{ id: "gauntlet", version: VERSION }, { id: "skills", version: VERSION }]);
  const { assets, bytesByName } = remoteAssets("skills", "exact");
  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, "skills"));
  const remote = githubReleaseFetch({ tag: "skills-v0.1.0", assets, bytesByName, immutable: true });
  const collected = await withEnvironment(REMOTE, () => withFetch(remote.fetch, () => collectReleaseEvidence({
    releaseDirectory: fixture.root,
    sourceCommit: COMMIT,
  })));
  assert.deepEqual(collected.units.map(({ id }) => id), ["gauntlet", "skills"]);
  assert.deepEqual(
    remote.calls.map(({ url }) => new URL(url).pathname).filter((path) => path.includes("/releases/tags/")).sort(),
    ["/repos/8lines/gauntlet/releases/tags/skills-v0.1.0", "/repos/8lines/gauntlet/releases/tags/v0.1.0"],
  );

  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, "gauntlet", {
    imageDigest: fixture.digest,
    chartDigest: fixture.digest,
  }));
  const foreign = githubReleaseFetch({ tag: "skills-v0.1.0", assets, bytesByName, immutable: true });
  await withEnvironment(REMOTE, () => withFetch(foreign.fetch, () => assert.rejects(
    collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }),
    /failed closed/u,
  )));
});

test("rejects a coordinated remote receipt and image replacement even when the release is immutable", async (t) => {
  const fixture = releaseFixture(t, GAUNTLET_ONLY);
  const { assets, bytesByName } = remoteAssets("gauntlet", "replacement");
  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, "gauntlet", {
    imageDigest: `sha256:${"c".repeat(64)}`,
    chartDigest: `sha256:${"d".repeat(64)}`,
  }));
  const remote = githubReleaseFetch({ assets, bytesByName, immutable: true });
  await withEnvironment(REMOTE, () => withFetch(remote.fetch, () => assert.rejects(
    collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }),
    /failed closed/u,
  )));
});

test("rejects a remote receipt from a mutable public release or one with a foreign asset list", async (t) => {
  const fixture = releaseFixture(t, GAUNTLET_ONLY);
  const { assets, bytesByName } = remoteAssets("gauntlet", "exact");
  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, "gauntlet", {
    imageDigest: fixture.digest,
    chartDigest: `sha256:${"b".repeat(64)}`,
  }));
  const mutable = githubReleaseFetch({ assets, bytesByName, immutable: false });
  await withEnvironment(REMOTE, () => withFetch(mutable.fetch, () => assert.rejects(
    collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }),
    /failed closed/u,
  )));
  const foreignAssets = githubReleaseFetch({ assets: assets.slice(1), bytesByName, immutable: true });
  await withEnvironment(REMOTE, () => withFetch(foreignAssets.fetch, () => assert.rejects(
    collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }),
    /failed closed/u,
  )));
});

test("post-finalize evidence binds remote receipt bytes and the published chart digest to local bytes", async (t) => {
  const fixture = releaseFixture(t, GAUNTLET_ONLY);
  writePublicationReceipt({
    releaseDirectory: fixture.root,
    unit: "gauntlet",
    imageDigest: fixture.digest,
    chartDigest: `sha256:${"b".repeat(64)}`,
  });
  const { assets, bytesByName } = remoteAssets("gauntlet", "exact");
  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, "gauntlet", {
    imageDigest: fixture.digest,
    chartDigest: `sha256:${"c".repeat(64)}`,
  }));
  const remote = githubReleaseFetch({ assets, bytesByName, immutable: true });
  await withEnvironment(REMOTE, () => withFetch(remote.fetch, () => assert.rejects(
    collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }),
    /failed closed/u,
  )));
  await withEnvironment({ GAUNTLET_EXPECTED_CHART_DIGEST: `sha256:${"c".repeat(64)}` }, () => assert.rejects(
    collectReleaseEvidence({ releaseDirectory: fixture.root, sourceCommit: COMMIT }),
    /failed closed/u,
  ));
  bytesByName.set("publication-receipt.json", readFileSync(resolve(fixture.root, "units/gauntlet/publication-receipt.json")));
  const identical = githubReleaseFetch({ assets, bytesByName, immutable: true });
  const collected = await withEnvironment(REMOTE, () => withFetch(identical.fetch, () => collectReleaseEvidence({
    releaseDirectory: fixture.root,
    sourceCommit: COMMIT,
  })));
  assert.match(collected.units[0].evidence["github:v0.1.0"], /^[0-9a-f]{64}$/u);
});

test("a rerun verifies an already-released application through its remote receipt next to a clean unit", async (t) => {
  const fixture = releaseFixture(t, [{ id: "gauntlet", version: VERSION }, { id: "skills", version: VERSION }]);
  // helm push reports an OCI manifest digest, which is not the sha256 of the chart archive.
  const ociChartDigest = `sha256:${"b".repeat(64)}`;
  const { assets, bytesByName } = remoteAssets("gauntlet", "published");
  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, "gauntlet", {
    imageDigest: fixture.digest,
    chartDigest: ociChartDigest,
  }));
  const remote = githubReleaseFetch({ assets, bytesByName, immutable: true });
  const published = await withEnvironment(REMOTE, () => withFetch(remote.fetch, () => collectReleaseEvidence({
    releaseDirectory: fixture.root,
    sourceCommit: COMMIT,
  })));
  const publishedGauntlet = published.units.find(({ id }) => id === "gauntlet").evidence;
  const probe = async (check) => check.unit === "gauntlet"
    ? { id: check.id, state: "present", evidence: publishedGauntlet[check.id] }
    : { id: check.id, state: "absent" };
  const options = { releaseDirectory: fixture.root, sourceCommit: COMMIT, requireIdentical: true, unit: null };
  const dependencies = { collectEvidence: collectReleaseEvidence, probe, sleep: async () => {} };

  const converged = await withEnvironment({ ...REMOTE, GAUNTLET_EXPECTED_IMAGE_DIGEST: "", GAUNTLET_EXPECTED_CHART_DIGEST: "" },
    () => withFetch(remote.fetch, () => checkReleasePublication(options, dependencies)));
  assert.deepEqual(converged.units.map(({ id, state }) => [id, state]), [
    ["gauntlet", "already-identical"],
    ["skills", "published-artifacts-identical"],
  ]);

  // Without the remote receipt the predicted receipt names the chart archive digest and never matches.
  await withEnvironment({ GAUNTLET_USE_REMOTE_RECEIPT: undefined }, () => assert.rejects(
    checkReleasePublication(options, dependencies),
    /invalid GitHub Release state/u,
  ));
});

test("post-publication verification waits a bounded time for GitHub to report a release immutable", async (t) => {
  const fixture = releaseFixture(t, GAUNTLET_ONLY);
  const { assets, bytesByName } = remoteAssets("gauntlet", "published");
  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, "gauntlet", {
    imageDigest: fixture.digest,
    chartDigest: `sha256:${"b".repeat(64)}`,
  }));
  const settled = githubReleaseFetch({ assets, bytesByName, immutable: true });
  const published = await withEnvironment(REMOTE, () => withFetch(settled.fetch, () => collectReleaseEvidence({
    releaseDirectory: fixture.root,
    sourceCommit: COMMIT,
  })));
  const probe = async (check) => ({ id: check.id, state: "present", evidence: published.units[0].evidence[check.id] });
  const options = { releaseDirectory: fixture.root, sourceCommit: COMMIT, requireIdentical: true, unit: null };

  let reads = 0;
  const sleeps = [];
  const lagging = githubReleaseFetch({ assets, bytesByName, immutable: () => ++reads > 2 });
  const result = await withEnvironment(REMOTE, () => withFetch(lagging.fetch, () => checkReleasePublication(options, {
    collectEvidence: collectReleaseEvidence,
    probe,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  })));
  assert.deepEqual(result.units.map(({ state }) => state), ["already-identical"]);
  assert.deepEqual(sleeps, [5_000, 5_000]);

  const neverSleeps = [];
  const mutable = githubReleaseFetch({ assets, bytesByName, immutable: false });
  await withEnvironment(REMOTE, () => withFetch(mutable.fetch, () => assert.rejects(checkReleasePublication(options, {
    collectEvidence: collectReleaseEvidence,
    probe,
    sleep: async (milliseconds) => { neverSleeps.push(milliseconds); },
  }), /failed closed/u)));
  assert.equal(neverSleeps.length, 12);

  const preflightSleeps = [];
  await withEnvironment(REMOTE, () => withFetch(mutable.fetch, () => assert.rejects(checkReleasePublication(
    { ...options, requireIdentical: false },
    { collectEvidence: collectReleaseEvidence, probe, sleep: async (milliseconds) => { preflightSleeps.push(milliseconds); } },
  ), /failed closed/u)));
  assert.deepEqual(preflightSleeps, []);
});

function finalizedDraftAssets(root, unit) {
  const assets = unitReleaseAssets(readManifest(root), unit);
  return {
    assets: assets.map(({ name }, index) => ({ id: index + 1, name })),
    bytesByName: new Map(assets.map(({ name, path }) => [name, readFileSync(resolve(root, path))])),
  };
}

test("draft verification compares every uploaded unit asset to the local finalized unit", async (t) => {
  const fixture = releaseFixture(t, [{ id: "gauntlet", version: VERSION }, { id: "skills", version: VERSION }]);
  await assert.rejects(checkDraftReleasePublication({ releaseDirectory: fixture.root, sourceCommit: COMMIT, unit: "skills" }), /failed closed/u);
  writePublicationReceipt({ releaseDirectory: fixture.root, unit: "gauntlet", imageDigest: fixture.digest, chartDigest: `sha256:${"b".repeat(64)}` });
  writePublicationReceipt({ releaseDirectory: fixture.root, unit: "skills", imageDigest: null, chartDigest: null });
  await withEnvironment({ GH_TOKEN: REMOTE.GH_TOKEN }, async () => {
    for (const [unit, tag] of [["gauntlet", "v0.1.0"], ["skills", "skills-v0.1.0"]]) {
      const { assets, bytesByName } = finalizedDraftAssets(fixture.root, unit);
      const exact = githubReleaseFetch({ tag, assets, bytesByName, draft: true, immutable: false });
      assert.equal(await withFetch(exact.fetch, () => checkDraftReleasePublication({
        releaseDirectory: fixture.root,
        sourceCommit: COMMIT,
        unit,
      })), "draft-identical");
      assert.equal(exact.calls.filter(({ url }) => url.startsWith("https://objects.githubusercontent.com/")).length, assets.length);

      bytesByName.set(assets[0].name, Buffer.from("tampered draft upload\n"));
      const tampered = githubReleaseFetch({ tag, assets, bytesByName, draft: true, immutable: false });
      await withFetch(tampered.fetch, () => assert.rejects(checkDraftReleasePublication({
        releaseDirectory: fixture.root,
        sourceCommit: COMMIT,
        unit,
      }), /failed closed/u));
    }
    const { assets, bytesByName } = finalizedDraftAssets(fixture.root, "skills");
    const wrongTag = githubReleaseFetch({ tag: "v0.1.0", assets, bytesByName, draft: true, immutable: false });
    await withFetch(wrongTag.fetch, () => assert.rejects(checkDraftReleasePublication({
      releaseDirectory: fixture.root,
      sourceCommit: COMMIT,
      unit: "skills",
    }), /failed closed/u));
  });
  await assert.rejects(checkDraftReleasePublication({ releaseDirectory: fixture.root, sourceCommit: COMMIT, unit: "protocol" }), /failed closed/u);
});

test("GitHub Release probing hashes every exact unit asset byte and rejects same-name tampering", async () => {
  const { assets, bytesByName } = remoteAssets("gauntlet", "exact");
  await withEnvironment({ GH_TOKEN: REMOTE.GH_TOKEN }, async () => {
    const firstRemote = githubReleaseFetch({ assets, bytesByName, immutable: true });
    const seedRelease = unitPlan("gauntlet").find(({ kind }) => kind === "release");
    const original = await withFetch(firstRemote.fetch, () => probeRemoteDestination(seedRelease));
    assert.match(original.evidence, /^[0-9a-f]{64}$/u);
    assert.equal(firstRemote.calls.filter(({ url }) => url.includes("/releases/assets/")).length, 8);
    assert.equal(firstRemote.calls.some(({ url }) => url.endsWith("/git/ref/tags/v0.1.0")), true);
    const downloads = firstRemote.calls.filter(({ url }) => url.startsWith("https://objects.githubusercontent.com/"));
    assert.equal(downloads.length, 8);
    assert.equal(downloads.every(({ options }) => options.headers.Authorization === undefined), true);

    const matchingPlan = unitPlan("gauntlet", { ...unitEvidence("gauntlet"), "github:v0.1.0": original.evidence });
    bytesByName.set(`gauntlet-compose-${VERSION}.tar.gz`, Buffer.from("tampered under the same name\n"));
    const secondRemote = githubReleaseFetch({ assets, bytesByName, immutable: true });
    const tampered = await withFetch(secondRemote.fetch, () => probeRemoteDestination(matchingPlan.at(-1)));
    assert.notEqual(tampered.evidence, original.evidence);
    const observations = matchingPlan.map(({ id, expectedEvidence }) => id === "github:v0.1.0"
      ? tampered
      : { id, state: "present", evidence: expectedEvidence });
    assert.throws(() => evaluateUnitState(matchingPlan, observations), /different evidence/u);

    const skills = remoteAssets("skills", "exact");
    const skillsRemote = githubReleaseFetch({ tag: "skills-v0.1.0", ...skills, immutable: true });
    const skillsRelease = await withFetch(skillsRemote.fetch, () => probeRemoteDestination(unitPlan("skills")[0]));
    assert.equal(skillsRelease.state, "present");
    assert.equal(skillsRemote.calls.filter(({ url }) => url.includes("/releases/assets/")).length, 4);
    const absent = await withFetch(skillsRemote.fetch, () => probeRemoteDestination(unitPlan("protocol").at(-1)));
    assert.deepEqual(absent, { id: "github:protocol-v0.1.0", state: "absent" });
  });
});

test("GitHub Release asset downloads reject untrusted redirects and declared oversize before reading bytes", async () => {
  const { names, assets, bytesByName } = remoteAssets("gauntlet", "exact");
  const releaseCheck = unitPlan("gauntlet").at(-1);
  await withEnvironment({ GH_TOKEN: REMOTE.GH_TOKEN }, async () => {
    const untrusted = githubReleaseFetch({ assets, bytesByName, immutable: true, redirectHost: "evil.invalid" });
    await withFetch(untrusted.fetch, () => assert.rejects(probeRemoteDestination(releaseCheck), /failed closed/u));
    assert.equal(untrusted.calls.some(({ url }) => url.startsWith("https://evil.invalid/")), false);

    const oversized = githubReleaseFetch({ assets, bytesByName, immutable: true, oversizedName: names[0] });
    await withFetch(oversized.fetch, () => assert.rejects(probeRemoteDestination(releaseCheck), /failed closed/u));

    const mutable = githubReleaseFetch({ assets, bytesByName, immutable: false });
    await withFetch(mutable.fetch, () => assert.rejects(probeRemoteDestination(releaseCheck), /failed closed/u));
  });
});

test("the concrete probe rejects an arbitrary or foreign check before any network call", async () => {
  const calls = [];
  await withFetch(async (input) => { calls.push(input); throw new Error("network"); }, async () => {
    const npm = unitPlan("protocol")[0];
    for (const check of [
      Object.freeze({ ...npm, destination: "https://example.invalid/foreign" }),
      Object.freeze({ ...npm, unit: "dashboard-client" }),
      Object.freeze({ ...npm, tag: "protocol-v0.1.1" }),
      Object.freeze({ ...npm, id: "npm:dashboard-client" }),
      Object.freeze({ ...npm, expectedEvidence: "f".repeat(64) }),
      Object.freeze({ ...unitPlan("skills")[0], destination: "https://github.com/8lines/gauntlet/releases/tag/v0.1.0" }),
      (({ tag, ...rest }) => Object.freeze(rest))(npm),
      Object.freeze({ ...npm, version: "v0.1.0" }),
    ]) await assert.rejects(probeRemoteDestination(check), /Remote probe check is invalid/u);
  });
  assert.deepEqual(calls, []);
});

test("chart probing preserves a replacement workspace instead of recursively deleting it", async (t) => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-chart-probe-test-")));
  chmodSync(root, 0o700);
  const bin = resolve(root, "bin");
  const temporaryDirectory = resolve(root, "tmp");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  const helm = resolve(bin, "helm");
  writeFileSync(helm, `#!/bin/sh
set -eu
destination=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--destination" ]; then destination="$2"; shift 2; else shift; fi
done
mv "$destination" "$destination-original"
mkdir -m 700 "$destination"
printf 'chart fixture\n' > "$destination/gauntlet-${VERSION}.tgz"
printf 'preserve\n' > "$destination/sentinel.txt"
`, { mode: 0o700 });
  chmodSync(helm, 0o700);
  const originalPath = process.env.PATH;
  const originalTemporaryDirectory = process.env.TMPDIR;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.TMPDIR = temporaryDirectory;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalTemporaryDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTemporaryDirectory;
    rmSync(root, { recursive: true, force: true });
  });
  const chart = unitPlan("gauntlet").find(({ id }) => id === "chart:semantic");

  await assert.rejects(probeRemoteDestination(chart), /cleanup failed closed/u);
  const sentinel = readdirSync(temporaryDirectory)
    .map((name) => resolve(temporaryDirectory, name, "sentinel.txt"))
    .find((path) => existsSync(path));
  assert.notEqual(sentinel, undefined);
  assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
});

test("release preflight derives evidence before probing and reports a state per unit", async () => {
  const calls = [];
  const proofs = collectedEvidence(["gauntlet", "protocol", "skills"]);
  const options = { releaseDirectory: "/safe/release-2026-10-03.1", sourceCommit: COMMIT };
  const dependencies = {
    async collectEvidence(received) {
      calls.push(["evidence", received]);
      return proofs;
    },
    async probe(check) {
      calls.push(["probe", check.id]);
      return { id: check.id, state: "present", evidence: check.expectedEvidence };
    },
  };
  const identical = await checkReleasePublication({ ...options, requireIdentical: true, unit: null }, dependencies);
  assert.deepEqual(calls[0], ["evidence", options]);
  assert.equal(calls.filter(([kind]) => kind === "probe").length, 7);
  assert.deepEqual(identical, {
    releaseSet: SET,
    units: [
      { id: "gauntlet", kind: "application", version: VERSION, tag: "v0.1.0", state: "already-identical" },
      { id: "protocol", kind: "npm", version: VERSION, tag: "protocol-v0.1.0", state: "already-identical" },
      { id: "skills", kind: "skills", version: VERSION, tag: "skills-v0.1.0", state: "already-identical" },
    ],
  });
  assert.equal(Object.isFrozen(identical), true);
  assert.equal(identical.units.every(Object.isFrozen), true);

  const mixed = await checkReleasePublication({ ...options, requireIdentical: true, unit: null }, {
    collectEvidence: async () => proofs,
    probe: async (check) => check.kind === "release" && check.unit !== "protocol"
      ? { id: check.id, state: "absent" }
      : { id: check.id, state: "present", evidence: check.expectedEvidence },
  });
  assert.deepEqual(mixed.units.map(({ id, state }) => [id, state]), [
    ["gauntlet", "published-artifacts-identical"],
    ["protocol", "already-identical"],
    ["skills", "published-artifacts-identical"],
  ]);

  const preflight = await checkReleasePublication({ ...options, requireIdentical: false, unit: null }, {
    collectEvidence: async () => proofs,
    probe: async (check) => check.unit === "protocol"
      ? { id: check.id, state: "present", evidence: check.expectedEvidence }
      : { id: check.id, state: "absent" },
  });
  assert.deepEqual(preflight.units.map(({ id, state }) => [id, state]), [
    ["gauntlet", "clean"], ["protocol", "already-identical"], ["skills", "clean"],
  ]);

  const probed = [];
  const one = await checkReleasePublication({ ...options, requireIdentical: false, unit: "protocol" }, {
    collectEvidence: async () => proofs,
    probe: async (check) => { probed.push(check.id); return { id: check.id, state: "absent" }; },
  });
  assert.deepEqual(one.units.map(({ id, state }) => [id, state]), [["protocol", "clean"]]);
  assert.deepEqual(probed, ["npm:protocol", "github:protocol-v0.1.0"]);

  await assert.rejects(checkReleasePublication({ ...options, requireIdentical: false, unit: null }, {
    collectEvidence: async () => proofs,
    probe: async (check) => check.id === "image:commit"
      ? { id: check.id, state: "present", evidence: check.expectedEvidence }
      : { id: check.id, state: "absent" },
  }), /Release unit gauntlet is partially published/u);

  await assert.rejects(checkReleasePublication({ ...options, requireIdentical: true, unit: null }, {
    collectEvidence: async () => collectedEvidence(["gauntlet", "protocol"]),
    probe: async ({ id }) => ({ id, state: "absent" }),
    sleep: async () => {},
  }), /required every destination to be identical/u);
});

test("release preflight rejects malformed options and collected evidence", async () => {
  const options = { releaseDirectory: "/safe/release-2026-10-03.1", sourceCommit: COMMIT, requireIdentical: false, unit: null };
  const probe = async ({ id }) => ({ id, state: "absent" });
  const proofs = collectedEvidence(["protocol", "skills"]);
  for (const invalid of [
    { ...options, version: VERSION },
    (({ unit, ...rest }) => rest)(options),
    { ...options, requireIdentical: "yes" },
    { ...options, unit: 7 },
    { ...options, releaseDirectory: "relative" },
    { ...options, sourceCommit: "abc" },
  ]) await assert.rejects(checkReleasePublication(invalid, { collectEvidence: async () => proofs, probe }), TypeError);
  for (const collected of [
    { ...proofs, units: [] },
    { ...proofs, releaseSet: "not-a-set" },
    { ...proofs, extra: true },
    { ...proofs, units: [proofs.units[0], proofs.units[0]] },
    { ...proofs, units: [{ ...proofs.units[0], tag: "protocol-v0.1.1" }] },
    { ...proofs, units: [{ ...proofs.units[0], evidence: {} }] },
  ]) await assert.rejects(checkReleasePublication(options, { collectEvidence: async () => collected, probe }), TypeError);
});

test("post-publication verification retries missing destinations and fails immediately on conflicting evidence", async () => {
  const proofs = collectedEvidence(["protocol", "skills"]);
  const options = { releaseDirectory: "/safe/release-2026-10-03.1", sourceCommit: COMMIT, requireIdentical: true, unit: null };
  let npmProbeCount = 0;
  let sleepCount = 0;
  const result = await checkReleasePublication(options, {
    collectEvidence: async () => proofs,
    probe: async (check) => {
      if (check.kind === "release") return { id: check.id, state: "absent" };
      if (check.kind === "npm" && npmProbeCount++ === 0) return { id: check.id, state: "absent" };
      return { id: check.id, state: "present", evidence: check.expectedEvidence };
    },
    sleep: async (milliseconds) => {
      assert.equal(milliseconds, 15_000);
      sleepCount += 1;
    },
  });
  assert.deepEqual(result.units.map(({ state }) => state), ["published-artifacts-identical", "published-artifacts-identical"]);
  assert.equal(sleepCount, 1);

  let slept = false;
  await assert.rejects(checkReleasePublication(options, {
    collectEvidence: async () => proofs,
    probe: async (check) => check.kind === "release"
      ? { id: check.id, state: "absent" }
      : { id: check.id, state: "present", evidence: `sha512-${"A".repeat(86)}==` },
    sleep: async () => { slept = true; },
  }), /different evidence/u);
  assert.equal(slept, false);

  await assert.rejects(checkReleasePublication(options, {
    collectEvidence: async () => proofs,
    probe: async (check) => check.kind === "release"
      ? { id: check.id, state: "present", evidence: "f".repeat(64) }
      : { id: check.id, state: "present", evidence: check.expectedEvidence },
    sleep: async () => {},
  }), /invalid GitHub Release state/u);
});

test("writes an atomic closed per-unit publication receipt without mutating the staged inventory", (t) => {
  const { root, digest } = releaseFixture(t, [{ id: "gauntlet", version: VERSION }, { id: "skills", version: VERSION }]);
  writeFixtureFile(root, "internal/not-distributed.txt", "internal\n");
  const manifestBefore = readFileSync(resolve(root, "release-manifest.json"));
  const sumsBefore = readFileSync(resolve(root, "SHA256SUMS"));
  const chartDigest = `sha256:${"b".repeat(64)}`;
  const result = writePublicationReceipt({ releaseDirectory: root, unit: "gauntlet", imageDigest: digest, chartDigest });
  assert.deepEqual(result, { unit: "gauntlet", files: 9 });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(readFileSync(resolve(root, "release-manifest.json")), manifestBefore);
  assert.deepEqual(readFileSync(resolve(root, "SHA256SUMS")), sumsBefore);
  assert.deepEqual(readdirSync(resolve(root, "units")), ["gauntlet"]);
  assert.deepEqual(readdirSync(resolve(root, "units/gauntlet")).sort(), ["SHA256SUMS", "publication-receipt.json", "release-manifest.json"]);
  const unitManifest = readFileSync(resolve(root, "units/gauntlet/release-manifest.json"));
  assert.deepEqual(JSON.parse(readFileSync(resolve(root, "units/gauntlet/publication-receipt.json"), "utf8")), {
    schemaVersion: 2,
    releaseSet: SET,
    unit: "gauntlet",
    version: VERSION,
    sourceCommit: COMMIT,
    manifestSha256: createHash("sha256").update(unitManifest).digest("hex"),
    imageDigest: digest,
    chartDigest,
  });
  const sums = readFileSync(resolve(root, "units/gauntlet/SHA256SUMS"), "utf8");
  assert.match(sums, /^[0-9a-f]{64}  helm\/gauntlet-0\.1\.0\.tgz$/mu);
  assert.match(sums, /^[0-9a-f]{64}  image\/gauntlet-0\.1\.0\.docker\.tar$/mu);
  assert.match(sums, /^[0-9a-f]{64}  image\/gauntlet-0\.1\.0\.oci\.tar$/mu);
  assert.match(sums, /^[0-9a-f]{64}  release-manifest\.json$/mu);
  assert.match(sums, /^[0-9a-f]{64}  publication-receipt\.json$/mu);
  assert.doesNotMatch(sums, /skills|SHA256SUMS|internal\/not-distributed/u);

  assert.deepEqual(writePublicationReceipt({ releaseDirectory: root, unit: "gauntlet", imageDigest: digest, chartDigest }), result);
  const receiptBeforeCollision = readFileSync(resolve(root, "units/gauntlet/publication-receipt.json"));
  assert.throws(() => writePublicationReceipt({
    releaseDirectory: root,
    unit: "gauntlet",
    imageDigest: `sha256:${"c".repeat(64)}`,
    chartDigest,
  }), /failed closed/u);
  assert.deepEqual(readFileSync(resolve(root, "units/gauntlet/publication-receipt.json")), receiptBeforeCollision);
  writeFileSync(resolve(root, "units/gauntlet/release-manifest.json"), "foreign\n");
  assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "gauntlet", imageDigest: digest, chartDigest }), /failed closed/u);
  assert.throws(
    () => writePublicationReceipt({ releaseDirectory: root, unit: "protocol", imageDigest: null, chartDigest: null }),
    /failed closed/u,
  );
  for (const invalid of [
    { releaseDirectory: root, unit: "nope", imageDigest: null, chartDigest: null },
    { releaseDirectory: root, unit: "gauntlet", imageDigest: digest, chartDigest: null },
    { releaseDirectory: root, unit: "gauntlet", imageDigest: "sha256:short", chartDigest },
    { releaseDirectory: root, unit: "skills", imageDigest: null },
  ]) assert.throws(() => writePublicationReceipt(invalid), TypeError);
});

test("publication receipt creation refuses pre-existing symlinks and non-directories", async (t) => {
  await t.test("receipt symlink", (t) => {
    const { root } = releaseFixture(t, [{ id: "skills", version: VERSION }]);
    writeFixtureFile(root, "foreign.json", "FOREIGN\n");
    mkdirSync(resolve(root, "units/skills"), { recursive: true, mode: 0o700 });
    symlinkSync("../../foreign.json", resolve(root, "units/skills/publication-receipt.json"));
    assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "skills", imageDigest: null, chartDigest: null }), /failed closed/u);
    assert.equal(readFileSync(resolve(root, "foreign.json"), "utf8"), "FOREIGN\n");
  });
  await t.test("units directory symlink", (t) => {
    const { root } = releaseFixture(t, [{ id: "skills", version: VERSION }]);
    const elsewhere = resolve(root, "..", "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, resolve(root, "units"));
    assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "skills", imageDigest: null, chartDigest: null }), /failed closed/u);
    assert.deepEqual(readdirSync(elsewhere), []);
  });
  await t.test("unit path is a file", (t) => {
    const { root } = releaseFixture(t, [{ id: "skills", version: VERSION }]);
    writeFixtureFile(root, "units/skills", "not a directory\n");
    assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "skills", imageDigest: null, chartDigest: null }), /failed closed/u);
  });
});

test("publication receipt creation rejects an incomplete release inventory", (t) => {
  const { root } = releaseFixture(t, [{ id: "gauntlet", version: VERSION }, { id: "skills", version: VERSION }]);
  rewriteManifest(root, (manifest) => {
    manifest.artifacts = manifest.artifacts.filter(({ kind }) => kind !== "sbom");
  });
  assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "skills", imageDigest: null, chartDigest: null }), /failed closed/u);
  assert.equal(existsSync(resolve(root, "units")), false);
});

test("the finalize CLI writes one unit and prints its file count", (t) => {
  const { root } = releaseFixture(t, [{ id: "skills", version: VERSION }]);
  const finalized = spawnSync(process.execPath, [CHECK_PUBLISHED, "--finalize", root, "--unit", "skills"], { encoding: "utf8" });
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(finalized.stdout, `${JSON.stringify({ command: "finalize", unit: "skills", files: 3 })}\n`);
  const rejected = spawnSync(process.execPath, [CHECK_PUBLISHED, "--finalize", root, "--unit", "gauntlet"], { encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Usage: check-published\.mjs/u);
});

test("the check CLI prints the release set and one exact state record per unit", async (t) => {
  const { root } = releaseFixture(t, [{ id: "protocol", version: VERSION }, { id: "skills", version: VERSION }]);
  const probe = async (check) => check.unit === "protocol"
    ? { id: check.id, state: "present", evidence: check.expectedEvidence }
    : { id: check.id, state: "absent" };
  const preflight = await runPublishedCli(
    ["--release-directory", root, "--source-commit", COMMIT],
    { collectEvidence: collectReleaseEvidence, probe },
  );
  assert.deepEqual(preflight, {
    exitCode: 0,
    stdout: `${JSON.stringify({
      command: "check",
      releaseSet: SET,
      units: [
        { id: "protocol", kind: "npm", version: VERSION, tag: "protocol-v0.1.0", state: "already-identical" },
        { id: "skills", kind: "skills", version: VERSION, tag: "skills-v0.1.0", state: "clean" },
      ],
    })}\n`,
    stderr: "",
  });
  const verified = await runPublishedCli(
    ["--release-directory", root, "--source-commit", COMMIT, "--unit", "skills", "--require-identical"],
    { collectEvidence: collectReleaseEvidence, probe, sleep: async () => {} },
  );
  assert.equal(verified.exitCode, 0, verified.stderr);
  assert.equal(verified.stdout, `${JSON.stringify({
    command: "check",
    releaseSet: SET,
    units: [{ id: "skills", kind: "skills", version: VERSION, tag: "skills-v0.1.0", state: "published-artifacts-identical" }],
  })}\n`);
  const partial = await runPublishedCli(
    ["--release-directory", root, "--source-commit", COMMIT],
    { collectEvidence: collectReleaseEvidence, probe: async (check) => check.kind === "npm"
      ? { id: check.id, state: "present", evidence: check.expectedEvidence }
      : { id: check.id, state: "absent" } },
  );
  assert.deepEqual(partial, { exitCode: 1, stdout: "", stderr: "Release unit protocol is partially published\n" });
  const usage = await runPublishedCli(["--release-directory", root, "--version", VERSION, "--source-commit", COMMIT]);
  assert.equal(usage.exitCode, 1);
  assert.match(usage.stderr, /^Usage: check-published\.mjs/u);
  assert.equal((await runPublishedCli(["--finalize", root, "--unit", "skills"], { probeDraft: 1 })).exitCode, 1);
});

test("the verify-draft CLI prints the unit, its tag and asset count from the commit-bound manifest", async (t) => {
  const { root } = releaseFixture(t, [{ id: "gauntlet", version: VERSION }, { id: "skills", version: VERSION }]);
  const finalized = await runPublishedCli(["--finalize", root, "--unit", "skills"]);
  assert.deepEqual(finalized, {
    exitCode: 0,
    stdout: `${JSON.stringify({ command: "finalize", unit: "skills", files: 3 })}\n`,
    stderr: "",
  });
  const argv = ["--release-directory", root, "--source-commit", COMMIT, "--unit", "skills", "--require-draft-identical"];
  const expected = `${JSON.stringify({
    command: "verify-draft",
    unit: "skills",
    tag: "skills-v0.1.0",
    assets: 4,
    state: "draft-identical",
  })}\n`;
  const { assets, bytesByName } = finalizedDraftAssets(root, "skills");
  const draft = githubReleaseFetch({ tag: "skills-v0.1.0", assets, bytesByName, draft: true, immutable: false });
  const fetched = await withEnvironment({ GH_TOKEN: REMOTE.GH_TOKEN }, () => withFetch(draft.fetch, () => runPublishedCli(argv)));
  assert.deepEqual(fetched, { exitCode: 0, stdout: expected, stderr: "" });

  const probed = [];
  const injected = await runPublishedCli(argv, {
    probeDraft: async (check) => {
      probed.push(check);
      return { id: check.id, state: "present", evidence: check.expectedEvidence };
    },
  });
  assert.deepEqual(injected, { exitCode: 0, stdout: expected, stderr: "" });
  assert.deepEqual(probed.map(({ id, unit, tag, version }) => [id, unit, tag, version]), [
    ["github:skills-v0.1.0", "skills", "skills-v0.1.0", VERSION],
  ]);
  assert.deepEqual(await runPublishedCli(argv, { probeDraft: async ({ id }) => ({ id, state: "absent" }) }), {
    exitCode: 1,
    stdout: "",
    stderr: "Published destination check failed closed\n",
  });
  assert.deepEqual(
    await runPublishedCli(["--release-directory", root, "--source-commit", WRONG_COMMIT, "--unit", "skills", "--require-draft-identical"], {
      probeDraft: async (check) => ({ id: check.id, state: "present", evidence: check.expectedEvidence }),
    }),
    { exitCode: 1, stdout: "", stderr: "Published destination check failed closed\n" },
  );
});

test("parses a bounded exact observation receipt and fails closed on ambiguous output", () => {
  const check = unitPlan("protocol")[0];
  assert.deepEqual(parseProbeObservation(`${JSON.stringify({ id: check.id, state: "absent" })}\n`, check), {
    id: check.id,
    state: "absent",
  });
  assert.deepEqual(parseProbeObservation(`${JSON.stringify({
    id: check.id,
    state: "present",
    evidence: check.expectedEvidence,
  })}\n`, check), {
    id: check.id,
    state: "present",
    evidence: check.expectedEvidence,
  });
  for (const output of [
    "",
    '{}\n',
    `${JSON.stringify({ id: check.id, state: "unknown" })}\n`,
    `${JSON.stringify({ id: check.id, state: "absent", extra: true })}\n`,
    `${JSON.stringify({ id: check.id, state: "present", evidence: check.expectedEvidence })}\nnoise\n`,
  ]) assert.throws(() => parseProbeObservation(output, check), /probe observation failed closed/u);
});

test("the preflight implementation itself has no publication primitive", () => {
  const source = readFileSync(CHECK_PUBLISHED, "utf8");
  for (const forbidden of [
    /npm\s+publish/u,
    /helm\s+push/u,
    /docker\s+(?:push|build)/u,
    /git\s+push/u,
    /gh\s+release\s+create/u,
    /--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)/u,
  ]) assert.doesNotMatch(source, forbidden);
});
