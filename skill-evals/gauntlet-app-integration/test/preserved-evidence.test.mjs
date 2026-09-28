import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const evaluationRoot = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(evaluationRoot, "evidence");
const sampleNames = [
  "baseline-valid-compose.json",
  "baseline-valid-symfony.json",
  "forward-node-compose.json",
  "guided-valid-compose.json",
  "guided-valid-symfony.json",
];

const exactKeys = (value, keys, label) => {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} must be closed`);
};

test("preserves closed materialized receipts from every positive application evaluation", async () => {
  assert.deepEqual((await readdir(evidenceRoot)).sort(), ["evaluation-environment.json", ...sampleNames].sort());
  for (const name of sampleNames) {
    const source = await readFile(resolve(evidenceRoot, name), "utf8");
    assert.equal(source.includes("synthetic-stable-idempotency-secret"), false, `${name} leaked the fixture secret`);
    const receipt = JSON.parse(source);
    exactKeys(receipt, [
      "scope", "customerDeploymentVerified", "receiptMode", "minimumProbeRuns", "selfHashMeaning",
      "requiredReceiptDigests", "observations", "observationHistory", "probeRuns", "commands",
    ], name);
    assert.equal(receipt.scope, "synthetic-ephemeral-loopback-http");
    assert.equal(receipt.customerDeploymentVerified, false);
    assert.equal(receipt.receiptMode, "observations-only");
    assert.equal(receipt.selfHashMeaning, "integrity-only-not-trust-or-attestation");
    assert.equal(Object.keys(receipt.observations).length > 0, true);
    for (const [probe, observation] of Object.entries(receipt.observations)) {
      assert.equal(observation.passed, true, `${name}:${probe} did not pass`);
      assert.equal(observation.scope, receipt.scope);
      assert.match(observation.receiptSha256, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(receipt.probeRuns[probe] >= receipt.minimumProbeRuns, true);
      for (const digest of receipt.requiredReceiptDigests) {
        assert.match(observation[digest], /^sha256:[0-9a-f]{64}$/u, `${name}:${probe}:${digest}`);
      }
    }
  }
});

test("records the local evaluator toolchains without claiming attestation", async () => {
  const environment = JSON.parse(await readFile(resolve(evidenceRoot, "evaluation-environment.json"), "utf8"));
  exactKeys(environment, [
    "schemaVersion", "scope", "attested", "sourceCommitLocator", "toolchains", "containerImages", "limitations",
  ], "evaluation environment");
  assert.equal(environment.schemaVersion, 1);
  assert.equal(environment.scope, "local-synthetic-evaluation-environment");
  assert.equal(environment.attested, false);
  assert.match(environment.sourceCommitLocator, /^[0-9a-f]{40}$/u);
  assert.deepEqual(environment.toolchains.map(({ name }) => name), ["docker-cli", "git", "node", "pnpm", "tar"]);
  for (const toolchain of environment.toolchains) {
    exactKeys(toolchain, ["name", "version", "sha256"], `toolchain ${toolchain.name}`);
    assert.match(toolchain.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.deepEqual(environment.containerImages, [
    "composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584",
    "php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4",
  ]);
  assert.equal(environment.limitations.some((value) => value.includes("not external attestation")), true);
});
