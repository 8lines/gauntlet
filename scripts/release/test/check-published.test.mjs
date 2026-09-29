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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  checkDraftReleasePublication,
  checkPublishedDestinations,
  checkReleasePublication,
  collectReleaseEvidence,
  createPublishedCheckPlan,
  evaluatePublishedState,
  parseImageInspection,
  parseOciLayoutIndex,
  parsePublicationReceipt,
  parsePublishedArguments,
  parseReleaseAssets,
  probeRemoteDestination,
  parseProbeObservation,
  PUBLISHED_DESTINATIONS,
  writePublicationReceipt,
} from "../check-published.mjs";
import { RELEASE_ARTIFACTS } from "../release-model.mjs";
import { packageCanonicalTree } from "../tree-archive.mjs";

const VERSION = "0.1.0";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const WRONG_COMMIT = "f".repeat(40);

function releaseAssetNames() {
  return [
    `gauntlet-compose-${VERSION}.tar.gz`,
    `gauntlet-skills-${VERSION}.tgz`,
    `gauntlet-${VERSION}.tgz`,
    "release-manifest.json",
    "publication-receipt.json",
    "SHA256SUMS",
    `gauntlet-${VERSION}.provenance.json`,
    "gauntlet-linux-amd64.spdx.json",
    "gauntlet-linux-arm64.spdx.json",
  ];
}

function evidence() {
  return Object.fromEntries(PUBLISHED_DESTINATIONS.map((destination, index) => {
    if (destination.kind === "npm") return [destination.id, `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`];
    if (destination.kind === "image") return [destination.id, `sha256:${String(index + 1).padStart(64, "0")}`];
    if (destination.kind === "composer") {
      return [destination.id, String(index + 1).padStart(40, "0")];
    }
    return [destination.id, String(index + 1).padStart(64, "0")];
  }));
}

function writeFixtureFile(root, relativePath, bytes) {
  const path = resolve(root, relativePath);
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

function releaseFixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-published-evidence-test-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = [];
  const add = (kind, name, relativePath, bytes = `${kind}:${name}\n`) => {
    const path = writeFixtureFile(root, relativePath, bytes);
    artifacts.push({ kind, name, path: relativePath, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    return path;
  };
  const archiveSourceRoot = resolve(root, ".fixture-archive-sources");
  mkdirSync(archiveSourceRoot, { mode: 0o700 });
  chmodSync(archiveSourceRoot, 0o700);
  const addCanonicalTree = (kind, name, relativePath, expectedPrefix, files) => {
    const source = resolve(archiveSourceRoot, `${kind}-${expectedPrefix}`);
    const outputDirectory = resolve(root, relativePath, "..");
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    chmodSync(outputDirectory, 0o700);
    for (const [path, bytes] of files) writeFixtureFile(source, path, bytes);
    const receipt = packageCanonicalTree({
      sourceDirectory: realpathSync(source),
      outputDirectory: realpathSync(outputDirectory),
      filename: relativePath.split("/").at(-1),
      archivePrefix: expectedPrefix,
    });
    artifacts.push({ kind, name, path: relativePath, sha256: receipt.sha256 });
  };

  for (const artifact of RELEASE_ARTIFACTS.npm) {
    const basename = artifact.name.replace(/^@/u, "").replaceAll("/", "-");
    add("npm", artifact.name, `npm/${basename}-${VERSION}.tgz`);
  }
  for (const artifact of RELEASE_ARTIFACTS.composer) {
    const expectedPrefix = `${artifact.name.split("/")[1]}-${VERSION}`;
    addCanonicalTree(
      "composer",
      artifact.name,
      `composer/artifacts/${expectedPrefix}.tar.gz`,
      expectedPrefix,
      [
        ["composer.json", `${JSON.stringify({ name: artifact.name, version: VERSION })}\n`],
        [".gauntlet-source.json", `${JSON.stringify({
          repository: "8lines/gauntlet",
          commit: COMMIT,
          path: artifact.directory,
          version: VERSION,
        })}\n`],
        ["src/Fixture.php", `<?php\n// ${artifact.name}\n`],
      ],
    );
  }
  for (const artifact of RELEASE_ARTIFACTS.maven) {
    const artifactId = artifact.name.split(":")[1];
    const expectedPrefix = `gauntlet-${artifactId}-${VERSION}`;
    addCanonicalTree(
      "maven",
      artifact.name,
      `maven/artifacts/${expectedPrefix}.tar.gz`,
      expectedPrefix,
      [[`${artifactId}-${VERSION}.jar`, `jar:${artifact.name}\n`]],
    );
  }
  rmSync(archiveSourceRoot, { recursive: true, force: false });
  add("compose", RELEASE_ARTIFACTS.compose.name, `compose/gauntlet-compose-${VERSION}.tar.gz`);
  add("skills", RELEASE_ARTIFACTS.skills.name, `skills/gauntlet-skills-${VERSION}.tgz`);
  add("helm", RELEASE_ARTIFACTS.chart.name, `helm/gauntlet-${VERSION}.tgz`, "chart\n");
  add("docker", "gauntlet.local/gauntlet", `image/gauntlet-${VERSION}.docker.tar`);

  const digest = `sha256:${"a".repeat(64)}`;
  const layout = resolve(root, "layout");
  mkdirSync(resolve(layout, "blobs"), { recursive: true, mode: 0o700 });
  writeFixtureFile(layout, "oci-layout", '{"imageLayoutVersion":"1.0.0"}\n');
  writeFixtureFile(layout, "index.json", `${JSON.stringify({
    schemaVersion: 2,
    manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest, size: 123 }],
  })}\n`);
  const ociPath = resolve(root, `image/gauntlet-${VERSION}.oci.tar`);
  const tar = spawnSync("tar", ["-cf", ociPath, "-C", layout, "index.json", "oci-layout", "blobs"], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  artifacts.push({
    kind: "oci",
    name: RELEASE_ARTIFACTS.image.name,
    path: `image/gauntlet-${VERSION}.oci.tar`,
    sha256: createHash("sha256").update(readFileSync(ociPath)).digest("hex"),
  });
  rmSync(layout, { recursive: true, force: true });
  add(
    "provenance",
    `${RELEASE_ARTIFACTS.image.name}@buildkit-unsigned`,
    `image/gauntlet-${VERSION}.provenance.json`,
    '{"predicateType":"https://slsa.dev/provenance/v1"}\n',
  );
  add("sbom", `${RELEASE_ARTIFACTS.image.name}@linux/amd64`, "sbom/gauntlet-linux-amd64.spdx.json", '{}\n');
  add("sbom", `${RELEASE_ARTIFACTS.image.name}@linux/arm64`, "sbom/gauntlet-linux-arm64.spdx.json", '{}\n');
  assert.equal(artifacts.length, 19);
  writeFixtureFile(root, "release-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    version: VERSION,
    sourceTag: `v${VERSION}`,
    sourceCommit: COMMIT,
    artifacts,
  })}\n`);
  return { digest, root };
}

function replaceComposerArchiveCommit(root, artifactName, commit) {
  const artifact = RELEASE_ARTIFACTS.composer.find(({ name }) => name === artifactName);
  assert.notEqual(artifact, undefined);
  const expectedPrefix = `${artifact.name.split("/")[1]}-${VERSION}`;
  const relativePath = `composer/artifacts/${expectedPrefix}.tar.gz`;
  const archivePath = resolve(root, relativePath);
  const source = resolve(root, ".wrong-composer-provenance");
  mkdirSync(source, { mode: 0o700 });
  writeFixtureFile(source, "composer.json", `${JSON.stringify({ name: artifact.name, version: VERSION })}\n`);
  writeFixtureFile(source, ".gauntlet-source.json", `${JSON.stringify({
    repository: "8lines/gauntlet",
    commit,
    path: artifact.directory,
    version: VERSION,
  })}\n`);
  writeFixtureFile(source, "src/Fixture.php", `<?php\n// ${artifact.name}\n`);
  rmSync(archivePath);
  const receipt = packageCanonicalTree({
    sourceDirectory: realpathSync(source),
    outputDirectory: realpathSync(resolve(archivePath, "..")),
    filename: `${expectedPrefix}.tar.gz`,
    archivePrefix: expectedPrefix,
  });
  rmSync(source, { recursive: true, force: false });
  const manifestPath = resolve(root, "release-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const record = manifest.artifacts.find(({ kind, name }) => kind === "composer" && name === artifact.name);
  assert.notEqual(record, undefined);
  record.sha256 = receipt.sha256;
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
}

function withTemporaryDirectory(root, callback) {
  const temporaryDirectory = resolve(root, "consumer-tmp");
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

test("derives registry-comparable evidence from every staged release family", async (t) => {
  const fixture = releaseFixture(t);
  assert.equal(existsSync(resolve(fixture.root, "composer/repositories")), false);
  assert.equal(existsSync(resolve(fixture.root, "maven/repository")), false);
  const proofs = await collectReleaseEvidence({ releaseDirectory: fixture.root, version: VERSION, sourceCommit: COMMIT });
  assert.deepEqual(Object.keys(proofs), PUBLISHED_DESTINATIONS.map(({ id }) => id));
  assert.equal(proofs["image:semantic"], fixture.digest);
  assert.equal(proofs["image:commit"], fixture.digest);
  assert.match(proofs["github:release"], /^[0-9a-f]{64}$/u);
  assert.notEqual(proofs["github:release"], COMMIT);
  assert.match(proofs["npm:protocol"], /^sha512-/u);
  assert.match(proofs["maven:core"], /^[0-9a-f]{64}$/u);
  assert.match(proofs["composer:php-core"], /^[0-9a-f]{40}$/u);
  assert.notEqual(proofs["composer:php-core"], proofs["composer:symfony-bundle"]);

  process.env.GAUNTLET_EXPECTED_IMAGE_DIGEST = fixture.digest;
  try {
    const postflight = await collectReleaseEvidence({ releaseDirectory: fixture.root, version: VERSION, sourceCommit: COMMIT });
    assert.equal(postflight["image:semantic"], fixture.digest);
    assert.equal(postflight["image:commit"], fixture.digest);
    process.env.GAUNTLET_EXPECTED_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
    await assert.rejects(
      collectReleaseEvidence({ releaseDirectory: fixture.root, version: VERSION, sourceCommit: COMMIT }),
      /failed closed/u,
    );
  } finally {
    delete process.env.GAUNTLET_EXPECTED_IMAGE_DIGEST;
  }

  writeFileSync(resolve(fixture.root, `image/gauntlet-${VERSION}.provenance.json`), "tampered\n");
  await assert.rejects(
    collectReleaseEvidence({ releaseDirectory: fixture.root, version: VERSION, sourceCommit: COMMIT }),
    /failed closed/u,
  );
});

test("release evidence materializes archive consumers into owned temporary trees and removes them", async (t) => {
  const fixture = releaseFixture(t);
  await withTemporaryDirectory(fixture.root, async (temporaryDirectory) => {
    const proofs = await collectReleaseEvidence({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    });
    assert.match(proofs["maven:core"], /^[0-9a-f]{64}$/u);
    assert.match(proofs["composer:php-core"], /^[0-9a-f]{40}$/u);
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  });
});

test("release evidence rejects a rehashed non-canonical consumer archive", async (t) => {
  const fixture = releaseFixture(t);
  const manifestPath = resolve(fixture.root, "release-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const artifact = manifest.artifacts.find(({ kind, name }) => (
    kind === "maven" && name === "dev.eightlines.gauntlet:core"
  ));
  assert.notEqual(artifact, undefined);
  const archivePath = resolve(fixture.root, artifact.path);
  writeFileSync(archivePath, "not a canonical tree archive\n", { mode: 0o600 });
  artifact.sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await withTemporaryDirectory(fixture.root, async (temporaryDirectory) => {
    await assert.rejects(collectReleaseEvidence({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    }), /failed closed/u);
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  });
});

test("release evidence rejects a rehashed Composer archive for a different source commit", async (t) => {
  const fixture = releaseFixture(t);
  replaceComposerArchiveCommit(fixture.root, "8lines/gauntlet-symfony-bundle", WRONG_COMMIT);
  await assert.rejects(collectReleaseEvidence({
    releaseDirectory: fixture.root,
    version: VERSION,
    sourceCommit: COMMIT,
  }), /failed closed/u);
});

test("rejects missing, unknown, or legacy-path staged artifacts before probing", async (t) => {
  const mutations = [
    {
      name: "missing",
      apply(manifest) { manifest.artifacts.pop(); },
    },
    {
      name: "unknown",
      apply(manifest) { manifest.artifacts[0] = { ...manifest.artifacts[0], name: "@8lines/not-in-the-release-catalog" }; },
    },
    {
      name: "legacy single SBOM",
      apply(manifest, root) {
        const artifact = manifest.artifacts.find(({ kind, name }) => kind === "sbom" && name.endsWith("@linux/amd64"));
        assert.notEqual(artifact, undefined);
        const bytes = readFileSync(resolve(root, artifact.path));
        artifact.path = "sbom/gauntlet.spdx.json";
        writeFixtureFile(root, artifact.path, bytes);
        artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
      },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async (t) => {
      const fixture = releaseFixture(t);
      const manifestPath = resolve(fixture.root, "release-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      mutation.apply(manifest, fixture.root);
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      await assert.rejects(
        collectReleaseEvidence({ releaseDirectory: fixture.root, version: VERSION, sourceCommit: COMMIT }),
        /failed closed/u,
      );
    });
  }
  await t.test("duplicate manifest field", async (t) => {
    const fixture = releaseFixture(t);
    const manifestPath = resolve(fixture.root, "release-manifest.json");
    const source = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
    await assert.rejects(
      collectReleaseEvidence({ releaseDirectory: fixture.root, version: VERSION, sourceCommit: COMMIT }),
      /failed closed/u,
    );
  });
});

test("derives finalized GitHub Release evidence from the exact local receipt and checksums", async (t) => {
  const fixture = releaseFixture(t);
  writePublicationReceipt({
    releaseDirectory: fixture.root,
    imageDigest: fixture.digest,
    chartDigest: `sha256:${"b".repeat(64)}`,
  });
  const proofs = await collectReleaseEvidence({
    releaseDirectory: fixture.root,
    version: VERSION,
    sourceCommit: COMMIT,
  });
  assert.match(proofs["github:release"], /^[0-9a-f]{64}$/u);
  writeFileSync(resolve(fixture.root, "SHA256SUMS"), "tampered under the same name\n");
  await assert.rejects(collectReleaseEvidence({
    releaseDirectory: fixture.root,
    version: VERSION,
    sourceCommit: COMMIT,
  }), /failed closed/u);
});

test("builds an immutable check plan only for the fixed release catalog destinations", () => {
  const plan = createPublishedCheckPlan({ version: VERSION, sourceCommit: COMMIT, evidence: evidence() });
  assert.equal(plan.length, 15);
  assert.deepEqual(plan.map(({ id }) => id), PUBLISHED_DESTINATIONS.map(({ id }) => id));
  assert.equal(new Set(plan.map(({ destination }) => destination)).size, 15);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(plan.every(Object.isFrozen), true);
  assert.match(plan.find(({ id }) => id === "image:semantic").destination, /ghcr\.io\/8lines\/gauntlet:0\.1\.0/u);
  assert.match(plan.find(({ id }) => id === "image:commit").destination, /:sha-0123456789ab$/u);
  assert.equal(plan.find(({ id }) => id === "composer:php-core").destination, "https://github.com/8lines/gauntlet-php-core.git#v0.1.0");
  assert.equal(plan.at(-1).destination, "https://github.com/8lines/gauntlet/releases/tag/v0.1.0");
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

test("accepts only a receipt bound to the exact staged manifest and source", () => {
  const manifestSha256 = "d".repeat(64);
  const receipt = {
    schemaVersion: 1,
    version: VERSION,
    sourceCommit: COMMIT,
    imageDigest: `sha256:${"a".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
    manifestSha256,
  };
  const canonical = `${JSON.stringify(receipt, null, 2)}\n`;
  assert.deepEqual(parsePublicationReceipt(canonical, { version: VERSION, sourceCommit: COMMIT, manifestSha256 }), receipt);
  for (const invalid of [
    { ...receipt, sourceCommit: "f".repeat(40) },
    { ...receipt, manifestSha256: "e".repeat(64) },
    { ...receipt, extra: true },
  ]) assert.throws(
    () => parsePublicationReceipt(`${JSON.stringify(invalid)}\n`, { version: VERSION, sourceCommit: COMMIT, manifestSha256 }),
    /publication receipt failed closed/u,
  );
  assert.throws(
    () => parsePublicationReceipt(
      `${JSON.stringify(receipt).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')}\n`,
      { version: VERSION, sourceCommit: COMMIT, manifestSha256 },
    ),
    /publication receipt failed closed/u,
  );
  assert.throws(
    () => parsePublicationReceipt(`${JSON.stringify(receipt)}\n`, { version: VERSION, sourceCommit: COMMIT, manifestSha256 }),
    /publication receipt failed closed/u,
  );
});

test("accepts only the complete fixed GitHub Release asset catalog", () => {
  const names = releaseAssetNames();
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const parsed = parseReleaseAssets(assets, VERSION);
  assert.deepEqual(Object.keys(parsed), names);
  assert.equal(parsed["publication-receipt.json"], 5);
  assert.throws(() => parseReleaseAssets(assets.slice(1), VERSION), /Release assets failed closed/u);
  assert.throws(
    () => parseReleaseAssets(assets.filter(({ name }) => name !== `gauntlet-skills-${VERSION}.tgz`), VERSION),
    /Release assets failed closed/u,
  );
  assert.throws(
    () => parseReleaseAssets(assets.filter(({ name }) => name !== `gauntlet-compose-${VERSION}.tar.gz`), VERSION),
    /Release assets failed closed/u,
  );
  assert.throws(() => parseReleaseAssets([...assets, { id: 99, name: "unexpected.txt" }], VERSION), /Release assets failed closed/u);
  assert.throws(() => parseReleaseAssets([...assets.slice(0, -1), assets[0]], VERSION), /Release assets failed closed/u);
});

function responseJson(value, status = 200) {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubReleaseFetch({
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
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, options });
    if (url.origin === "https://api.github.com" && url.pathname === "/repos/8lines/gauntlet") {
      return responseJson({ id: 1, private: true });
    }
    if (url.origin === "https://api.github.com"
        && url.pathname === `/repos/8lines/gauntlet/releases/tags/v${VERSION}`) {
      if (releaseAbsent || draft) return new Response(null, { status: 404 });
      return responseJson({ tag_name: `v${VERSION}`, draft, prerelease: false, immutable, assets });
    }
    if (url.origin === "https://api.github.com"
        && url.pathname === "/repos/8lines/gauntlet/releases") {
      return responseJson(draft
        ? [{ tag_name: `v${VERSION}`, draft, prerelease: false, immutable, assets }]
        : []);
    }
    if (url.origin === "https://api.github.com"
        && url.pathname === `/repos/8lines/gauntlet/git/ref/tags/v${VERSION}`) {
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

function canonicalReceiptBytes(root, imageDigest, chartDigest) {
  const manifest = readFileSync(resolve(root, "release-manifest.json"));
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    version: VERSION,
    sourceCommit: COMMIT,
    imageDigest,
    chartDigest,
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  }, null, 2)}\n`);
}

test("uses a canonical remote receipt only as the missing-local rerun fallback", async (t) => {
  const fixture = releaseFixture(t);
  const names = releaseAssetNames();
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const chartDigest = `sha256:${"b".repeat(64)}`;
  const bytesByName = new Map(names.map((name) => [name, Buffer.from(`exact:${name}\n`)]));
  bytesByName.set("publication-receipt.json", canonicalReceiptBytes(fixture.root, fixture.digest, chartDigest));
  const remote = githubReleaseFetch({ assets, bytesByName, immutable: true });
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  const originalMode = process.env.GAUNTLET_USE_REMOTE_RECEIPT;
  try {
    globalThis.fetch = remote.fetch;
    process.env.GH_TOKEN = "test-token-for-release-assets";
    process.env.GAUNTLET_USE_REMOTE_RECEIPT = "true";
    const proofs = await collectReleaseEvidence({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    });
    assert.equal(proofs["image:semantic"], fixture.digest);
    assert.match(proofs["github:release"], /^[0-9a-f]{64}$/u);
    assert.equal(remote.calls.filter(({ url }) => url.includes("/releases/assets/")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalMode === undefined) delete process.env.GAUNTLET_USE_REMOTE_RECEIPT;
    else process.env.GAUNTLET_USE_REMOTE_RECEIPT = originalMode;
  }
});

test("rejects a coordinated remote receipt and image replacement even when the release is immutable", async (t) => {
  const fixture = releaseFixture(t);
  const names = releaseAssetNames();
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const replacementImage = `sha256:${"c".repeat(64)}`;
  const bytesByName = new Map(names.map((name) => [name, Buffer.from(`replacement:${name}\n`)]));
  bytesByName.set(
    "publication-receipt.json",
    canonicalReceiptBytes(fixture.root, replacementImage, `sha256:${"d".repeat(64)}`),
  );
  const remote = githubReleaseFetch({ assets, bytesByName, immutable: true });
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  const originalMode = process.env.GAUNTLET_USE_REMOTE_RECEIPT;
  try {
    globalThis.fetch = remote.fetch;
    process.env.GH_TOKEN = "test-token-for-release-assets";
    process.env.GAUNTLET_USE_REMOTE_RECEIPT = "true";
    await assert.rejects(collectReleaseEvidence({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    }), /failed closed/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalMode === undefined) delete process.env.GAUNTLET_USE_REMOTE_RECEIPT;
    else process.env.GAUNTLET_USE_REMOTE_RECEIPT = originalMode;
  }
});

test("rejects a remote receipt from a mutable public release", async (t) => {
  const fixture = releaseFixture(t);
  const names = releaseAssetNames();
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const bytesByName = new Map(names.map((name) => [name, Buffer.from(`exact:${name}\n`)]));
  bytesByName.set(
    "publication-receipt.json",
    canonicalReceiptBytes(fixture.root, fixture.digest, `sha256:${"b".repeat(64)}`),
  );
  const remote = githubReleaseFetch({
    assets,
    bytesByName,
    immutable: false,
  });
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  const originalMode = process.env.GAUNTLET_USE_REMOTE_RECEIPT;
  try {
    globalThis.fetch = remote.fetch;
    process.env.GH_TOKEN = "test-token-for-release-assets";
    process.env.GAUNTLET_USE_REMOTE_RECEIPT = "true";
    await assert.rejects(collectReleaseEvidence({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    }), /failed closed/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalMode === undefined) delete process.env.GAUNTLET_USE_REMOTE_RECEIPT;
    else process.env.GAUNTLET_USE_REMOTE_RECEIPT = originalMode;
  }
});

test("post-finalize evidence binds remote receipt bytes and the published chart digest to local bytes", async (t) => {
  const fixture = releaseFixture(t);
  const localChartDigest = `sha256:${"b".repeat(64)}`;
  writePublicationReceipt({
    releaseDirectory: fixture.root,
    imageDigest: fixture.digest,
    chartDigest: localChartDigest,
  });
  const names = releaseAssetNames();
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const bytesByName = new Map(names.map((name) => [name, Buffer.from(`exact:${name}\n`)]));
  bytesByName.set(
    "publication-receipt.json",
    canonicalReceiptBytes(fixture.root, fixture.digest, `sha256:${"c".repeat(64)}`),
  );
  const remote = githubReleaseFetch({ assets, bytesByName, immutable: true });
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  const originalMode = process.env.GAUNTLET_USE_REMOTE_RECEIPT;
  const originalChart = process.env.GAUNTLET_EXPECTED_CHART_DIGEST;
  try {
    globalThis.fetch = remote.fetch;
    process.env.GH_TOKEN = "test-token-for-release-assets";
    process.env.GAUNTLET_USE_REMOTE_RECEIPT = "true";
    await assert.rejects(collectReleaseEvidence({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    }), /failed closed/u);

    delete process.env.GAUNTLET_USE_REMOTE_RECEIPT;
    process.env.GAUNTLET_EXPECTED_CHART_DIGEST = `sha256:${"c".repeat(64)}`;
    await assert.rejects(collectReleaseEvidence({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    }), /failed closed/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalMode === undefined) delete process.env.GAUNTLET_USE_REMOTE_RECEIPT;
    else process.env.GAUNTLET_USE_REMOTE_RECEIPT = originalMode;
    if (originalChart === undefined) delete process.env.GAUNTLET_EXPECTED_CHART_DIGEST;
    else process.env.GAUNTLET_EXPECTED_CHART_DIGEST = originalChart;
  }
});

test("draft verification compares all nine uploaded bytes to the local finalized release", async (t) => {
  const fixture = releaseFixture(t);
  writePublicationReceipt({
    releaseDirectory: fixture.root,
    imageDigest: fixture.digest,
    chartDigest: `sha256:${"b".repeat(64)}`,
  });
  const names = releaseAssetNames();
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const paths = new Map([
    [`gauntlet-compose-${VERSION}.tar.gz`, `compose/gauntlet-compose-${VERSION}.tar.gz`],
    [`gauntlet-skills-${VERSION}.tgz`, `skills/gauntlet-skills-${VERSION}.tgz`],
    [`gauntlet-${VERSION}.tgz`, `helm/gauntlet-${VERSION}.tgz`],
    ["release-manifest.json", "release-manifest.json"],
    ["publication-receipt.json", "publication-receipt.json"],
    ["SHA256SUMS", "SHA256SUMS"],
    [`gauntlet-${VERSION}.provenance.json`, `image/gauntlet-${VERSION}.provenance.json`],
    ["gauntlet-linux-amd64.spdx.json", "sbom/gauntlet-linux-amd64.spdx.json"],
    ["gauntlet-linux-arm64.spdx.json", "sbom/gauntlet-linux-arm64.spdx.json"],
  ]);
  const bytesByName = new Map([...paths].map(([name, path]) => [name, readFileSync(resolve(fixture.root, path))]));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "test-token-for-release-assets";
    const exact = githubReleaseFetch({ assets, bytesByName, draft: true, immutable: false });
    globalThis.fetch = exact.fetch;
    assert.equal(await checkDraftReleasePublication({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    }), "draft-identical");

    bytesByName.set(`gauntlet-compose-${VERSION}.tar.gz`, Buffer.from("tampered draft upload\n"));
    const tampered = githubReleaseFetch({ assets, bytesByName, draft: true, immutable: false });
    globalThis.fetch = tampered.fetch;
    await assert.rejects(checkDraftReleasePublication({
      releaseDirectory: fixture.root,
      version: VERSION,
      sourceCommit: COMMIT,
    }), /failed closed/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});

test("GitHub Release probing hashes every exact asset byte and rejects same-name tampering", async () => {
  const names = releaseAssetNames();
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const bytesByName = new Map(names.map((name) => [name, Buffer.from(`exact:${name}\n`)]));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "test-token-for-release-assets";
    const firstRemote = githubReleaseFetch({ assets, bytesByName, immutable: true });
    globalThis.fetch = firstRemote.fetch;
    const seedPlan = createPublishedCheckPlan({ version: VERSION, sourceCommit: COMMIT, evidence: evidence() });
    const seedRelease = seedPlan.find(({ id }) => id === "github:release");
    const original = await probeRemoteDestination(seedRelease);
    assert.match(original.evidence, /^[0-9a-f]{64}$/u);
    assert.equal(firstRemote.calls.filter(({ url }) => url.includes("/releases/assets/")).length, 9);
    assert.equal(
      firstRemote.calls.filter(({ url }) => url.startsWith("https://objects.githubusercontent.com/")).length,
      9,
    );
    assert.equal(firstRemote.calls.filter(({ url }) => url.startsWith("https://objects.githubusercontent.com/"))
      .every(({ options }) => options.headers.Authorization === undefined), true);

    const matchingEvidence = { ...evidence(), "github:release": original.evidence };
    const matchingPlan = createPublishedCheckPlan({ version: VERSION, sourceCommit: COMMIT, evidence: matchingEvidence });
    bytesByName.set(`gauntlet-compose-${VERSION}.tar.gz`, Buffer.from("tampered under the same name\n"));
    const secondRemote = githubReleaseFetch({ assets, bytesByName, immutable: true });
    globalThis.fetch = secondRemote.fetch;
    const releaseCheck = matchingPlan.find(({ id }) => id === "github:release");
    const tampered = await probeRemoteDestination(releaseCheck);
    assert.notEqual(tampered.evidence, original.evidence);
    const observations = matchingPlan.map(({ id, expectedEvidence }) => id === "github:release"
      ? tampered
      : { id, state: "present", evidence: expectedEvidence });
    assert.throws(() => evaluatePublishedState(matchingPlan, observations), /different evidence/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});

test("GitHub Release asset downloads reject untrusted redirects and declared oversize before reading bytes", async () => {
  const names = releaseAssetNames();
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const bytesByName = new Map(names.map((name) => [name, Buffer.from(`exact:${name}\n`)]));
  const releaseCheck = createPublishedCheckPlan({
    version: VERSION,
    sourceCommit: COMMIT,
    evidence: evidence(),
  }).find(({ id }) => id === "github:release");
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "test-token-for-release-assets";
    const untrusted = githubReleaseFetch({ assets, bytesByName, immutable: true, redirectHost: "evil.invalid" });
    globalThis.fetch = untrusted.fetch;
    await assert.rejects(probeRemoteDestination(releaseCheck), /failed closed/u);
    assert.equal(untrusted.calls.some(({ url }) => url.startsWith("https://evil.invalid/")), false);

    const oversized = githubReleaseFetch({ assets, bytesByName, immutable: true, oversizedName: names[0] });
    globalThis.fetch = oversized.fetch;
    await assert.rejects(probeRemoteDestination(releaseCheck), /failed closed/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});

test("accepts only wholly absent or wholly byte-identical remote state", () => {
  const plan = createPublishedCheckPlan({ version: VERSION, sourceCommit: COMMIT, evidence: evidence() });
  assert.equal(evaluatePublishedState(plan, plan.map(({ id }) => ({ id, state: "absent" }))), "clean");
  assert.equal(evaluatePublishedState(
    plan,
    plan.map(({ id, expectedEvidence }) => ({ id, state: "present", evidence: expectedEvidence })),
  ), "already-identical");

  const mixed = plan.map(({ id }, index) => index === 0
    ? { id, state: "present", evidence: plan[index].expectedEvidence }
    : { id, state: "absent" });
  assert.throws(() => evaluatePublishedState(plan, mixed), /mixed published state/u);

  const different = plan.map(({ id, expectedEvidence }) => ({ id, state: "present", evidence: expectedEvidence }));
  different[3] = { ...different[3], evidence: "f".repeat(64) };
  assert.throws(() => evaluatePublishedState(plan, different), /different evidence/u);
  assert.throws(() => evaluatePublishedState(plan, different.slice(1)), /complete observation set/u);
  assert.throws(
    () => evaluatePublishedState(plan, plan.map(({ id }) => ({ id, state: "unknown" }))),
    /invalid observation/u,
  );
});

test("runs every read-only injected probe before evaluating global state", async () => {
  const plan = createPublishedCheckPlan({ version: VERSION, sourceCommit: COMMIT, evidence: evidence() });
  const calls = [];
  const result = await checkPublishedDestinations({
    plan,
    probe: async (check) => {
      calls.push(check.id);
      return { id: check.id, state: "absent" };
    },
  });
  assert.equal(result, "clean");
  assert.deepEqual(calls, plan.map(({ id }) => id));

  const failingCalls = [];
  await assert.rejects(checkPublishedDestinations({
    plan,
    probe: async (check) => {
      failingCalls.push(check.id);
      if (check.id === "chart:semantic") throw new Error("registry unavailable");
      return { id: check.id, state: "absent" };
    },
  }), /registry unavailable/u);
  assert.deepEqual(failingCalls, plan.map(({ id }) => id));
});

test("the concrete probe rejects an arbitrary destination before any network call", async () => {
  const plan = createPublishedCheckPlan({ version: VERSION, sourceCommit: COMMIT, evidence: evidence() });
  await assert.rejects(
    probeRemoteDestination(Object.freeze({ ...plan[0], destination: "https://example.invalid/foreign" })),
    /Remote probe check is invalid/u,
  );
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
  const chart = createPublishedCheckPlan({
    version: VERSION,
    sourceCommit: COMMIT,
    evidence: evidence(),
  }).find(({ id }) => id === "chart:semantic");

  await assert.rejects(probeRemoteDestination(chart), /cleanup failed closed/u);
  const sentinel = readdirSync(temporaryDirectory)
    .map((name) => resolve(temporaryDirectory, name, "sentinel.txt"))
    .find((path) => existsSync(path));
  assert.notEqual(sentinel, undefined);
  assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
});

test("release preflight derives evidence before probing and can require an identical rerun", async () => {
  const calls = [];
  const proofs = evidence();
  const dependencies = {
    async collectEvidence(options) {
      calls.push(["evidence", options]);
      return proofs;
    },
    async probe(check) {
      calls.push(["probe", check.id]);
      return { id: check.id, state: "present", evidence: check.expectedEvidence };
    },
  };
  assert.equal(await checkReleasePublication({
    releaseDirectory: "/safe/staged-release",
    version: VERSION,
    sourceCommit: COMMIT,
    requireIdentical: true,
  }, dependencies), "already-identical");
  assert.deepEqual(calls[0], ["evidence", {
    releaseDirectory: "/safe/staged-release",
    version: VERSION,
    sourceCommit: COMMIT,
  }]);
  assert.equal(calls.filter(([kind]) => kind === "probe").length, 15);

  assert.equal(await checkReleasePublication({
    releaseDirectory: "/safe/staged-release",
    version: VERSION,
    sourceCommit: COMMIT,
    requireIdentical: true,
  }, {
    collectEvidence: async () => proofs,
    probe: async (check) => check.kind === "release"
      ? { id: check.id, state: "absent" }
      : { id: check.id, state: "present", evidence: check.expectedEvidence },
  }), "published-artifacts-identical");

  await assert.rejects(checkReleasePublication({
    releaseDirectory: "/safe/staged-release",
    version: VERSION,
    sourceCommit: COMMIT,
    requireIdentical: true,
  }, {
    collectEvidence: async () => proofs,
    probe: async ({ id }) => ({ id, state: "absent" }),
    sleep: async () => {},
  }), /required every destination to be identical/u);
});

test("post-publication verification retries missing destinations and fails immediately on conflicting evidence", async () => {
  const proofs = evidence();
  let npmProbeCount = 0;
  let sleepCount = 0;
  assert.equal(await checkReleasePublication({
    releaseDirectory: "/safe/staged-release",
    version: VERSION,
    sourceCommit: COMMIT,
    requireIdentical: true,
  }, {
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
  }), "published-artifacts-identical");
  assert.equal(sleepCount, 1);

  let slept = false;
  await assert.rejects(checkReleasePublication({
    releaseDirectory: "/safe/staged-release",
    version: VERSION,
    sourceCommit: COMMIT,
    requireIdentical: true,
  }, {
    collectEvidence: async () => proofs,
    probe: async (check) => check.kind === "release"
      ? { id: check.id, state: "absent" }
      : { id: check.id, state: "present", evidence: check.id === "npm:protocol" ? `sha512-${"A".repeat(86)}==` : check.expectedEvidence },
    sleep: async () => { slept = true; },
  }), /different evidence/u);
  assert.equal(slept, false);
});

test("writes an atomic closed publication receipt without mutating deterministic inventory", (t) => {
  const { root } = releaseFixture(t);
  writeFixtureFile(root, "internal/not-distributed.txt", "internal\n");
  writeFileSync(resolve(root, "SHA256SUMS"), "stale\n", { mode: 0o600 });

  const manifestBefore = readFileSync(resolve(root, "release-manifest.json"));
  const result = writePublicationReceipt({
    releaseDirectory: root,
    imageDigest: `sha256:${"a".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
  });
  assert.equal(result.files, 21);
  assert.deepEqual(readFileSync(resolve(root, "release-manifest.json")), manifestBefore);
  const receipt = JSON.parse(readFileSync(resolve(root, "publication-receipt.json"), "utf8"));
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    version: VERSION,
    sourceCommit: COMMIT,
    imageDigest: `sha256:${"a".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
    manifestSha256: createHash("sha256").update(manifestBefore).digest("hex"),
  });
  const sums = readFileSync(resolve(root, "SHA256SUMS"), "utf8");
  assert.match(sums, /^[0-9a-f]{64}  helm\/gauntlet-0\.1\.0\.tgz$/mu);
  assert.match(sums, /^[0-9a-f]{64}  skills\/gauntlet-skills-0\.1\.0\.tgz$/mu);
  assert.match(sums, /^[0-9a-f]{64}  release-manifest\.json$/mu);
  assert.match(sums, /^[0-9a-f]{64}  publication-receipt\.json$/mu);
  assert.doesNotMatch(sums, /SHA256SUMS/u);
  assert.doesNotMatch(sums, /internal\/not-distributed/u);

  assert.deepEqual(writePublicationReceipt({
    releaseDirectory: root,
    imageDigest: `sha256:${"a".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
  }), result);
  const receiptBeforeCollision = readFileSync(resolve(root, "publication-receipt.json"));
  assert.throws(() => writePublicationReceipt({
    releaseDirectory: root,
    imageDigest: `sha256:${"c".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
  }), /failed closed/u);
  assert.deepEqual(readFileSync(resolve(root, "publication-receipt.json")), receiptBeforeCollision);
});

test("publication receipt creation refuses a pre-existing symlink", (t) => {
  const { root } = releaseFixture(t);
  writeFixtureFile(root, "foreign.json", "FOREIGN\n");
  symlinkSync("foreign.json", resolve(root, "publication-receipt.json"));
  assert.throws(() => writePublicationReceipt({
    releaseDirectory: root,
    imageDigest: `sha256:${"a".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
  }), /failed closed/u);
  assert.equal(readFileSync(resolve(root, "foreign.json"), "utf8"), "FOREIGN\n");
});

test("publication receipt creation rejects an incomplete release inventory", (t) => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-published-incomplete-receipt-test-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(root, "release-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    version: VERSION,
    sourceTag: `v${VERSION}`,
    sourceCommit: COMMIT,
    artifacts: [],
  })}\n`);
  assert.throws(() => writePublicationReceipt({
    releaseDirectory: root,
    imageDigest: `sha256:${"a".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
  }), /failed closed/u);
});

test("parses a bounded exact observation receipt and fails closed on ambiguous output", () => {
  const plan = createPublishedCheckPlan({ version: VERSION, sourceCommit: COMMIT, evidence: evidence() });
  const check = plan[0];
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

test("CLI accepts only the fixed preflight, postflight, and local finalization shapes", () => {
  const releaseDirectory = "/tmp/gauntlet-release-0.1.0";
  assert.deepEqual(parsePublishedArguments([
    "--release-directory", releaseDirectory,
    "--version", VERSION,
    "--source-commit", COMMIT,
  ]), { command: "check", releaseDirectory, version: VERSION, sourceCommit: COMMIT, requireIdentical: false });
  assert.deepEqual(parsePublishedArguments([
    "--release-directory", releaseDirectory,
    "--version", VERSION,
    "--source-commit", COMMIT,
    "--require-identical",
  ]), { command: "check", releaseDirectory, version: VERSION, sourceCommit: COMMIT, requireIdentical: true });
  assert.deepEqual(parsePublishedArguments([
    "--release-directory", releaseDirectory,
    "--version", VERSION,
    "--source-commit", COMMIT,
    "--require-draft-identical",
  ]), { command: "verify-draft", releaseDirectory, version: VERSION, sourceCommit: COMMIT });
  assert.deepEqual(parsePublishedArguments([
    "--finalize", releaseDirectory,
    "--image-digest", `sha256:${"a".repeat(64)}`,
    "--chart-digest", `sha256:${"b".repeat(64)}`,
  ]), {
    command: "finalize",
    releaseDirectory,
    imageDigest: `sha256:${"a".repeat(64)}`,
    chartDigest: `sha256:${"b".repeat(64)}`,
  });
  for (const args of [
    [],
    ["--release-directory", "relative", "--version", VERSION, "--source-commit", COMMIT],
    ["--release-directory", releaseDirectory, "--version", "v0.1.0", "--source-commit", COMMIT],
    ["--release-directory", releaseDirectory, "--version", VERSION, "--source-commit", COMMIT, "--unknown"],
  ]) assert.throws(() => parsePublishedArguments(args), /Usage:/u);
});

test("the preflight implementation itself has no publication primitive", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../check-published.mjs"), "utf8");
  for (const forbidden of [
    /npm\s+publish/u,
    /helm\s+push/u,
    /docker\s+(?:push|build)/u,
    /git\s+push/u,
    /gh\s+release\s+create/u,
    /--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)/u,
  ]) assert.doesNotMatch(source, forbidden);
});
