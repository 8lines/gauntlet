import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  createImageExportPlan,
  exportImageAndAttestations,
  inspectDockerArchive,
  inspectOciArchive,
  parseBuildxPlatforms,
} from "../stage-image.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DOCKERFILE_FRONTEND_DIGEST = "a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e";
const SBOM_GENERATOR_DIGEST = "ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9";
const NODE_IMAGE_DIGEST = "e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf";

function outputSandbox(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-image-export-test-")));
  chmodSync(root, 0o700);
  const output = resolve(root, "image");
  mkdirSync(output, { mode: 0o700 });
  chmodSync(output, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return output;
}

function tarString(header, offset, length, value) {
  Buffer.from(value, "ascii").copy(header, offset, 0, length);
}

function tarOctal(header, offset, length, value) {
  const source = value.toString(8).padStart(length - 1, "0");
  header.write(source, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(512);
  tarString(header, 0, 100, name);
  tarOctal(header, 100, 8, 0o644);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, size);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  tarString(header, 257, 6, "ustar\0");
  tarString(header, 263, 2, "00");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function tarBytes(entries) {
  const chunks = [];
  for (const [name, bytes] of entries) {
    if (bytes === null) {
      chunks.push(tarHeader(name, 0, "5"));
      continue;
    }
    chunks.push(tarHeader(name, bytes.length), bytes);
    const padding = Math.ceil(bytes.length / 512) * 512 - bytes.length;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeTar(path, entries) {
  writeFileSync(path, tarBytes(entries), { mode: 0o600 });
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value));
}

function descriptor(bytes, extra = {}) {
  return {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.length,
    ...extra,
  };
}

function blobPath(record) {
  return `blobs/sha256/${record.digest.slice(7)}`;
}

function labels() {
  return {
    "org.opencontainers.image.source": "https://github.com/8lines/gauntlet",
    "org.opencontainers.image.version": "0.1.0",
    "org.opencontainers.image.revision": COMMIT,
    "org.opencontainers.image.licenses": "Apache-2.0",
  };
}

function ociFixture(path, options = {}) {
  const entries = new Map();
  const top = [];
  for (const architecture of ["amd64", "arm64"]) {
    const uncompressedLayer = tarBytes([["app.txt", Buffer.from(`gauntlet-${architecture}\n`)]]);
    const compressedLayer = gzipSync(uncompressedLayer, { level: 9, mtime: 0 });
    const imageLayer = descriptor(compressedLayer, { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" });
    const configBytes = jsonBytes({
      architecture,
      os: "linux",
      config: { Labels: labels() },
      rootfs: {
        type: "layers",
        diff_ids: [options.wrongDiffId === true && architecture === "amd64"
          ? `sha256:${"0".repeat(64)}`
          : `sha256:${createHash("sha256").update(uncompressedLayer).digest("hex")}`],
      },
    });
    const config = descriptor(configBytes, { mediaType: "application/vnd.oci.image.config.v1+json" });
    const imageLayers = options.emptyImageLayers === true ? [] : [imageLayer];
    const manifestBytes = jsonBytes({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config,
      layers: imageLayers,
    });
    const image = descriptor(manifestBytes, { platform: { architecture, os: "linux" } });
    const subject = [{
      name: options.wrongSubjectName === true
        ? "image"
        : `pkg:docker/ghcr.io/8lines/gauntlet@0.1.0?platform=linux%2F${architecture}`,
      digest: { sha256: image.digest.slice(7) },
    }];
    const statements = [
      {
        _type: options.statementType ?? "https://in-toto.io/Statement/v0.1",
        subject,
        predicateType: "https://spdx.dev/Document",
        predicate: {
          spdxVersion: "SPDX-2.3",
          dataLicense: "CC0-1.0",
          SPDXID: "SPDXRef-DOCUMENT",
          name: "sbom",
          documentNamespace: `https://example.invalid/${architecture}`,
          creationInfo: { created: "2026-01-01T00:00:00Z", creators: ["Tool: test"] },
          packages: [
            {
              name: "sbom",
              SPDXID: "SPDXRef-DocumentRoot-Directory-sbom",
              downloadLocation: "NOASSERTION",
              filesAnalyzed: false,
              licenseConcluded: "NOASSERTION",
              licenseDeclared: "NOASSERTION",
              copyrightText: "NOASSERTION",
            },
            {
              name: "@8lines/gauntlet-server",
              SPDXID: "SPDXRef-Package-gauntlet-server",
              versionInfo: "0.1.0",
              downloadLocation: "NOASSERTION",
              filesAnalyzed: false,
              licenseConcluded: "NOASSERTION",
              licenseDeclared: "NOASSERTION",
              copyrightText: "NOASSERTION",
            },
          ],
          files: [{
            fileName: "/app/dist/main.js",
            SPDXID: "SPDXRef-File-main-js",
            checksums: [{ algorithm: "SHA256", checksumValue: "3".repeat(64) }],
            licenseConcluded: "NOASSERTION",
            copyrightText: "NOASSERTION",
          }],
          relationships: [
            {
              spdxElementId: "SPDXRef-DOCUMENT",
              relatedSpdxElement: "SPDXRef-DocumentRoot-Directory-sbom",
              relationshipType: "DESCRIBES",
            },
            {
              spdxElementId: "SPDXRef-DocumentRoot-Directory-sbom",
              relatedSpdxElement: "SPDXRef-Package-gauntlet-server",
              relationshipType: "CONTAINS",
            },
            {
              spdxElementId: "SPDXRef-DocumentRoot-Directory-sbom",
              relatedSpdxElement: "SPDXRef-File-main-js",
              relationshipType: "CONTAINS",
            },
          ],
        },
      },
      {
        _type: options.statementType ?? "https://in-toto.io/Statement/v0.1",
        subject,
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: options.invalidProvenance === true ? { buildDefinition: {}, runDetails: {} } : {
          buildDefinition: {
            buildType: "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
            externalParameters: {
              configSource: { path: "Dockerfile" },
              request: {
                frontend: "gateway.v0",
                args: {
                  "build-arg:GAUNTLET_REVISION": COMMIT,
                  "build-arg:GAUNTLET_VERSION": "0.1.0",
                  source: `docker/dockerfile:1.7@sha256:${DOCKERFILE_FRONTEND_DIGEST}`,
                  target: "runtime",
                },
                locals: [{ name: "context" }, { name: "dockerfile" }],
              },
            },
            internalParameters: { builderPlatform: "linux/arm64" },
            resolvedDependencies: [
              { uri: "pkg:docker/docker/buildkit-syft-scanner", digest: { sha256: SBOM_GENERATOR_DIGEST } },
              { uri: "pkg:docker/docker/dockerfile", digest: { sha256: DOCKERFILE_FRONTEND_DIGEST } },
              { uri: "pkg:docker/node", digest: { sha256: NODE_IMAGE_DIGEST } },
            ],
          },
          runDetails: {
            builder: { id: options.builderId ?? "" },
            metadata: {
              invocationId: `https://example.invalid/invocations/${architecture}`,
              startedOn: "2026-01-01T01:00:00+01:00",
              finishedOn: "2026-01-01T01:00:01+01:00",
              buildkit_completeness: { request: true, resolvedDependencies: false },
            },
          },
        },
      },
    ];
    if (options.provenanceMutation !== undefined && architecture === "amd64") {
      options.provenanceMutation(statements[1].predicate);
    }
    const layers = statements.map((statement) => {
      const bytes = jsonBytes(statement);
      const layer = descriptor(bytes, {
        annotations: { "in-toto.io/predicate-type": statement.predicateType },
        mediaType: "application/vnd.in-toto+json",
      });
      entries.set(blobPath(layer), bytes);
      return layer;
    });
    const attestationConfigBytes = jsonBytes({
      architecture: "unknown",
      os: "unknown",
      config: {},
      rootfs: { type: "layers", diff_ids: layers.map(({ digest }) => digest) },
    });
    const attestationConfig = descriptor(attestationConfigBytes, {
      mediaType: "application/vnd.oci.image.config.v1+json",
    });
    const attestationBytes = jsonBytes({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: attestationConfig,
      layers,
    });
    const attestation = descriptor(attestationBytes, {
      annotations: {
        "vnd.docker.reference.digest": image.digest,
        "vnd.docker.reference.type": "attestation-manifest",
      },
      platform: { architecture: "unknown", os: "unknown" },
    });
    top.push(image, attestation);
    entries.set(blobPath(config), configBytes);
    entries.set(
      blobPath(imageLayer),
      options.corruptImageLayer === true && architecture === "amd64"
        ? Buffer.concat([compressedLayer.subarray(0, -1), Buffer.from([compressedLayer.at(-1) ^ 0xff])])
        : compressedLayer,
    );
    entries.set(blobPath(image), manifestBytes);
    entries.set(blobPath(attestationConfig), attestationConfigBytes);
    entries.set(blobPath(attestation), attestationBytes);
  }
  const nestedIndexBytes = jsonBytes({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: top,
  });
  const nestedIndex = descriptor(nestedIndexBytes, { mediaType: "application/vnd.oci.image.index.v1+json" });
  entries.set(blobPath(nestedIndex), nestedIndexBytes);
  entries.set("oci-layout", jsonBytes({ imageLayoutVersion: "1.0.0" }));
  entries.set("index.json", jsonBytes({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [nestedIndex],
  }));
  if (options.unreferencedBlob === true) {
    const orphan = Buffer.from("unreferenced\n");
    entries.set(`blobs/sha256/${createHash("sha256").update(orphan).digest("hex")}`, orphan);
  }
  writeTar(path, [["blobs/", null], ["blobs/sha256/", null], ...entries]);
}

function dockerFixture(path, options = {}) {
  const uncompressedLayer = tarBytes([["app.txt", Buffer.from("gauntlet-arm64\n")]]);
  const compressedLayer = gzipSync(uncompressedLayer, { level: 9, mtime: 0 });
  const layer = descriptor(compressedLayer, {
    mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
  });
  const configBytes = jsonBytes({
    architecture: options.wrongArchitecture === true ? "amd64" : "arm64",
    os: "linux",
    config: { Labels: labels() },
    rootfs: {
      type: "layers",
      diff_ids: [options.wrongDiffId === true
        ? `sha256:${"0".repeat(64)}`
        : `sha256:${createHash("sha256").update(uncompressedLayer).digest("hex")}`],
    },
  });
  const config = descriptor(configBytes, {
    mediaType: "application/vnd.docker.container.image.v1+json",
  });
  const imageManifestBytes = jsonBytes({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config,
    layers: [layer],
  });
  const imageManifest = descriptor(imageManifestBytes, {
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    platform: { architecture: "arm64", os: "linux" },
  });
  const layerBytes = options.corruptLayer === true
    ? Buffer.concat([compressedLayer.subarray(0, -1), Buffer.from([compressedLayer.at(-1) ^ 0xff])])
    : compressedLayer;
  writeTar(path, [
    ["blobs/", null],
    ["blobs/sha256/", null],
    [blobPath(imageManifest), imageManifestBytes],
    [blobPath(config), configBytes],
    [blobPath(layer), layerBytes],
    ["index.json", jsonBytes({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [imageManifest],
    })],
    ["manifest.json", jsonBytes([{
      Config: blobPath(config),
      RepoTags: ["gauntlet.local/gauntlet:0.1.0"],
      Layers: [blobPath(layer)],
    }])],
    ["oci-layout", jsonBytes({ imageLayoutVersion: "1.0.0" })],
  ]);
  return Object.freeze({
    configDigest: config.digest,
    manifestDigest: imageManifest.digest,
  });
}

test("plans a local Docker archive and an attested multi-platform OCI archive without publication", () => {
  const outputDirectory = "/tmp/gauntlet-image-stage";
  const plan = createImageExportPlan({
    hostPlatform: "linux/arm64",
    outputDirectory,
    root: ROOT,
    sourceCommit: COMMIT,
    version: "0.1.0",
  });
  assert.deepEqual(plan.map(({ phase }) => phase), ["builder", "docker-archive", "oci-archive"]);
  assert.deepEqual(plan[0], {
    args: ["buildx", "inspect", "--bootstrap"],
    command: "docker",
    phase: "builder",
  });
  const flattened = plan.flatMap(({ args }) => args);
  assert.equal(flattened.includes("--push"), false);
  assert.equal(flattened.includes("push"), false);
  assert.equal(flattened.includes("publish"), false);
  assert.ok(flattened.includes("release-local"));
  assert.ok(flattened.includes("release"));
  assert.equal(flattened.filter((value) => value === `--allow=fs.write=${outputDirectory}`).length, 2);
  assert.ok(flattened.includes("release-local.platform=linux/arm64"));
  assert.ok(flattened.includes("release-local.tags=gauntlet.local/gauntlet:0.1.0"));
  assert.ok(flattened.includes(`release.args.GAUNTLET_REVISION=${COMMIT}`));
  assert.ok(flattened.includes(`release.output=type=oci,dest=${outputDirectory}/gauntlet-0.1.0.oci.tar,oci-artifact=false`));
  assert.ok(flattened.includes(`release-local.output=type=docker,dest=${outputDirectory}/gauntlet-0.1.0.docker.tar,oci-mediatypes=false`));
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(plan.every(Object.isFrozen), true);
});

test("parses required Buildx worker platforms and reports an honest blocker", () => {
  assert.deepEqual(
    parseBuildxPlatforms("Name: builder\nPlatforms: linux/amd64*, linux/arm64, linux/riscv64\n"),
    ["linux/amd64", "linux/arm64", "linux/riscv64"],
  );
  assert.throws(
    () => parseBuildxPlatforms("Name: builder\nPlatforms: linux/arm64*\n", { requireReleasePlatforms: true }),
    /Multi-platform OCI staging is blocked:.*linux\/amd64/,
  );
});

test("the release bake target fixes attestations and platforms while the Dockerfile admits only non-secret OCI metadata", () => {
  const bake = readFileSync(resolve(ROOT, "docker-bake.hcl"), "utf8");
  assert.match(bake, /target\s+"release"[\s\S]*?attest\s*=\s*\[[\s\S]*?type=provenance,mode=max,version=v1[\s\S]*?type=sbom[\s\S]*?\]/);
  assert.ok(
    bake.includes(`type=sbom,generator=docker.io/docker/buildkit-syft-scanner@sha256:${SBOM_GENERATOR_DIGEST}`),
    "BuildKit SBOM generator must be immutable",
  );
  assert.match(bake, /target\s+"release"[\s\S]*?platforms\s*=\s*\["linux\/amd64",\s*"linux\/arm64"\]/);
  assert.doesNotMatch(bake, /(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CREDENTIAL)/i);

  const dockerfile = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
  assert.ok(
    dockerfile.startsWith(`# syntax=docker/dockerfile:1.7@sha256:${DOCKERFILE_FRONTEND_DIGEST}\n`),
    "Dockerfile frontend must be immutable",
  );
  assert.match(dockerfile, /^ARG GAUNTLET_VERSION$/m);
  assert.match(dockerfile, /^ARG GAUNTLET_REVISION$/m);
  for (const label of [
    'org.opencontainers.image.source="https://github.com/8lines/gauntlet"',
    'org.opencontainers.image.version="$GAUNTLET_VERSION"',
    'org.opencontainers.image.revision="$GAUNTLET_REVISION"',
    'org.opencontainers.image.licenses="Apache-2.0"',
  ]) assert.ok(dockerfile.includes(label), label);
});

test("returns attestation metadata only after both archives and both inspectors succeed", async (t) => {
  const outputDirectory = outputSandbox(t);
  const calls = [];
  const inspection = Object.freeze({ platforms: Object.freeze([
    Object.freeze({
      imageDigest: `sha256:${"1".repeat(64)}`,
      platform: "linux/amd64",
      provenance: Object.freeze({
        attestationAuthenticity: "unsigned",
        builderIdentity: "absent",
        builderPlatform: "linux/arm64",
        classification: "buildkit-unsigned-provenance",
        dependencyCompleteness: "incomplete",
        predicateType: "https://slsa.dev/provenance/v1",
        sourceBinding: "unverified-local-context",
      }),
      spdxDocument: Object.freeze({}),
    }),
    Object.freeze({
      imageDigest: `sha256:${"2".repeat(64)}`,
      platform: "linux/arm64",
      provenance: Object.freeze({
        attestationAuthenticity: "unsigned",
        builderIdentity: "absent",
        builderPlatform: "linux/arm64",
        classification: "buildkit-unsigned-provenance",
        dependencyCompleteness: "incomplete",
        predicateType: "https://slsa.dev/provenance/v1",
        sourceBinding: "unverified-local-context",
      }),
      spdxDocument: Object.freeze({}),
    }),
  ]) });
  let dockerInspected = false;
  let ociInspected = false;
  const result = await exportImageAndAttestations({
    outputDirectory,
    root: ROOT,
    sourceCommit: COMMIT,
    version: "0.1.0",
  }, {
    async run(request) {
      calls.push(request.phase);
      if (request.phase === "builder") {
        return { stdout: "Platforms: linux/amd64, linux/arm64\n", stderr: "" };
      }
      const output = request.args.find((value) => value.includes(".output=type="));
      const path = output.slice(output.indexOf("dest=") + 5).split(",")[0];
      writeFileSync(path, `${request.phase}\n`, { mode: 0o600 });
      return { stdout: "", stderr: "" };
    },
    inspectDocker(request) {
      dockerInspected = true;
      assert.equal(readFileSync(request.archivePath, "utf8"), "docker-archive\n");
      return { platform: request.platform, tag: "gauntlet.local/gauntlet:0.1.0" };
    },
    inspectOci(request) {
      ociInspected = true;
      assert.equal(readFileSync(request.archivePath, "utf8"), "oci-archive\n");
      return inspection;
    },
  });
  assert.deepEqual(calls, ["builder", "docker-archive", "oci-archive"]);
  assert.equal(dockerInspected, true);
  assert.equal(ociInspected, true);
  assert.equal(result.inspection, inspection);
  assert.deepEqual(result.artifacts.map(({ kind }) => kind), ["docker", "oci", "provenance"]);
  assert.equal(result.artifacts.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256)), true);
  const provenance = JSON.parse(readFileSync(result.artifacts[2].path, "utf8"));
  assert.equal(provenance.classification, "buildkit-unsigned-provenance");
  assert.equal(provenance.sourceBinding, "unverified-local-context");
  assert.equal(provenance.attestationAuthenticity, "unsigned");
  assert.equal(provenance.sourceCommit, COMMIT);
  assert.ok(provenance.limitations.some((entry) => entry.includes("dependency disclosure is incomplete")));
  assert.equal(provenance.platforms.every(({ dependencyCompleteness }) => dependencyCompleteness === "incomplete"), true);
  assert.deepEqual(provenance.platforms.map(({ platform }) => platform), ["linux/amd64", "linux/arm64"]);
});

test("fails with an explicit blocker before any build when the builder cannot provide both platforms", async (t) => {
  const outputDirectory = outputSandbox(t);
  const calls = [];
  await assert.rejects(exportImageAndAttestations({
    outputDirectory,
    root: ROOT,
    sourceCommit: COMMIT,
    version: "0.1.0",
  }, {
    async run(request) {
      calls.push(request.phase);
      return { stdout: "Platforms: linux/arm64\n", stderr: "" };
    },
    inspectDocker() { throw new Error("must not inspect"); },
    inspectOci() { throw new Error("must not inspect"); },
  }), /Multi-platform OCI staging is blocked:.*linux\/amd64/);
  assert.deepEqual(calls, ["builder"]);
});

test("fails before invoking Docker when the frontend or SBOM generator is mutable", async (t) => {
  const outputDirectory = outputSandbox(t);
  const root = resolve(outputDirectory, "..", "repository");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  writeFileSync(resolve(root, "docker-bake.hcl"), `
target "release" {
  attest = ["type=provenance,mode=max,version=v1", "type=sbom"]
}
`, { mode: 0o600 });
  writeFileSync(resolve(root, "Dockerfile"), "# syntax=docker/dockerfile:1.7\n", { mode: 0o600 });
  let calls = 0;
  await assert.rejects(exportImageAndAttestations({
    outputDirectory,
    root,
    sourceCommit: COMMIT,
    version: "0.1.0",
  }, {
    async run() {
      calls += 1;
      return { stdout: "Platforms: linux/amd64, linux/arm64\n", stderr: "" };
    },
    inspectDocker() { return {}; },
    inspectOci() { return {}; },
  }), /Image staging failed closed/);
  assert.equal(calls, 0);
});

test("rejects OCI image manifests that omit their filesystem layers", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "empty-layers.oci.tar");
  ociFixture(ociPath, { emptyImageLayers: true });
  assert.throws(
    () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("rejects shape-free SLSA predicates instead of treating their name as provenance", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "shape-free-provenance.oci.tar");
  ociFixture(ociPath, { invalidProvenance: true });
  assert.throws(
    () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("accepts current BuildKit in-toto Statement v1 and rejects unknown statement types", (t) => {
  const outputDirectory = outputSandbox(t);
  const currentPath = resolve(outputDirectory, "statement-v1.oci.tar");
  ociFixture(currentPath, { statementType: "https://in-toto.io/Statement/v1" });
  const inspection = inspectOciArchive({ archivePath: currentPath, sourceCommit: COMMIT, version: "0.1.0" });
  assert.deepEqual(inspection.platforms.map(({ platform }) => platform), ["linux/amd64", "linux/arm64"]);

  const unknownPath = resolve(outputDirectory, "statement-unknown.oci.tar");
  ociFixture(unknownPath, { statementType: "https://in-toto.io/Statement/v2" });
  assert.throws(
    () => inspectOciArchive({ archivePath: unknownPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("requires SLSA v1 run metadata and records incomplete BuildKit dependency disclosure", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "missing-run-metadata.oci.tar");
  ociFixture(ociPath, {
    provenanceMutation(predicate) { delete predicate.runDetails.metadata; },
  });
  assert.throws(
    () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("requires the BuildKit SLSA v1 build request, exact release args, builder platform, and immutable dependencies", (t) => {
  const outputDirectory = outputSandbox(t);
  const mutations = [
    (predicate) => { predicate.buildDefinition.buildType = "https://example.invalid/build"; },
    (predicate) => { predicate.buildDefinition.externalParameters.configSource.path = "Otherfile"; },
    (predicate) => { predicate.buildDefinition.externalParameters.request.frontend = "dockerfile.v0"; },
    (predicate) => { predicate.buildDefinition.externalParameters.request.args.target = "build"; },
    (predicate) => { predicate.buildDefinition.externalParameters.request.args["build-arg:GAUNTLET_VERSION"] = "9.9.9"; },
    (predicate) => { predicate.buildDefinition.externalParameters.request.args["build-arg:GAUNTLET_REVISION"] = "f".repeat(40); },
    (predicate) => { predicate.buildDefinition.internalParameters.builderPlatform = "darwin/arm64"; },
    (predicate) => { predicate.buildDefinition.resolvedDependencies[0].digest.sha256 = "mutable"; },
  ];
  for (const [index, provenanceMutation] of mutations.entries()) {
    const ociPath = resolve(outputDirectory, `invalid-provenance-${index}.oci.tar`);
    ociFixture(ociPath, { provenanceMutation });
    assert.throws(
      () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
      /Image staging failed closed/,
    );
  }
});

test("binds both attestations to the exact release image name, version, platform, and digest", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "wrong-subject.oci.tar");
  ociFixture(ociPath, { wrongSubjectName: true });
  assert.throws(
    () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("keeps a nonempty BuildKit builder id self-asserted and the local source unverified", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "self-asserted-builder.oci.tar");
  ociFixture(ociPath, { builderId: "urn:example:local-builder" });
  const inspection = inspectOciArchive({
    archivePath: ociPath,
    sourceCommit: COMMIT,
    version: "0.1.0",
  });
  for (const { provenance } of inspection.platforms) {
    assert.equal(provenance.builderIdentity, "self-asserted");
    assert.equal(provenance.attestationAuthenticity, "unsigned");
    assert.equal(provenance.sourceBinding, "unverified-local-context");
  }
});

test("traverses OCI filesystem layer descriptors and rejects altered CAS members", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "corrupt-layer.oci.tar");
  ociFixture(ociPath, { corruptImageLayer: true });
  assert.throws(
    () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("verifies OCI filesystem layers against the image config diff IDs", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "wrong-diff-id.oci.tar");
  ociFixture(ociPath, { wrongDiffId: true });
  assert.throws(
    () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("rejects unreferenced OCI CAS blobs after traversing the complete descriptor graph", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "orphan-blob.oci.tar");
  ociFixture(ociPath, { unreferencedBlob: true });
  assert.throws(
    () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("rejects bytes hidden after the tar end marker", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "hidden-trailer.oci.tar");
  ociFixture(ociPath);
  writeFileSync(ociPath, Buffer.concat([readFileSync(ociPath), Buffer.from("hidden")]), { mode: 0o600 });
  assert.throws(
    () => inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" }),
    /Image staging failed closed/,
  );
});

test("verifies every Docker archive layer against its descriptor and config diff ID", (t) => {
  const outputDirectory = outputSandbox(t);
  const dockerPath = resolve(outputDirectory, "corrupt-layer.docker.tar");
  dockerFixture(dockerPath, { corruptLayer: true });
  assert.throws(
    () => inspectDockerArchive({
      archivePath: dockerPath,
      platform: "linux/arm64",
      sourceCommit: COMMIT,
      version: "0.1.0",
    }),
    /Image staging failed closed/,
  );
});

test("rejects Docker config platform and diff ID mismatches", (t) => {
  const outputDirectory = outputSandbox(t);
  for (const [name, options] of [
    ["platform", { wrongArchitecture: true }],
    ["diff-id", { wrongDiffId: true }],
  ]) {
    const dockerPath = resolve(outputDirectory, `${name}.docker.tar`);
    dockerFixture(dockerPath, options);
    assert.throws(
      () => inspectDockerArchive({
        archivePath: dockerPath,
        platform: "linux/arm64",
        sourceCommit: COMMIT,
        version: "0.1.0",
      }),
      /Image staging failed closed/,
    );
  }
});

test("exposes only the Docker config and manifest digests as frozen runtime image identities", (t) => {
  const outputDirectory = outputSandbox(t);
  const dockerPath = resolve(outputDirectory, "gauntlet-0.1.0.docker.tar");
  const { configDigest, manifestDigest } = dockerFixture(dockerPath);
  const inspection = inspectDockerArchive({
    archivePath: dockerPath,
    platform: "linux/arm64",
    sourceCommit: COMMIT,
    version: "0.1.0",
  });
  assert.deepEqual(inspection, {
    platform: "linux/arm64",
    runtimeImageIds: [configDigest, manifestDigest],
    tag: "gauntlet.local/gauntlet:0.1.0",
  });
  assert.equal(Object.isFrozen(inspection), true);
  assert.equal(Object.isFrozen(inspection.runtimeImageIds), true);
});

test("validates per-platform in-toto SPDX plus SLSA v1 attestations from real tar bytes", (t) => {
  const outputDirectory = outputSandbox(t);
  const ociPath = resolve(outputDirectory, "gauntlet-0.1.0.oci.tar");
  ociFixture(ociPath);
  const inspection = inspectOciArchive({ archivePath: ociPath, sourceCommit: COMMIT, version: "0.1.0" });
  assert.deepEqual(inspection.platforms.map(({ platform }) => platform), ["linux/amd64", "linux/arm64"]);
  for (const platform of inspection.platforms) {
    assert.equal(platform.spdxPredicateType, "https://spdx.dev/Document");
    assert.equal(platform.provenancePredicateType, "https://slsa.dev/provenance/v1");
    assert.equal(platform.spdxDocument.spdxVersion, "SPDX-2.3");
    assert.deepEqual(platform.provenance, {
      attestationAuthenticity: "unsigned",
      builderIdentity: "absent",
      builderPlatform: "linux/arm64",
      classification: "buildkit-unsigned-provenance",
      dependencyCompleteness: "incomplete",
      predicateType: "https://slsa.dev/provenance/v1",
      sourceBinding: "unverified-local-context",
    });
  }
});
