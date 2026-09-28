import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { packageHelmChart } from "../stage-helm.mjs";
import { generateSpdxSbom } from "../stage-sbom.mjs";

function sandbox(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-stage-helper-test-")));
  chmodSync(root, 0o700);
  const repository = resolve(root, "repository");
  const output = resolve(root, "output");
  for (const path of [repository, output]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  writeFileSync(resolve(repository, "VERSION"), "0.1.0\n", { mode: 0o644 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { output, repository, root };
}

function validSpdxDocument() {
  return {
    packages: [
      {
        versionInfo: "0.1.0",
        name: "@8lines/gauntlet-server",
        SPDXID: "SPDXRef-Package-gauntlet-server",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
      },
      {
        name: "sbom",
        SPDXID: "SPDXRef-DocumentRoot-Directory-sbom",
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
    creationInfo: { creators: ["Tool: buildkit-syft-scanner"], created: "2026-01-01T00:00:00Z" },
    documentNamespace: "https://example.invalid/spdx/gauntlet",
    name: "sbom",
    SPDXID: "SPDXRef-DOCUMENT",
    dataLicense: "CC0-1.0",
    spdxVersion: "SPDX-2.3",
  };
}

test("wraps the pinned chart packager and returns one verified ordinary artifact", (t) => {
  const files = sandbox(t);
  let request;
  const receipt = packageHelmChart({ root: files.repository, outputDirectory: files.output }, {
    packageChart(options) {
      request = options;
      const archivePath = resolve(options.destinationDirectory, "gauntlet-0.1.0.tgz");
      writeFileSync(archivePath, "chart\n", { mode: 0o600 });
      return {
        archivePath,
        cleanupPending: Object.freeze([]),
        sha256: "ignored-caller-digest",
        size: 6,
        version: "0.1.0",
      };
    },
  });
  assert.deepEqual(request, {
    destinationDirectory: files.output,
    sourceRepositoryRoot: files.repository,
  });
  assert.equal(receipt.kind, "helm");
  assert.equal(receipt.name, "gauntlet");
  assert.equal(receipt.version, "0.1.0");
  assert.equal(receipt.path, resolve(files.output, "gauntlet-0.1.0.tgz"));
  assert.match(receipt.sha256, /^[0-9a-f]{64}$/);
  assert.equal(statSync(receipt.path).isFile(), true);
});

test("writes an exactly platform-bound attested SPDX predicate as canonical JSON", (t) => {
  const files = sandbox(t);
  const document = validSpdxDocument();
  const outputPath = resolve(files.output, "gauntlet.spdx.json");
  const receipt = generateSpdxSbom({
    imageInspection: {
      platforms: [
        {
          imageDigest: `sha256:${"1".repeat(64)}`,
          platform: "linux/amd64",
          spdxDocument: { ...document, documentNamespace: "https://example.invalid/spdx/amd64" },
        },
        { imageDigest: `sha256:${"2".repeat(64)}`, platform: "linux/arm64", spdxDocument: document },
      ],
    },
    outputPath,
    platform: "linux/arm64",
    version: "0.1.0",
  });
  assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), document);
  assert.equal(readFileSync(outputPath, "utf8").endsWith("\n"), true);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.deepEqual(receipt, {
    kind: "sbom",
    imageDigest: `sha256:${"2".repeat(64)}`,
    name: "ghcr.io/8lines/gauntlet@linux/arm64",
    path: outputPath,
    platform: "linux/arm64",
    sha256: receipt.sha256,
    validation: "spdx-2.3-structural-and-release-binding",
    version: "0.1.0",
  });
  assert.match(receipt.sha256, /^[0-9a-f]{64}$/);
});

test("rejects SPDX graphs with dangling relationships or the wrong release package version", (t) => {
  const files = sandbox(t);
  const base = {
    outputPath: resolve(files.output, "invalid.spdx.json"),
    platform: "linux/arm64",
    version: "0.1.0",
  };
  for (const mutate of [
    (document) => { document.relationships[1].relatedSpdxElement = "SPDXRef-Missing"; },
    (document) => { document.packages[0].versionInfo = "9.9.9"; },
  ]) {
    const document = validSpdxDocument();
    mutate(document);
    assert.throws(
      () => generateSpdxSbom({
        ...base,
        imageInspection: {
          platforms: [{ imageDigest: `sha256:${"2".repeat(64)}`, platform: "linux/arm64", spdxDocument: document }],
        },
      }),
      /Attested SPDX SBOM staging failed closed/,
    );
  }
});

test("refuses to invent an SBOM when the requested attestation is absent or malformed", (t) => {
  const files = sandbox(t);
  const base = {
    outputPath: resolve(files.output, "gauntlet.spdx.json"),
    platform: "linux/arm64",
    version: "0.1.0",
  };
  assert.throws(
    () => generateSpdxSbom({ ...base, imageInspection: { platforms: [] } }),
    /Attested SPDX SBOM staging failed closed/,
  );
  assert.throws(
    () => generateSpdxSbom({
      ...base,
      imageInspection: { platforms: [{ platform: "linux/arm64", spdxDocument: { spdxVersion: "SPDX-2.3" } }] },
    }),
    /Attested SPDX SBOM staging failed closed/,
  );
});
