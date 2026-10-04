import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { readUnitVersion } from "../../release/release-model.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const versionPattern = (unit) => readUnitVersion(ROOT, unit).replaceAll(".", "\\.");

test("package installation guide pins every official public destination and avoids literal credentials", () => {
  const source = read("docs/releases/installing-packages.md");
  assert.match(source, /https:\/\/registry\.npmjs\.org/u);
  assert.doesNotMatch(source, /npm\.pkg\.github\.com/u);
  assert.match(source, /Packagist/u);
  assert.match(source, new RegExp(`composer require 8lines/gauntlet-symfony-bundle:${versionPattern("symfony-bundle")}`, "u"));
  assert.doesNotMatch(source, /"type": "vcs"|COMPOSER_AUTH is required/u);
  assert.match(source, /https:\/\/maven\.pkg\.github\.com\/8lines\/gauntlet/u);
  assert.match(source, /read:packages/u);
  assert.match(source, /8lines\/gauntlet-php-core/u);
  assert.match(source, /8lines\/gauntlet-symfony-bundle/u);
  assert.match(source, /ghcr\.io\/8lines\/gauntlet/u);
  assert.match(source, /oci:\/\/ghcr\.io\/8lines\/charts\/gauntlet/u);
  assert.match(source, /authentication/u);
  assert.match(source, /--password-stdin/u);
  assert.doesNotMatch(source, /(?:password|token)\s*[:=]\s*[A-Za-z0-9_-]{20,}/iu);
});

test("no documentation links to the retired private registry guide", () => {
  for (const path of ["README.md", "docs/README.md", "docs/integrations/index.md", "docs/integrations/widget.md",
    "packages/typescript/core/README.md", "docs/releases/releasing.md", "docs/releases/upgrading.md"]) {
    assert.doesNotMatch(read(path), /private-registry-access/u, path);
  }
});

test("release runbook requires a clean rehearsal and equality-checked retry", () => {
  const source = read("docs/releases/releasing.md");
  assert.match(source, /pnpm release:dry-run/u);
  assert.match(source, /pnpm exec playwright install chromium/u);
  assert.match(source, /PLAYWRIGHT_BROWSER_CHANNEL=(?:chrome|chromium)/u);
  assert.match(source, /node scripts\/release\/verify-inventory\.mjs --release-root/u);
  assert.match(source, /pnpm release:discard-staged/u);
  assert.match(source, /closed per-plan inventory/u);
  assert.doesNotMatch(source, /closed 1[89]-artifact inventory/u);
  assert.match(source, /pnpm release:dry-run \[--plan \.release\/plan\.json\] \[--release-set ID\]/u);
  assert.match(source, /pnpm release:discard-staged --release-root \.artifacts\/release\/<set-id>/u);
  assert.match(source, /host-platform native\s+image/iu);
  assert.match(source, /multi-platform OCI archive/iu);
  assert.match(source, /Helm chart digest/iu);
  assert.match(source, /pnpm release:plan/u);
  assert.match(source, /git fetch --tags origin && pnpm release:tag/u);
  assert.match(source, /git push origin refs\/tags\/release-YYYY-MM-DD\.N/u);
  assert.match(source, /Only `release-\*` tags start the release workflow; unit tags never do\./u);
  assert.doesNotMatch(source, /git tag -a v|v\*\.\*\.\*/u);
  assert.match(source, /commit contained in `main`/u);
  assert.match(source, /all artifacts are already\s+byte\/commit-identical/isu);
  assert.match(source, /Do not manually fill a partially published release/u);
  assert.match(source, /Never delete or rewrite|Never delete|Do not retag or\s+overwrite/isu);
});

test("release runbook describes per-unit publication, reruns and recovery without lockstep leftovers", () => {
  const source = read("docs/releases/releasing.md");
  assert.doesNotMatch(source, /npm\/Composer\/Maven manifests[^.]*all agree/su);
  assert.doesNotMatch(source, /overwrite `0\.1\.8`/u);
  assert.match(source, /git fetch --tags origin\npnpm release:plan\n/u);
  assert.match(source, /tagged and\s+released right after its own registry artifacts/u);
  assert.match(source, /Publish and release package units/u);
  const failure = source.slice(source.indexOf("## Failure handling"));
  assert.match(failure, /Re-running the same release-set tag/u);
  assert.match(failure, /new version,\s+a\s+new release plan and a new\s+release-set tag/u);
  assert.match(failure, /stale draft/u);
  assert.match(failure, /delete/u);
  const verify = source.slice(source.indexOf("## Verify the published release"), source.indexOf("## Failure handling"));
  assert.match(verify, /For each released unit/u);
  assert.match(verify, /A correction requires a new version of that\s+unit/u);
});

test("release runbook covers change files, preparation and its prerequisites", () => {
  const source = read("docs/releases/releasing.md");
  assert.match(source, /## Change files/u);
  assert.match(source, /pnpm release:changes --check/u);
  assert.match(source, /`changes` check/u);
  assert.match(source, /## Prepare a release/u);
  assert.match(source, /git fetch --tags origin\ngit switch -c release\/YYYY-MM-DD\npnpm install --frozen-lockfile --package-import-method=copy\npnpm release:prepare\n/u);
  assert.match(source, /Updated `<unit>` to X\.Y\.Z\./u);
  assert.match(source, /composer:2/u);
  assert.match(source, /Re-binding log/u);
  assert.match(source, /docs\/reference\/compatibility\.md/u);
  assert.match(source, /restores every tracked file/u);
  assert.match(source, /pnpm 11\.24/u);
  assert.match(source, /Run `pnpm build` before any dry run/u);
  assert.match(source, /builder that can export images/u);
  assert.match(source, /PLAYWRIGHT_BROWSER_CHANNEL=chromium pnpm release:dry-run --plan \.release\/plan\.json/u);
  assert.match(source, /compatibility line/u);
});

test("the upgrade guide no longer names a fixed release", () => {
  assert.doesNotMatch(read("docs/releases/upgrading.md"), /exact `0\.1\.1` artifacts/u);
  assert.match(read("docs/releases/upgrading.md"), /installing-packages\.md#current-versions/u);
});

test("upgrade and rollback retain immutable identities and repeat safety checks", () => {
  const upgrade = read("docs/releases/upgrading.md");
  const rollback = read("docs/releases/rollback.md");
  assert.match(upgrade, /preceding artifact identity/iu);
  assert.match(upgrade, /public ingress\s+still denies `\/_gauntlet\/v1`/isu);
  assert.match(upgrade, /Do not scale above one replica/u);
  assert.match(rollback, /preceding immutable\s+image digest/isu);
  assert.match(rollback, /Helm rollback guidance/u);
  assert.match(rollback, /Do not delete the failed release tag or overwrite a registry version/u);
});

test("AI skill guide documents both safe installation paths and their boundaries", () => {
  const source = read("docs/ai-skills.md");
  assert.match(source, /scripts\/skills\/install\.mjs --destination/u);
  assert.match(source, new RegExp(`gauntlet-skills-${versionPattern("skills")}\\.tgz`, "u"));
  assert.match(source, /exactly one\s+skill per invocation/iu);
  assert.match(source, /\$gauntlet-app-integration/u);
  assert.match(source, /\$gauntlet-extension-authoring/u);
  assert.match(source, /production identity is\s+ambiguous/iu);
  assert.match(source, /does not.*network exposure/isu);
  assert.match(source, /pnpm skills:test-install/u);
  assert.match(source, /pnpm skills:test-evals/u);
  assert.match(source, /pnpm skills:validate/u);
  assert.match(source, /not model-provider attestation/iu);
  assert.match(source, /not.*evidence from a customer\s+deployment/isu);
});
