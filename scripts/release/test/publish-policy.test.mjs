import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parseDocument } from "yaml";

import { RELEASE_GATES } from "../plan.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const GATE_JOBS = RELEASE_GATES;
const ALL_JOBS = ["plan", ...GATE_JOBS, "release-metadata", "publish"];
const ACTION_SHA = /^[^@\s]+@[0-9a-f]{40}$/;
const LINUX_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const BLACKSMITH_CHECKOUT = /^useblacksmith\/checkout@[0-9a-f]{40}$/u;

function releaseWorkflow() {
  const source = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return { source, workflow: document.toJS({ maxAliasCount: 0 }) };
}

function publishCondition() {
  const clause = (gate) => `((contains(fromJSON(needs.plan.outputs.gates), '${gate}') && needs.${gate}.result == 'success')`
    + ` || (!contains(fromJSON(needs.plan.outputs.gates), '${gate}') && needs.${gate}.result == 'skipped'))`;
  return ["${{ !cancelled()", "needs.plan.result == 'success'", "needs.release-metadata.result == 'success'",
    ...GATE_JOBS.map(clause)].join(" && ") + " }}";
}

test("publication runs only for release-set tags with bounded permissions", () => {
  const { source, workflow } = releaseWorkflow();
  assert.equal(workflow.name, "release");
  assert.deepEqual(workflow.on, { push: { tags: ["release-*"] } });
  assert.doesNotMatch(source, /v\*\.\*\.\*/u);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(source, /pull_request|pull_request_target/u);
  assert.doesNotMatch(source, /:latest\b/u);
  assert.doesNotMatch(source, /useblacksmith\/setup-docker-builder/u);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...ALL_JOBS].sort());
  const publish = workflow.jobs.publish;
  assert.deepEqual([...publish.needs].sort(), ["plan", ...GATE_JOBS, "release-metadata"].sort());
  assert.equal(publish.if.replace(/\s+/gu, " ").trim(), publishCondition());
  assert.equal(publish.environment, "release");
  assert.deepEqual(publish.permissions, { contents: "write", packages: "write" });
  for (const gate of GATE_JOBS) {
    assert.equal(workflow.jobs[gate].needs, "plan", `${gate} needs plan`);
    assert.equal(workflow.jobs[gate].if, `contains(fromJSON(needs.plan.outputs.gates), '${gate}')`, `${gate} condition`);
  }
  assert.equal(workflow.jobs["release-metadata"].needs, "plan");
  assert.equal(workflow.jobs["release-metadata"].if, undefined);
  assert.deepEqual(workflow.jobs.plan.outputs, {
    gates: "${{ steps.plan.outputs.gates }}",
    units: "${{ steps.plan.outputs.units }}",
  });
  const planRun = workflow.jobs.plan.steps.find(({ id }) => id === "plan").run;
  for (const pattern of [
    /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$GITHUB_REF_NAME" --jq \.object\.type/u,
    /node scripts\/release\/plan\.mjs --check --release-set "\$GITHUB_REF_NAME" --commit "\$GITHUB_SHA"/u,
    /node scripts\/release\/release-set\.mjs outputs --plan-result/u,
  ]) assert.match(planRun, pattern);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (jobName !== "publish") assert.equal(job.permissions?.["id-token"], undefined, `${jobName} OIDC token`);
    const skills = jobName === "skills";
    assert.equal(job["runs-on"], skills ? "${{ matrix.os }}" : LINUX_RUNNER, `${jobName} runner`);
    assert.equal(Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 90, true, `${jobName} timeout`);
    const checkouts = job.steps.filter(({ uses }) => typeof uses === "string" && /^[^@]+\/checkout@/u.test(uses));
    assert.equal(checkouts.length, 1, `${jobName} single checkout`);
    assert.match(checkouts[0].uses, skills ? /^actions\/checkout@[0-9a-f]{40}$/u : BLACKSMITH_CHECKOUT, `${jobName} checkout action`);
    assert.equal(checkouts[0].with?.["persist-credentials"], false, `${jobName} checkout credentials`);
    for (const step of job.steps) if (step.uses !== undefined) assert.match(step.uses, ACTION_SHA, `${jobName}: ${step.uses}`);
  }
  for (const jobName of ["java", "publish"]) {
    const java = workflow.jobs[jobName].steps.find(({ uses }) => uses?.startsWith("actions/setup-java@"));
    assert.notEqual(java, undefined, `${jobName} Java toolchain`);
    assert.equal(java.with.distribution, "temurin");
    assert.equal(String(java.with["java-version"]), "21");
  }
  assert.equal(workflow.jobs.node.strategy["fail-fast"], false);
  assert.deepEqual(workflow.jobs.node.strategy.matrix.node, ["24.20.0", "25.9.0", "26.8.1"]);
});

test("every gate job mirrors its CI job", () => {
  const ci = parseDocument(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"), { uniqueKeys: true })
    .toJS({ maxAliasCount: 0 });
  const { workflow } = releaseWorkflow();
  for (const gate of ["dashboard", "widget", "widget-panel", "skills"]) {
    const strip = ({ needs, if: condition, ...job }) => job;
    assert.deepEqual(strip(workflow.jobs[gate]), strip(ci.jobs[gate]), gate);
  }
});

test("publication is scoped to clean units and creates each unit's tag and release in order", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const names = steps.map(({ name }) => name);
  const ordered = [
    "Reproduce and verify staged release",
    "Check every remote destination",
    "Publish commit-tagged image with attestations",
    "Verify pushed image and attestations",
    "Publish staged npm packages",
    "Publish staged Maven packages",
    "Publish Composer split repositories",
    "Promote image digest to the semantic tag",
    "Publish Helm chart",
    "Verify every published artifact",
    "Tag and release each unit",
  ];
  assert.deepEqual(names.filter((name) => ordered.includes(name)), ordered);
  assert.equal(names.at(-1), "Tag and release each unit");
  const step = (name) => steps.find((candidate) => candidate.name === name);
  assert.match(step("Reproduce and verify staged release").run, /pnpm release:dry-run --plan \.release\/plan\.json --release-set "\$GITHUB_REF_NAME"/u);
  assert.equal(step("Check every remote destination").id, "preflight");
  assert.match(step("Check every remote destination").run, /release-set\.mjs preflight-outputs --state-file "\$RESULT" >> "\$GITHUB_OUTPUT"/u);
  for (const name of ["Publish commit-tagged image with attestations", "Verify pushed image and attestations", "Promote image digest to the semantic tag", "Publish Helm chart"]) {
    assert.equal(step(name).if, "steps.preflight.outputs.gauntlet == 'true'", name);
  }
  assert.equal(step("Publish staged npm packages").if, "steps.preflight.outputs.npm != ''");
  assert.equal(step("Publish staged Maven packages").if, "steps.preflight.outputs.maven != ''");
  assert.equal(step("Publish Composer split repositories").if, "steps.preflight.outputs.composer != ''");
  for (const name of ["Verify every published artifact", "Tag and release each unit"]) {
    assert.equal(step(name).if, "steps.preflight.outputs.clean != '[]'", name);
  }
  assert.match(step("Publish staged npm packages").run, /for UNIT in \$NPM_UNITS; do[\s\S]*release-set\.mjs artifact[\s\S]*npm publish "\$PACKAGE" --registry=https:\/\/registry\.npmjs\.org\/ --access public/u);
  assert.match(step("Publish staged Maven packages").run, /java-core\) TASKS\+=\(":core:publish"\)/u);
  assert.match(step("Publish staged Maven packages").run, /spring-boot-starter\) TASKS\+=\(":spring-boot-starter:publish"\)/u);
  assert.match(step("Publish Composer split repositories").run, /for UNIT in \$COMPOSER_UNITS; do[\s\S]*publish-composer\.mjs[\s\S]*--source-commit "\$GITHUB_SHA"[\s\S]*--unit "\$UNIT"/u);
  const loop = step("Tag and release each unit").run;
  const sequence = [
    /for UNIT in \$CLEAN_UNITS; do/u,
    /check-published\.mjs --finalize "\$RELEASE_DIRECTORY" --unit "\$UNIT"/u,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/tags"/u,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/refs"/u,
    /gh release create "\$TAG" --draft --verify-tag --title "\$TITLE" "\$LATEST"/u,
    /--unit "\$UNIT" --require-draft-identical/u,
    /gh release edit "\$TAG" --draft=false/u,
    /GAUNTLET_USE_REMOTE_RECEIPT=true[\s\S]*--unit "\$UNIT" --require-identical/u,
    /release-set\.mjs require-state --state-file "\$RUNNER_TEMP\/released-\$UNIT\.json" --unit "\$UNIT" --state already-identical/u,
  ];
  let cursor = 0;
  for (const pattern of sequence) {
    const match = pattern.exec(loop.slice(cursor));
    assert.notEqual(match, null, String(pattern));
    cursor += match.index + match[0].length;
  }
  assert.match(loop, /LATEST="--latest=false"/u);
  assert.match(loop, /if \[ "\$UNIT" = "gauntlet" \]; then[\s\S]*LATEST="--latest"/u);
  assert.equal((source.match(/--latest\b(?!=)/gu) ?? []).length, 1);
  assert.doesNotMatch(loop, /git push/u);
});

test("every remote destination is preflighted after the dry run and before the first mutation", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const commands = steps.map(({ run }) => run ?? "");
  const preflightIndex = steps.findIndex(({ name }) => name === "Check every remote destination");
  const firstMutationIndex = steps.findIndex(({ name }) => name === "Publish commit-tagged image with attestations");
  assert.equal(preflightIndex >= 0 && preflightIndex < firstMutationIndex, true);
  assert.match(commands[preflightIndex], /check-published\.mjs/u);
  assert.match(commands.slice(0, firstMutationIndex).join("\n"), /release:dry-run/u);
  assert.doesNotMatch(commands.slice(0, firstMutationIndex).join("\n"), /git fetch/u);
  assert.match(commands.slice(0, firstMutationIndex).join("\n"), /origin\/main/u);
  for (const step of steps.slice(firstMutationIndex)) {
    assert.match(step.if ?? "", /^steps\.preflight\.outputs\./u, `${step.name} rerun guard`);
  }
  assert.doesNotMatch(source, /git push/u);
});

test("the image is copied with preserved digests and scanned before it is promoted", () => {
  const { workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const step = (name) => steps.find((candidate) => candidate.name === name);
  const imagePublication = step("Publish commit-tagged image with attestations");
  const imageVerification = step("Verify pushed image and attestations");
  assert.equal(imagePublication.id, "image-copy");
  assert.equal(imageVerification.id, "image");
  assert.equal(step("Publish Helm chart").id, "chart");
  assert.match(
    imagePublication.run,
    /quay\.io\/skopeo\/stable:v1\.20\.0@sha256:47853bb9fb24202af9110531ebd6e43c5f97701254ca290596640290d17942f4/u,
  );
  assert.match(imagePublication.run, /oci-archive:/u);
  assert.match(imagePublication.run, /--preserve-digests/u);
  assert.match(imagePublication.run, /--digestfile/u);
  assert.match(imagePublication.run, /RELEASE_DIRECTORY="\$PWD\/\.artifacts\/release\/\$GITHUB_REF_NAME"/u);
  assert.match(imagePublication.run, /release-set\.mjs field --release-directory "\$RELEASE_DIRECTORY" --unit gauntlet --field version/u);
  assert.doesNotMatch(imagePublication.run, /docker buildx bake/u);
  assert.match(
    imageVerification.run,
    /aquasec\/trivy:0\.66\.0@sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e/u,
  );
  assert.match(imageVerification.run, /for PLATFORM in linux\/amd64 linux\/arm64/u);
  assert.match(imageVerification.run, /--platform "\$PLATFORM"/u);
  assert.match(step("Publish Helm chart").run, /helm push "\.artifacts\/release\/\$GITHUB_REF_NAME\/helm\/gauntlet-\$VERSION\.tgz"/u);
  for (const name of ["Promote image digest to the semantic tag", "Publish Helm chart"]) {
    assert.match(step(name).run, /release-set\.mjs field --release-directory "\$RELEASE_DIRECTORY" --unit gauntlet --field version/u, name);
  }
  for (const run of steps.map(({ run: command }) => command ?? "")) assert.doesNotMatch(run, /< VERSION\)/u);
});

test("a failed draft asset upload cannot reach the public release mutation", () => {
  const { workflow } = releaseWorkflow();
  const step = workflow.jobs.publish.steps.find(({ name }) => name === "Tag and release each unit");
  assert.equal(step["continue-on-error"], undefined);
  assert.match(step.run, /^set -euo pipefail$/mu);
  const loop = step.run;
  const create = loop.search(/gh release create "\$TAG" --draft /u);
  const draftCheck = loop.search(/--require-draft-identical/u);
  const edit = loop.search(/gh release edit "\$TAG" --draft=false/u);
  assert.equal(create >= 0 && create < draftCheck && draftCheck < edit, true);
  assert.doesNotMatch(loop.slice(create, draftCheck), /gh release edit|--draft=false/u);
  assert.equal((loop.match(/gh release edit/gu) ?? []).length, 1);
});

test("release security scans the staged image and dry-runs install Chromium", () => {
  const { workflow } = releaseWorkflow();
  const securityCommands = workflow.jobs.security.steps.map(({ run }) => run ?? "").join("\n");
  assert.match(
    securityCommands,
    /release:stage --output "\$PWD\/\.artifacts\/release\/\$GITHUB_REF_NAME" --plan \.release\/plan\.json --release-set "\$GITHUB_REF_NAME"/u,
  );
  assert.match(
    securityCommands,
    /release:security --image-archive "\.artifacts\/release\/\$GITHUB_REF_NAME\/image\/gauntlet-\$VERSION\.docker\.tar"/u,
  );
  assert.doesNotMatch(securityCommands, /--source-only/u);
  const metadataCommands = workflow.jobs["release-metadata"].steps.map(({ run }) => run ?? "").join("\n");
  assert.match(metadataCommands, /node scripts\/release\/version\.mjs --check$/mu);
  assert.match(metadataCommands, /node scripts\/release\/plan\.mjs --check --release-set "\$GITHUB_REF_NAME" --commit "\$GITHUB_SHA"/u);
  assert.match(metadataCommands, /pnpm release:dry-run --plan \.release\/plan\.json --release-set "\$GITHUB_REF_NAME"/u);
  assert.doesNotMatch(metadataCommands, /--tag|"v\$VERSION"/u);

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

test("npm publishes publicly without provenance and only its step receives the npm token", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const setupNode = steps.find(({ uses }) => uses?.startsWith("actions/setup-node@"));
  assert.equal(setupNode.with["registry-url"], "https://registry.npmjs.org");
  assert.equal(setupNode.with.scope, "@8lines");
  assert.doesNotMatch(source, /npm\.pkg\.github\.com/u);

  const npmToken = "${{ secrets.NPM_TOKEN }}";
  const consumers = steps.filter((step) => JSON.stringify(step).includes(npmToken));
  assert.deepEqual(consumers.map(({ name }) => name), ["Publish staged npm packages"]);
  assert.deepEqual(consumers[0].env, { NODE_AUTH_TOKEN: npmToken, NPM_UNITS: "${{ steps.preflight.outputs.npm }}" });
  assert.match(
    consumers[0].run,
    /npm publish "\$PACKAGE" --registry=https:\/\/registry\.npmjs\.org\/ --access public$/mu,
  );
  assert.doesNotMatch(consumers[0].run, /--provenance/u);
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
  assert.deepEqual(consumers[0].env, { ...deployKeys, COMPOSER_UNITS: "${{ steps.preflight.outputs.composer }}" });
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
