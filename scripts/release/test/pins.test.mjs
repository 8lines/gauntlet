import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { findUnboundPins, isScannedPath, listTrackedFiles } from "../pins.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

function scratch(t, files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-pins-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

test("every tracked pin of a released coordinate is a release version slot", () => {
  assert.deepEqual(findUnboundPins(ROOT, listTrackedFiles(ROOT)), []);
});

test("reports each unslotted coordinate with its line, in every published form", (t) => {
  const root = scratch(t, {
    "docs/guide.md": [
      "Intro.",
      "pnpm dlx --package @8lines/gauntlet-conformance-runner@0.1.1 gauntlet-conformance",
      "composer require 8lines/gauntlet-php-core:0.1.1",
      '"8lines/gauntlet-symfony-bundle": "^0.1.1"',
      'implementation("dev.eightlines.gauntlet:core:0.1.1")',
      "docker pull ghcr.io/8lines/gauntlet:0.1.1",
      "helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.1.1",
      "helm template gauntlet ./gauntlet-0.1.1.tgz",
      "tar -xzf gauntlet-skills-0.1.1.tgz",
      "file:/tmp/8lines-gauntlet-protocol-0.1.1.tgz",
      "",
    ].join("\n"),
  });
  assert.deepEqual(findUnboundPins(root, ["docs/guide.md"]), [
    "docs/guide.md:2: @8lines/gauntlet-conformance-runner@0.1.1 is not a release version slot",
    "docs/guide.md:3: 8lines/gauntlet-php-core:0.1.1 is not a release version slot",
    'docs/guide.md:4: 8lines/gauntlet-symfony-bundle": "^0.1.1 is not a release version slot',
    "docs/guide.md:5: dev.eightlines.gauntlet:core:0.1.1 is not a release version slot",
    "docs/guide.md:6: ghcr.io/8lines/gauntlet:0.1.1 is not a release version slot",
    "docs/guide.md:7: charts/gauntlet --version 0.1.1 is not a release version slot",
    "docs/guide.md:8: gauntlet-0.1.1.tgz is not a release version slot",
    "docs/guide.md:9: gauntlet-skills-0.1.1 is not a release version slot",
    "docs/guide.md:10: 8lines-gauntlet-protocol-0.1.1.tgz is not a release version slot",
  ]);
});

test("a slot-covered pin passes, an extra pin in a slot file and a malformed slot file are reported", (t) => {
  const root = scratch(t, {
    "docs/integrations/widget.md": "npm install @8lines/gauntlet-widget@0.1.8\n",
    "conformance/runner/README.md": "pnpm dlx --package @8lines/gauntlet-conformance-runner@0.1.8 gauntlet-conformance\n",
  });
  assert.deepEqual(findUnboundPins(root, ["docs/integrations/widget.md"]), []);
  writeFileSync(join(root, "docs/integrations/widget.md"), "npm install @8lines/gauntlet-widget@0.1.8\nSee `@8lines/gauntlet-widget@0.1.7`.\n");
  assert.deepEqual(findUnboundPins(root, ["docs/integrations/widget.md"]), [
    "docs/integrations/widget.md:2: @8lines/gauntlet-widget@0.1.7 is not a release version slot",
  ]);
  assert.deepEqual(findUnboundPins(root, ["conformance/runner/README.md"]), [
    "conformance/runner/README.md: release references are missing or malformed",
  ]);
});

test("history, evaluation records, tests, locks and structured manifests are not scanned", () => {
  for (const path of [
    "CHANGELOG.md", "packages/protocol/CHANGELOG.md", "docs/superpowers/plans/x.md", "skill-evals/a/results/b.jsonl",
    ".changes/x.md", "scripts/release/test/x.test.mjs", "tests/consumers/php-core/composer.json", "pnpm-lock.yaml",
    "examples/symfony/composer.lock", "deploy/compose/.env.example", "examples/symfony/composer.json", "VERSION",
  ]) assert.equal(isScannedPath(path), false, path);
  for (const path of ["README.md", "docs/releases/installing-packages.md", "deploy/helm/README.md"]) {
    assert.equal(isScannedPath(path), true, path);
  }
});
