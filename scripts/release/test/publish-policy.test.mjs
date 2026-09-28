import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parseDocument } from "yaml";

const ROOT = resolve(import.meta.dirname, "../../..");
const VERIFICATION_GATES = Object.freeze([
  "node",
  "php",
  "java",
  "conformance",
  "deployment",
  "security",
  "release-metadata",
]);
const ACTION_SHA = /^[^@\s]+@[0-9a-f]{40}$/;
const LINUX_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const BLACKSMITH_CHECKOUT = /^useblacksmith\/checkout@[0-9a-f]{40}$/u;

function releaseWorkflow() {
  const source = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return { source, workflow: document.toJS({ maxAliasCount: 0 }) };
}

test("publication runs only for version tags with bounded permissions", () => {
  const { source, workflow } = releaseWorkflow();
  assert.equal(workflow.name, "release");
  assert.deepEqual(workflow.on, { push: { tags: ["v*.*.*"] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(source, /pull_request|pull_request_target/u);
  assert.doesNotMatch(source, /\blatest\b/u);

  const publish = workflow.jobs.publish;
  assert.deepEqual([...publish.needs].sort(), [...VERIFICATION_GATES].sort());
  assert.equal(publish.environment, "release");
  assert.deepEqual(publish.permissions, { contents: "write", packages: "write", "id-token": "write" });
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (jobName !== "publish") assert.equal(job.permissions?.["id-token"], undefined, `${jobName} OIDC token`);
  }
  assert.equal(publish["runs-on"], LINUX_RUNNER);
  assert.equal(Number.isInteger(publish["timeout-minutes"]), true);
  assert.equal(publish["timeout-minutes"] > 0 && publish["timeout-minutes"] <= 90, true);
  for (const jobName of ["java", "publish"]) {
    const java = workflow.jobs[jobName].steps.find(({ uses }) => uses?.startsWith("actions/setup-java@"));
    assert.notEqual(java, undefined, `${jobName} Java toolchain`);
    assert.equal(java.with.distribution, "temurin");
    assert.equal(String(java.with["java-version"]), "21");
  }

  assert.doesNotMatch(source, /useblacksmith\/setup-docker-builder/u);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["runs-on"], LINUX_RUNNER, `${jobName} runner`);
    assert.equal(Number.isInteger(job["timeout-minutes"]), true, `${jobName} timeout`);
    const checkouts = job.steps.filter(({ uses }) => typeof uses === "string" && /^[^@]+\/checkout@/u.test(uses));
    assert.equal(checkouts.length, 1, `${jobName} single checkout`);
    assert.match(checkouts[0].uses, BLACKSMITH_CHECKOUT, `${jobName} checkout action`);
    assert.equal(checkouts[0].with?.["persist-credentials"], false, `${jobName} checkout credentials`);
    for (const step of job.steps) {
      if (step.uses !== undefined) assert.match(step.uses, ACTION_SHA, `${jobName}: ${step.uses}`);
    }
  }
});

test("all verification gates complete before the first sequential mutation", () => {
  const { workflow } = releaseWorkflow();
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...VERIFICATION_GATES, "publish"].sort());
  assert.equal(workflow.jobs.node.strategy["fail-fast"], false);
  assert.deepEqual(workflow.jobs.node.strategy.matrix.node, ["24.20.0", "25.9.0", "26.8.1"]);
  const publish = workflow.jobs.publish;
  const steps = publish.steps;
  const commands = steps.map(({ run }) => run ?? "");
  const preflightIndex = steps.findIndex(({ name }) => name === "Check every remote destination");
  const firstMutationIndex = steps.findIndex(({ name }) => name === "Publish commit-tagged image with attestations");
  assert.notEqual(preflightIndex, -1);
  assert.notEqual(firstMutationIndex, -1);
  assert.equal(preflightIndex < firstMutationIndex, true);
  assert.match(commands[preflightIndex], /check-published\.mjs/u);
  assert.match(commands.slice(0, firstMutationIndex).join("\n"), /release:dry-run/u);
  assert.doesNotMatch(commands.slice(0, firstMutationIndex).join("\n"), /git fetch/u);
  assert.match(commands.slice(0, firstMutationIndex).join("\n"), /origin\/main/u);

  const orderedMutations = [
    "Publish commit-tagged image with attestations",
    "Verify pushed image and attestations",
    "Promote image digest to the semantic tag",
    "Publish Helm chart",
    "Publish staged npm packages",
    "Publish staged Maven packages",
    "Publish Composer split repositories",
    "Verify every published artifact",
    "Write publication receipt and checksums",
    "Create draft GitHub Release",
    "Verify draft GitHub Release assets byte-for-byte",
    "Publish verified GitHub Release",
    "Verify immutable GitHub Release assets byte-for-byte",
  ];
  assert.deepEqual(
    steps.filter(({ name }) => orderedMutations.includes(name)).map(({ name }) => name),
    orderedMutations,
  );
  const composerPublication = steps.find(({ name }) => name === "Publish Composer split repositories");
  assert.match(composerPublication.run, /publish-composer\.mjs[\s\S]*--source-commit "\$GITHUB_SHA"/u);
  const imageVerification = steps.find(({ name }) => name === "Verify pushed image and attestations");
  const imagePublication = steps.find(({ name }) => name === "Publish commit-tagged image with attestations");
  assert.match(
    imagePublication.run,
    /quay\.io\/skopeo\/stable:v1\.20\.0@sha256:47853bb9fb24202af9110531ebd6e43c5f97701254ca290596640290d17942f4/u,
  );
  assert.match(imagePublication.run, /oci-archive:/u);
  assert.match(imagePublication.run, /--preserve-digests/u);
  assert.match(imagePublication.run, /--digestfile/u);
  assert.doesNotMatch(imagePublication.run, /docker buildx bake/u);
  assert.match(
    imageVerification.run,
    /aquasec\/trivy:0\.66\.0@sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e/u,
  );
  assert.match(imageVerification.run, /for PLATFORM in linux\/amd64 linux\/arm64/u);
  assert.match(imageVerification.run, /--platform "\$PLATFORM"/u);
  assert.equal(steps.indexOf(imageVerification) < steps.findIndex(({ name }) => name === "Promote image digest to the semantic tag"), true);
  const createRelease = steps.find(({ name }) => name === "Create draft GitHub Release");
  assert.match(createRelease.run, /gh release create/u);
  assert.match(createRelease.run, /--draft/u);
  assert.match(createRelease.run, /compose\/gauntlet-compose-\$VERSION\.tar\.gz/u);
  assert.match(createRelease.run, /gauntlet-linux-amd64\.spdx\.json/u);
  assert.match(createRelease.run, /gauntlet-linux-arm64\.spdx\.json/u);
  assert.match(createRelease.run, /gauntlet-\$VERSION\.provenance\.json/u);
  assert.match(createRelease.run, /skills\/gauntlet-skills-\$VERSION\.tgz/u);
  assert.doesNotMatch(createRelease.run, /sbom\/gauntlet\.spdx\.json/u);
  const draftVerification = steps.find(({ name }) => name === "Verify draft GitHub Release assets byte-for-byte");
  assert.match(draftVerification.run, /--require-draft-identical/u);
  assert.equal(draftVerification.env.GAUNTLET_USE_REMOTE_RECEIPT, undefined);
  const publishRelease = steps.find(({ name }) => name === "Publish verified GitHub Release");
  assert.match(publishRelease.run, /gh release edit/u);
  assert.match(publishRelease.run, /--draft=false/u);
  assert.equal(steps.indexOf(createRelease) < steps.indexOf(draftVerification), true);
  assert.equal(steps.indexOf(draftVerification) < steps.indexOf(publishRelease), true);
  assert.equal(steps.at(-1).name, "Verify immutable GitHub Release assets byte-for-byte");
  assert.match(steps.at(-1).run, /check-published\.mjs/u);
  assert.match(steps.at(-1).run, /--require-identical/u);
  assert.equal(steps.at(-1).env.GAUNTLET_USE_REMOTE_RECEIPT, "true");
  assert.equal(steps.at(-1).env.GAUNTLET_EXPECTED_CHART_DIGEST, "${{ steps.chart.outputs.digest }}");
  assert.equal(steps[preflightIndex].id, "preflight");
  assert.match(steps[preflightIndex].run, /GITHUB_OUTPUT/u);
  for (const step of steps.slice(firstMutationIndex)) {
    assert.equal(step.if, "steps.preflight.outputs.state == 'clean'", `${step.name} rerun guard`);
  }
});

test("a failed draft asset upload cannot reach the public release mutation", () => {
  const { workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const createIndex = steps.findIndex(({ name }) => name === "Create draft GitHub Release");
  const publicIndex = steps.findIndex(({ name }) => name === "Publish verified GitHub Release");
  assert.notEqual(createIndex, -1);
  assert.notEqual(publicIndex, -1);
  assert.equal(createIndex < publicIndex, true);
  assert.equal(steps[createIndex]["continue-on-error"], undefined);
  assert.equal(steps[publicIndex].if, "steps.preflight.outputs.state == 'clean'");
  assert.doesNotMatch(steps[createIndex].run, /--draft=false/u);
  assert.doesNotMatch(steps.slice(createIndex + 1, publicIndex).map(({ run }) => run ?? "").join("\n"), /gh release edit/u);
});

test("release security scans the staged image and dry-runs install Chromium", () => {
  const { workflow } = releaseWorkflow();
  const securityCommands = workflow.jobs.security.steps.map(({ run }) => run ?? "").join("\n");
  assert.match(securityCommands, /release:stage/u);
  assert.match(
    securityCommands,
    /release:security --image-archive "\.artifacts\/release\/\$VERSION\/image\/gauntlet-\$VERSION\.docker\.tar"/u,
  );
  assert.doesNotMatch(securityCommands, /--source-only/u);

  for (const jobName of ["release-metadata", "publish"]) {
    const commands = workflow.jobs[jobName].steps.map(({ run }) => run ?? "");
    const browser = commands.findIndex((command) => command.includes("playwright install --with-deps chromium"));
    const dryRun = commands.findIndex((command) => command.includes("release:dry-run"));
    const build = commands.findIndex((command) => command === "pnpm build");
    const preload = commands.findIndex((command) => command === "node scripts/prepare-ci-images.mjs");
    assert.notEqual(browser, -1, `${jobName} browser install`);
    assert.notEqual(dryRun, -1, `${jobName} release dry-run`);
    assert.equal(browser < dryRun, true, `${jobName} browser before dry-run`);
    assert.equal(build >= 0 && build < dryRun, true, `${jobName} workspace build before the dry-run's release tests`);
    assert.equal(preload >= 0 && preload < dryRun, true, `${jobName} image preload before dry-run`);
    assert.equal(workflow.jobs[jobName].steps[dryRun].env?.PLAYWRIGHT_BROWSER_CHANNEL, "chromium");
  }
});

test("npm publishes publicly with provenance and only its step receives the npm token", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const setupNode = steps.find(({ uses }) => uses?.startsWith("actions/setup-node@"));
  assert.equal(setupNode.with["registry-url"], "https://registry.npmjs.org");
  assert.equal(setupNode.with.scope, "@8lines");
  assert.doesNotMatch(source, /npm\.pkg\.github\.com/u);

  const npmToken = "${{ secrets.NPM_TOKEN }}";
  const consumers = steps.filter((step) => JSON.stringify(step).includes(npmToken));
  assert.deepEqual(consumers.map(({ name }) => name), ["Publish staged npm packages"]);
  assert.deepEqual(consumers[0].env, { NODE_AUTH_TOKEN: npmToken });
  assert.match(
    consumers[0].run,
    /npm publish "\$PACKAGE" --registry=https:\/\/registry\.npmjs\.org\/ --access public --provenance/u,
  );
  for (const step of steps.filter((candidate) => candidate !== consumers[0])) {
    assert.equal(step.env?.NODE_AUTH_TOKEN, undefined, `${step.name} npm token`);
  }
});

test("each Composer deploy key reaches only the split publication step", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  assert.doesNotMatch(source, /create-github-app-token|COMPOSER_SPLIT_APP|GAUNTLET_COMPOSER_TOKEN/u);
  const deployKeys = {
    COMPOSER_SPLIT_CORE_DEPLOY_KEY: "${{ secrets.COMPOSER_SPLIT_CORE_DEPLOY_KEY }}",
    COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY: "${{ secrets.COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY }}",
  };
  const consumers = steps.filter((step) => /DEPLOY_KEY/u.test(JSON.stringify(step)));
  assert.deepEqual(consumers.map(({ name }) => name), ["Publish Composer split repositories"]);
  assert.deepEqual(consumers[0].env, deployKeys);
  for (const jobName of Object.keys(workflow.jobs).filter((name) => name !== "publish")) {
    assert.doesNotMatch(JSON.stringify(workflow.jobs[jobName]), /secrets\./u, `${jobName} secrets`);
  }
  const secretReferences = [...source.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map(([, name]) => name).sort();
  assert.deepEqual(secretReferences, [
    "COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY",
    "COMPOSER_SPLIT_CORE_DEPLOY_KEY",
    "NPM_TOKEN",
  ]);
});
