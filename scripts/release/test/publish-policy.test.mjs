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

const RELEASE_SCRIPT = "scripts/release/release-unit.sh";
const PUBLISH_COMMAND = /npm publish|gradlew|publish-composer\.mjs|skopeo|imagetools create|helm push/u;
const PUBLICATION_STEPS = Object.freeze([
  "Reproduce and verify staged release",
  "Check every remote destination",
  "Publish and release package units",
  "Publish commit-tagged image with attestations",
  "Verify pushed image and attestations",
  "Promote image digest to the semantic tag",
  "Publish Helm chart",
  "Verify the published application",
  "Tag and release the application",
  "Tag and release the skills",
]);

function releaseScript() {
  return readFileSync(resolve(ROOT, RELEASE_SCRIPT), "utf8");
}

// Requires every pattern to match after the previous one; returns the offset after the last match.
function assertOrdered(text, patterns) {
  let cursor = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(text.slice(cursor));
    assert.notEqual(match, null, String(pattern));
    cursor += match.index + match[0].length;
  }
  return cursor;
}

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
  // One release set at a time, whatever its tag; a queued set never cancels a running one.
  assert.deepEqual(workflow.concurrency, { group: "release", "cancel-in-progress": false });
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

test("each unit is published, verified and released before the next unit is published", () => {
  const { workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const names = steps.map(({ name }) => name);
  assert.deepEqual(names.filter((name) => PUBLICATION_STEPS.includes(name)), PUBLICATION_STEPS);
  assert.equal(names.at(-1), "Tag and release the skills");
  const step = (name) => steps.find((candidate) => candidate.name === name);
  assert.match(step("Reproduce and verify staged release").run, /pnpm release:dry-run --plan \.release\/plan\.json --release-set "\$GITHUB_REF_NAME"/u);
  assert.equal(step("Check every remote destination").id, "preflight");
  assert.match(step("Check every remote destination").run, /release-set\.mjs preflight-outputs --state-file "\$RESULT" >> "\$GITHUB_OUTPUT"/u);
  assert.equal(step("Publish and release package units").if, "steps.preflight.outputs.packages != ''");
  for (const name of PUBLICATION_STEPS.slice(3, 9)) assert.equal(step(name).if, "steps.preflight.outputs.gauntlet == 'true'", name);
  assert.equal(step("Tag and release the skills").if, "steps.preflight.outputs.skills == 'true'");

  // Package units: one loop in dependency order; each unit's single destination, then its own
  // verification, then its tag and release, before the next unit starts.
  const packages = step("Publish and release package units");
  assert.equal(packages.env.PACKAGE_UNITS, "${{ steps.preflight.outputs.packages }}");
  assert.equal(packages.env.GAUNTLET_USE_REMOTE_RECEIPT, "true");
  const loop = packages.run.slice(packages.run.indexOf("for UNIT in $PACKAGE_UNITS; do"));
  assert.equal((packages.run.match(/\bfor UNIT in\b/gu) ?? []).length, 1);
  for (const command of [/release-unit\.sh/gu, /check-published\.mjs/gu, /require-state/gu, /npm publish/gu, /gradlew/gu]) {
    assert.equal((packages.run.match(command) ?? []).length, 1, String(command));
  }
  const end = assertOrdered(loop, [
    /^for UNIT in \$PACKAGE_UNITS; do\n/u,
    /if \[\[ " \$NPM_UNITS " == \*" \$UNIT "\* \]\]; then/u,
    /release-set\.mjs artifact --release-directory "\$RELEASE_DIRECTORY" --unit "\$UNIT"/u,
    /npm publish "\$PACKAGE" --registry=https:\/\/registry\.npmjs\.org\/ --access public\n/u,
    /elif \[\[ " \$MAVEN_UNITS " == \*" \$UNIT "\* \]\]; then/u,
    /java-core\) TASK=":core:publish" ;;/u,
    /spring-boot-starter\) TASK=":spring-boot-starter:publish" ;;/u,
    /packages\/java\/gradlew --no-daemon --no-configuration-cache --console=plain -p packages\/java "\$TASK"\n/u,
    /elif \[\[ " \$COMPOSER_UNITS " == \*" \$UNIT "\* \]\]; then/u,
    /php-core\) [^\n]*publish-composer\.mjs \\\n\s*--release-directory "\$RELEASE_DIRECTORY" --source-commit "\$GITHUB_SHA" --unit "\$UNIT" ;;/u,
    /symfony-bundle\) [^\n]*publish-composer\.mjs \\\n\s*--release-directory "\$RELEASE_DIRECTORY" --source-commit "\$GITHUB_SHA" --unit "\$UNIT" ;;/u,
    /else\n\s*exit 1\n\s*fi\n/u,
    /check-published\.mjs --release-directory "\$RELEASE_DIRECTORY" \\\n\s*--source-commit "\$GITHUB_SHA" --unit "\$UNIT" --require-identical > "\$RUNNER_TEMP\/published-\$UNIT\.json"\n/u,
    /release-set\.mjs require-state --state-file "\$RUNNER_TEMP\/published-\$UNIT\.json" --unit "\$UNIT" --state published-artifacts-identical\n/u,
    /^\s*bash scripts\/release\/release-unit\.sh "\$RELEASE_DIRECTORY" "\$UNIT"\n\s*done$/mu,
  ]);
  assert.equal(loop.slice(end).trim(), "");
  // The loop body publishes before it verifies, and releases only after verification.
  const body = loop.slice(0, end);
  assert.equal(body.search(PUBLISH_COMMAND) < body.search(/--require-identical/u), true);
  assert.doesNotMatch(body.slice(body.search(/--require-identical/u)), PUBLISH_COMMAND);

  // The application: its destinations, its verification with the pushed digests, then its release.
  assert.deepEqual(step("Verify the published application").env, {
    GH_TOKEN: "${{ github.token }}",
    GAUNTLET_USE_REMOTE_RECEIPT: "true",
    GAUNTLET_EXPECTED_IMAGE_DIGEST: "${{ steps.image.outputs.digest }}",
    GAUNTLET_EXPECTED_CHART_DIGEST: "${{ steps.chart.outputs.digest }}",
  });
  assertOrdered(step("Verify the published application").run, [
    /check-published\.mjs --release-directory "\$RELEASE_DIRECTORY" \\\n\s*--source-commit "\$GITHUB_SHA" --unit gauntlet --require-identical > "\$RUNNER_TEMP\/published-gauntlet\.json"/u,
    /release-set\.mjs require-state --state-file "\$RUNNER_TEMP\/published-gauntlet\.json" --unit gauntlet --state published-artifacts-identical/u,
  ]);
  assert.deepEqual(step("Tag and release the application").env, {
    GH_TOKEN: "${{ github.token }}",
    IMAGE_DIGEST: "${{ steps.image.outputs.digest }}",
    CHART_DIGEST: "${{ steps.chart.outputs.digest }}",
  });
  assert.match(step("Tag and release the application").run,
    /^bash scripts\/release\/release-unit\.sh "\$PWD\/\.artifacts\/release\/\$GITHUB_REF_NAME" gauntlet$/mu);
  // The skills have no registry destination: they are only released, last.
  assert.deepEqual(step("Tag and release the skills").env, { GH_TOKEN: "${{ github.token }}" });
  assert.match(step("Tag and release the skills").run,
    /^bash scripts\/release\/release-unit\.sh "\$PWD\/\.artifacts\/release\/\$GITHUB_REF_NAME" skills$/mu);

  // No step publishes a unit after a later unit's release.
  const releasing = steps.map(({ run }) => /release-unit\.sh/u.test(run ?? ""));
  const publishing = steps.map(({ run }) => PUBLISH_COMMAND.test(run ?? ""));
  assert.deepEqual(steps.filter((_, index) => releasing[index]).map(({ name }) => name),
    ["Publish and release package units", "Tag and release the application", "Tag and release the skills"]);
  const applicationRelease = names.indexOf("Tag and release the application");
  assert.equal(publishing.slice(applicationRelease).some(Boolean), false);
  assert.equal(names.indexOf("Publish and release package units") < names.indexOf("Publish commit-tagged image with attestations"), true);
  assert.deepEqual(steps.filter((_, index) => publishing[index]).map(({ name }) => name), [
    "Publish and release package units", "Publish commit-tagged image with attestations", "Promote image digest to the semantic tag",
    "Publish Helm chart",
  ]);
  assert.equal(names.some((name) => /Verify every published artifact|Tag and release each unit/u.test(name)), false);
});

test("the release script tags, drafts, verifies and publishes one unit in order", () => {
  const { source } = releaseWorkflow();
  const script = releaseScript();
  assert.match(script, /^#!\/usr\/bin\/env bash\n/u);
  assert.match(script, /^set -euo pipefail$/mu);
  assert.match(script, /^RELEASE_DIRECTORY="\$1"\nUNIT="\$2"$/mu);
  assertOrdered(script, [
    /--field tag\)"/u,
    /--field title\)"/u,
    /--field previous-tag\)"/u,
    /gh api --paginate "repos\/\$GITHUB_REPOSITORY\/releases" --jq '\.\[\] \| select\(\.draft\) \| \.tag_name'/u,
    /if grep -Fxq -- "\$TAG" <<< "\$DRAFT_TAGS"; then\n[^\n]*already exists[^\n]*\n\s*exit 1\n/u,
    /check-published\.mjs --finalize "\$RELEASE_DIRECTORY" --unit "\$UNIT" \\\n\s*--image-digest "\$IMAGE_DIGEST" --chart-digest "\$CHART_DIGEST"/u,
    /check-published\.mjs --finalize "\$RELEASE_DIRECTORY" --unit "\$UNIT"\n/u,
    /test "\$\(git rev-parse "refs\/tags\/\$TAG\^\{commit\}"\)" = "\$GITHUB_SHA"/u,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/tags"/u,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/refs"/u,
    /release-set\.mjs notes --release-directory "\$RELEASE_DIRECTORY" --unit "\$UNIT" --output "\$NOTES"/u,
    /release-set\.mjs assets --release-directory "\$RELEASE_DIRECTORY" --unit "\$UNIT"/u,
    /test "\$\{#ASSETS\[@\]\}" -ge 4/u,
    /gh release create "\$TAG" --draft --verify-tag --title "\$TITLE" "\$LATEST" "\$\{NOTES_ARGS\[@\]\}" "\$\{ASSETS\[@\]\}"/u,
    /--unit "\$UNIT" --require-draft-identical/u,
    /gh release edit "\$TAG" --draft=false "\$LATEST"/u,
    /GAUNTLET_EXPECTED_IMAGE_DIGEST="\$IMAGE_DIGEST" GAUNTLET_EXPECTED_CHART_DIGEST="\$CHART_DIGEST" GAUNTLET_USE_REMOTE_RECEIPT=true \\\n[\s\S]*--unit "\$UNIT" --require-identical > "\$RUNNER_TEMP\/released-\$UNIT\.json"/u,
    /release-set\.mjs require-state --state-file "\$RUNNER_TEMP\/released-\$UNIT\.json" --unit "\$UNIT" --state already-identical\n$/u,
  ]);
  // Generated notes start at the unit's previous tag when it has one.
  assert.match(script, /if \[ "\$NOTES_MODE" = "generated" \]; then\n\s*NOTES_ARGS\+=\(--generate-notes\)\n\s*if \[ -n "\$PREVIOUS_TAG" \]; then NOTES_ARGS\+=\(--notes-start-tag "\$PREVIOUS_TAG"\); fi\n\s*fi/u);
  // Only the application is marked Latest: the only bare --latest is its assignment, and both release
  // commands pass "$LATEST"; the workflow itself never passes --latest.
  assert.match(script, /^LATEST="--latest=false"\nif \[ "\$UNIT" = "gauntlet" \]; then\n[\s\S]*?\n\s*LATEST="--latest"\nelse\n/mu);
  assert.equal((script.match(/--latest\b(?!=)/gu) ?? []).length, 1);
  assert.equal((script.match(/"\$LATEST"/gu) ?? []).length, 2);
  assert.doesNotMatch(source, /--latest/u);
  // Digests belong to the application alone.
  assert.match(script, /if \[ "\$UNIT" = "gauntlet" \]; then\n\s*test -n "\$IMAGE_DIGEST"\n\s*test -n "\$CHART_DIGEST"\nelse\n\s*test -z "\$IMAGE_DIGEST"\n\s*test -z "\$CHART_DIGEST"\nfi/u);
  assert.doesNotMatch(script, /git push|secrets\.|NODE_AUTH_TOKEN|DEPLOY_KEY|\$\{\{/u);
  assert.doesNotMatch(script, PUBLISH_COMMAND);
});

test("workflow expressions reach run scripts only through step environment variables", () => {
  const { workflow } = releaseWorkflow();
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) assert.doesNotMatch(step.run ?? "", /\$\{\{/u, `${jobName}: ${step.name ?? step.run}`);
  }
  const steps = workflow.jobs.publish.steps;
  const step = (name) => steps.find((candidate) => candidate.name === name);
  assert.equal(step("Verify pushed image and attestations").env.COPIED_DIGEST, "${{ steps.image-copy.outputs.digest }}");
  assert.match(step("Verify pushed image and attestations").run, /test "\$DIGEST" = "\$COPIED_DIGEST"/u);
  assert.equal(step("Promote image digest to the semantic tag").env.IMAGE_DIGEST, "${{ steps.image.outputs.digest }}");
  assert.match(step("Promote image digest to the semantic tag").run, /"ghcr\.io\/8lines\/gauntlet@\$IMAGE_DIGEST"/u);
});

test("every remote destination is preflighted after the dry run and before the first mutation", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const commands = steps.map(({ run }) => run ?? "");
  const preflightIndex = steps.findIndex(({ name }) => name === "Check every remote destination");
  const firstMutationIndex = steps.findIndex(({ name }) => name === "Publish and release package units");
  assert.equal(preflightIndex >= 0 && preflightIndex < firstMutationIndex, true);
  assert.match(commands[preflightIndex], /check-published\.mjs/u);
  assert.match(commands.slice(0, firstMutationIndex).join("\n"), /release:dry-run/u);
  assert.doesNotMatch(commands.slice(0, firstMutationIndex).join("\n"), /git fetch/u);
  assert.match(commands.slice(0, firstMutationIndex).join("\n"), /origin\/main/u);
  for (const step of steps.slice(firstMutationIndex)) {
    assert.match(step.if ?? "", /^steps\.preflight\.outputs\./u, `${step.name} rerun guard`);
  }
  assert.doesNotMatch(source, /git push/u);
  assert.doesNotMatch(releaseScript(), /git push/u);
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
  for (const step of workflow.jobs.publish.steps.filter(({ run }) => /release-unit\.sh/u.test(run ?? ""))) {
    assert.equal(step["continue-on-error"], undefined, step.name);
    assert.match(step.run, /^set -euo pipefail$/mu, step.name);
  }
  const script = releaseScript();
  const create = script.search(/gh release create "\$TAG" --draft /u);
  const draftCheck = script.search(/--require-draft-identical/u);
  const edit = script.search(/gh release edit "\$TAG" --draft=false/u);
  assert.equal(create >= 0 && create < draftCheck && draftCheck < edit, true);
  assert.doesNotMatch(script.slice(create, draftCheck), /gh release edit|--draft=false/u);
  assert.equal((script.match(/gh release edit/gu) ?? []).length, 1);
  assert.equal((script.match(/gh release create/gu) ?? []).length, 1);
  assert.doesNotMatch(script, /\|\| true|set \+e/u);
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

// A secret moves from the step environment into an unexported shell variable before anything runs,
// and reaches only the command lines named here, as a per-command environment assignment.
function assertCommandScopedSecret(run, { variable, shell, uses }) {
  const head = run.slice(0, run.indexOf("for UNIT in"));
  assert.match(head, new RegExp(`^\\s*${shell}="\\$${variable}"$`, "mu"), `${variable} copied`);
  assert.match(head, new RegExp(`^\\s*unset [A-Z_ ]*\\b${variable}\\b`, "mu"), `${variable} unset`);
  assert.equal((run.match(new RegExp(`\\$${variable}\\b`, "gu")) ?? []).length, 1, `${variable} read once`);
  const lines = run.split("\n").filter((line) => line.includes(`"$${shell}"`));
  assert.equal(lines.length, uses.length, `${shell} uses`);
  for (const [index, pattern] of uses.entries()) assert.match(lines[index], pattern, `${shell} use ${index}`);
}

test("npm publishes publicly without provenance and only its command receives the npm token", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const setupNode = steps.find(({ uses }) => uses?.startsWith("actions/setup-node@"));
  assert.equal(setupNode.with["registry-url"], "https://registry.npmjs.org");
  assert.equal(setupNode.with.scope, "@8lines");
  assert.doesNotMatch(source, /npm\.pkg\.github\.com/u);

  const npmToken = "${{ secrets.NPM_TOKEN }}";
  const consumers = steps.filter((step) => JSON.stringify(step).includes(npmToken));
  assert.deepEqual(consumers.map(({ name }) => name), ["Publish and release package units"]);
  assert.equal(consumers[0].env.NPM_PUBLISH_TOKEN, npmToken);
  assert.doesNotMatch(consumers[0].run, /\bexport\b|set -a|set -x/u);
  assertCommandScopedSecret(consumers[0].run, {
    variable: "NPM_PUBLISH_TOKEN",
    shell: "NPM_SECRET",
    uses: [/^\s*NODE_AUTH_TOKEN="\$NPM_SECRET" npm publish "\$PACKAGE" --registry=https:\/\/registry\.npmjs\.org\/ --access public$/u],
  });
  assert.doesNotMatch(consumers[0].run, /--provenance/u);
  for (const step of steps) assert.equal(step.env?.NODE_AUTH_TOKEN, undefined, `${step.name} npm token`);
});

test("each Composer deploy key reaches only its own split publication command", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  assert.doesNotMatch(source, /create-github-app-token|COMPOSER_SPLIT_APP|GAUNTLET_COMPOSER_TOKEN/u);
  const consumers = steps.filter((step) => /secrets\.COMPOSER_SPLIT/u.test(JSON.stringify(step)));
  assert.deepEqual(consumers.map(({ name }) => name), ["Publish and release package units"]);
  const { env, run } = consumers[0];
  assert.equal(env.CORE_DEPLOY_KEY, "${{ secrets.COMPOSER_SPLIT_CORE_DEPLOY_KEY }}");
  assert.equal(env.BUNDLE_DEPLOY_KEY, "${{ secrets.COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY }}");
  assert.equal(Object.keys(env).some((name) => name.startsWith("COMPOSER_SPLIT_")), false);
  assertCommandScopedSecret(run, {
    variable: "CORE_DEPLOY_KEY",
    shell: "CORE_KEY",
    uses: [/^\s*php-core\) COMPOSER_SPLIT_CORE_DEPLOY_KEY="\$CORE_KEY" node scripts\/release\/publish-composer\.mjs \\$/u],
  });
  assertCommandScopedSecret(run, {
    variable: "BUNDLE_DEPLOY_KEY",
    shell: "BUNDLE_KEY",
    uses: [/^\s*symfony-bundle\) COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY="\$BUNDLE_KEY" node scripts\/release\/publish-composer\.mjs \\$/u],
  });
  // The Maven credentials are the job token, given to the Gradle command line only.
  assert.match(run, /ORG_GRADLE_PROJECT_gauntletRemotePublishing=true \\\n\s*ORG_GRADLE_PROJECT_gauntletRemoteUsername="\$GITHUB_ACTOR" \\\n\s*ORG_GRADLE_PROJECT_gauntletRemotePassword="\$GH_TOKEN" \\\n\s*packages\/java\/gradlew /u);
  for (const step of steps) {
    assert.equal(Object.keys(step.env ?? {}).some((name) => name.startsWith("ORG_GRADLE_PROJECT_")), false, `${step.name} Gradle env`);
  }
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
