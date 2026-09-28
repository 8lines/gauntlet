import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parseDocument } from "yaml";

const ROOT = resolve(import.meta.dirname, "../../..");
const ACTION_SHA = /^[^@\s]+@[0-9a-f]{40}$/;
const PINNED_USES_LINE = /^\s*(?:-\s+)?uses:\s+[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+@[0-9a-f]{40} # v[0-9][^\s]*(?: \(\d{4}-\d{2}-\d{2}\))?$/u;
const DOCKER_LOGIN_ACTION = "docker/login-action@dbcb813823bdd20940b903addbd779551569679f";
const LINUX_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const MACOS_RUNNER = "blacksmith-6vcpu-macos-15";
const BLACKSMITH_CHECKOUT = /^useblacksmith\/checkout@[0-9a-f]{40}$/u;
const GITHUB_CHECKOUT = /^actions\/checkout@[0-9a-f]{40}$/u;
const QEMU_STEP = Object.freeze({
  uses: "docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8",
  with: {
    image: "tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0",
    platforms: "arm64",
    "cache-image": false,
  },
});
const BUILDX_STEP = Object.freeze({
  uses: "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
  with: {
    version: "v0.33.0",
    "driver-opts": "image=moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8",
    "cache-binary": false,
  },
});
const MULTI_PLATFORM_JOBS = Object.freeze({
  ".github/workflows/ci.yml": Object.freeze(["security", "release-metadata"]),
  ".github/workflows/release.yml": Object.freeze(["security", "release-metadata", "publish"]),
});
const JOBS = [
  "node", "php", "java", "conformance", "dashboard", "widget", "widget-panel", "deployment", "skills", "security", "release-metadata",
];

function readYaml(relativePath) {
  const document = parseDocument(readFileSync(resolve(ROOT, relativePath), "utf8"), {
    prettyErrors: false,
    uniqueKeys: true,
  });
  assert.deepEqual(document.errors, []);
  return document.toJS({ maxAliasCount: 0 });
}

test("CI exposes the bounded, read-only product and release gates", () => {
  const workflow = readYaml(".github/workflows/ci.yml");
  assert.equal(workflow.name, "ci");
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency.group, "ci-${{ github.workflow }}-${{ github.ref }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...JOBS].sort());

  assert.deepEqual(workflow.jobs.node.strategy.matrix.node, ["24.20.0", "25.9.0", "26.8.1"]);
  assert.equal(workflow.jobs.node.strategy["fail-fast"], false);

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(
      job["runs-on"],
      jobName === "skills" ? "${{ matrix.os }}" : LINUX_RUNNER,
      `${jobName} runner`,
    );
    assert.equal(Number.isInteger(job["timeout-minutes"]), true, `${jobName} timeout`);
    assert.equal(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 90, true, `${jobName} bounded timeout`);
    assert.deepEqual(
      job.permissions,
      ["deployment", "security", "release-metadata"].includes(jobName)
        ? { contents: "read", packages: "read" }
        : undefined,
      `${jobName} permissions`,
    );
    assert.equal(Array.isArray(job.steps) && job.steps.length > 0, true, `${jobName} steps`);
    const checkouts = job.steps.filter(({ uses }) => typeof uses === "string" && /^[^@]+\/checkout@/u.test(uses));
    assert.equal(checkouts.length, 1, `${jobName} single checkout`);
    assert.match(checkouts[0].uses, jobName === "skills" ? GITHUB_CHECKOUT : BLACKSMITH_CHECKOUT, `${jobName} checkout action`);
    assert.equal(checkouts[0].with?.["persist-credentials"], false, `${jobName} checkout credentials`);
    for (const step of job.steps) {
      if (step.uses !== undefined) assert.match(step.uses, ACTION_SHA, `${jobName}: ${step.uses}`);
      const serialized = JSON.stringify(step);
      assert.doesNotMatch(serialized, /secrets\.|NPM_TOKEN|DEPLOY_KEY|pull_request_target/i);
    }
  }
  assert.deepEqual(workflow.jobs.skills.strategy, {
    "fail-fast": false,
    matrix: { os: [LINUX_RUNNER, MACOS_RUNNER] },
  });
  const skillEvaluationStep = workflow.jobs.skills.steps.find(({ run }) => run?.includes("pnpm skills:test-evals"));
  assert.equal(skillEvaluationStep?.if, "runner.os == 'Linux'");
  assert.match(skillEvaluationStep?.run ?? "", /pnpm skills:test-evals\s*&&\s*pnpm skills:validate/u);
  const portableSkillStep = workflow.jobs.skills.steps.find(({ run }) => run?.includes("pnpm skills:test-install"));
  assert.equal(portableSkillStep?.if, undefined);
  assert.match(portableSkillStep?.run ?? "", /pnpm skills:validate/u);
  assert.doesNotMatch(portableSkillStep?.run ?? "", /pnpm skills:test-evals/u);

  const commands = Object.fromEntries(
    Object.entries(workflow.jobs).map(([name, job]) => [name, job.steps.map(({ run }) => run ?? "").join("\n")]),
  );
  for (const [jobName, source] of Object.entries(commands)) {
    assert.doesNotMatch(source, /\bpnpm\s+[A-Za-z0-9:_-]+\s+--\s+--/u, `${jobName} pnpm argument forwarding`);
  }
  assert.match(commands.node, /pnpm install --frozen-lockfile/);
  assert.match(commands.node, /pnpm verify:protocol-sdk/);
  assert.match(commands.php, /pnpm test:php:compatibility/);
  assert.match(commands.java, /pnpm test:java:release/);
  assert.match(commands.conformance, /pnpm verify:official-adapters/);
  assert.match(commands.dashboard, /playwright install --with-deps chromium/);
  const dashboardBuild = workflow.jobs.dashboard.steps.findIndex(
    ({ run }) => run === 'pnpm --filter "@8lines/gauntlet-dashboard..." build',
  );
  const dashboardE2e = workflow.jobs.dashboard.steps.findIndex(
    ({ run }) => run === "pnpm dashboard:test:e2e",
  );
  assert.equal(dashboardBuild >= 0 && dashboardBuild < dashboardE2e, true, "dashboard is built before E2E");
  assert.match(commands.dashboard, /pnpm dashboard:test:e2e/);
  assert.match(commands.widget, /pnpm --filter @8lines\/gauntlet-widget-loader exec playwright install --with-deps chromium/);
  const widgetBuild = workflow.jobs.widget.steps.findIndex(
    ({ run }) => run === 'pnpm --filter "@8lines/gauntlet-widget-loader..." build',
  );
  const widgetE2e = workflow.jobs.widget.steps.findIndex(({ run }) => run === "pnpm widget:test:e2e");
  assert.equal(widgetBuild >= 0 && widgetBuild < widgetE2e, true, "widget loader is built before E2E");
  assert.match(commands["widget-panel"], /pnpm --filter @8lines\/gauntlet-dashboard exec playwright install --with-deps chromium/);
  const widgetPanelBuild = workflow.jobs["widget-panel"].steps.findIndex(
    ({ run }) => run === 'pnpm --filter "@8lines/gauntlet-dashboard..." --filter "@8lines/gauntlet-server..." --filter "@8lines/gauntlet-node-example..." build',
  );
  const widgetPanelE2e = workflow.jobs["widget-panel"].steps.findIndex(({ run }) => run === "pnpm widget:test:e2e:panel");
  assert.equal(
    widgetPanelBuild >= 0 && widgetPanelBuild < widgetPanelE2e,
    true,
    "the panel, the control plane and the example adapter are built before the widget E2E",
  );
  assert.match(commands.deployment, /pnpm test:image/);
  assert.match(commands.deployment, /pnpm test:compose:distribution/);
  assert.match(commands.deployment, /pnpm test:helm/);
  assert.match(commands.skills, /pnpm skills:test-install/);
  assert.match(commands.skills, /pnpm skills:test-evals/);
  assert.match(commands.skills, /pnpm skills:validate/);
  assert.match(commands.skills, /pnpm docs:check/);
  assert.match(commands.skills, /apt-get install --yes --no-install-recommends acl/u);
  assert.match(commands.security, /pnpm release:stage/);
  assert.match(
    commands.security,
    /pnpm release:security --image-archive "\.artifacts\/release\/\$VERSION\/image\/gauntlet-\$VERSION\.docker\.tar"/u,
  );
  assert.doesNotMatch(commands.security, /--source-only/u);
  assert.match(commands["release-metadata"], /playwright install --with-deps chromium/);
  assert.match(commands["release-metadata"], /pnpm release:dry-run/);
  const metadataSteps = workflow.jobs["release-metadata"].steps;
  const metadataBuild = metadataSteps.findIndex(({ run }) => run === "pnpm build");
  const metadataPreload = metadataSteps.findIndex(({ run }) => run === "node scripts/prepare-ci-images.mjs");
  const releaseTests = metadataSteps.findIndex(({ run }) => /(?:^|&&\s*)pnpm release:test$/u.test(run ?? ""));
  assert.equal(releaseTests >= 0, true, "release-metadata runs the release unit tests");
  assert.equal(metadataBuild >= 0 && metadataBuild < releaseTests, true, "release packages are built before release tests");
  assert.equal(metadataPreload >= 0 && metadataPreload < releaseTests, true, "pinned images are preloaded before release tests");
});

test("every action reference is pinned to a full commit SHA with an exact version comment", () => {
  for (const path of Object.keys(MULTI_PLATFORM_JOBS)) {
    const lines = readFileSync(resolve(ROOT, path), "utf8").split("\n").filter((line) => /^\s*(?:-\s+)?uses:/u.test(line));
    assert.equal(lines.length > 0, true, `${path} uses lines`);
    for (const line of lines) assert.match(line, PINNED_USES_LINE, `${path}: ${line.trim()}`);
  }
});

test("multi-platform image jobs use the pinned QEMU and Buildx builder instead of a hosted builder", () => {
  for (const [path, jobNames] of Object.entries(MULTI_PLATFORM_JOBS)) {
    const source = readFileSync(resolve(ROOT, path), "utf8");
    assert.doesNotMatch(source, /useblacksmith\/setup-docker-builder/u, `${path} hosted builder`);
    assert.doesNotMatch(source, /buildkitd\.toml/u, `${path} builder configuration in the source tree`);
    const workflow = readYaml(path);
    for (const jobName of jobNames) {
      const steps = workflow.jobs[jobName].steps;
      const qemu = steps.findIndex(({ uses }) => uses === QEMU_STEP.uses);
      const buildx = steps.findIndex(({ uses }) => uses === BUILDX_STEP.uses);
      assert.equal(qemu >= 0, true, `${path} ${jobName} QEMU`);
      assert.equal(buildx > qemu, true, `${path} ${jobName} Buildx after QEMU`);
      assert.deepEqual(steps[qemu].with, QEMU_STEP.with, `${path} ${jobName} pinned binfmt`);
      assert.deepEqual(steps[buildx].with, BUILDX_STEP.with, `${path} ${jobName} pinned Buildx and BuildKit`);
      const firstDockerWork = steps.findIndex(({ run }) => run === "node scripts/prepare-ci-images.mjs");
      assert.equal(firstDockerWork > buildx, true, `${path} ${jobName} builder before Docker work`);
      assert.equal(
        steps.filter(({ uses }) => typeof uses === "string" && /^docker\/setup-(?:qemu|buildx)-action@/u.test(uses)).length,
        2,
        `${path} ${jobName} exactly one QEMU and one Buildx setup`,
      );
    }
  }
});

test("every job that runs the release unit tests builds the workspace and preloads images first", () => {
  for (const path of Object.keys(MULTI_PLATFORM_JOBS)) {
    const workflow = readYaml(path);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const runsReleaseTests = (run) => /\bpnpm release:(?:test|dry-run)\b/u.test(run ?? "");
      const first = job.steps.findIndex(({ run }) => runsReleaseTests(run));
      if (first === -1) continue;
      const build = job.steps.findIndex(({ run }) => run === "pnpm build");
      const preload = job.steps.findIndex(({ run }) => run === "node scripts/prepare-ci-images.mjs");
      assert.equal(build >= 0 && build < first, true, `${path} ${jobName} builds before release tests`);
      assert.equal(preload >= 0 && preload < first, true, `${path} ${jobName} preloads images before release tests`);
    }
  }
});

test("the CI image preload covers the pinned Maven toolchain for its exact platform", async () => {
  const { CI_IMAGES, pullArguments } = await import("../../prepare-ci-images.mjs");
  const { MAVEN_TOOLCHAIN } = await import("../stage-maven.mjs");
  assert.equal(Object.isFrozen(CI_IMAGES), true);
  const maven = CI_IMAGES.find(({ image }) => image === MAVEN_TOOLCHAIN.image);
  assert.deepEqual(maven, { image: MAVEN_TOOLCHAIN.image, platform: MAVEN_TOOLCHAIN.platform });
  assert.deepEqual(pullArguments(maven), ["image", "pull", "--platform", "linux/amd64", MAVEN_TOOLCHAIN.image]);
  for (const { image } of CI_IMAGES) assert.match(image, /@sha256:[0-9a-f]{64}$/u, image);
});

test("release workflows use pnpm's direct option forwarding contract", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const source = readFileSync(resolve(ROOT, path), "utf8");
    assert.doesNotMatch(source, /\bpnpm\s+[A-Za-z0-9:_-]+\s+--\s+--/u, path);
    assert.match(source, /pnpm verify:protocol-sdk --node-only/u, path);
    assert.match(source, /pnpm release:stage --output /u, path);
    assert.match(source, /pnpm release:security --image-archive /u, path);
    const workflow = readYaml(path);
    const installSteps = Object.values(workflow.jobs).flatMap((job) => job.steps)
      .filter(({ run }) => typeof run === "string" && run.startsWith("pnpm install "));
    assert.equal(installSteps.length, Object.keys(workflow.jobs).length, `${path} install coverage`);
    for (const step of installSteps) {
      assert.equal(
        step.run,
        "pnpm install --frozen-lockfile --package-import-method=copy",
        `${path} hardlink-free install`,
      );
    }

    const imageJobs = path.endsWith("ci.yml")
      ? ["deployment", "security", "release-metadata"]
      : ["deployment", "security", "release-metadata", "publish"];
    for (const jobName of imageJobs) {
      const steps = workflow.jobs[jobName].steps;
      const installIndex = steps.findIndex(({ run }) => run === "pnpm install --frozen-lockfile --package-import-method=copy");
      const loginIndex = steps.findIndex(({ uses }) => uses === DOCKER_LOGIN_ACTION);
      const preloadIndex = steps.findIndex(({ run }) => run === "node scripts/prepare-ci-images.mjs");
      assert.equal(
        installIndex >= 0 && installIndex < loginIndex && loginIndex < preloadIndex,
        true,
        `${path} ${jobName} image preparation order`,
      );
      assert.deepEqual(steps[loginIndex].with, {
        registry: "ghcr.io",
        username: "${{ github.actor }}",
        password: "${{ github.token }}",
      });
      assert.equal(workflow.jobs[jobName].permissions?.packages, jobName === "publish" ? "write" : "read");
    }

    const dryRuns = Object.values(workflow.jobs).flatMap((job) => job.steps)
      .filter(({ run }) => typeof run === "string" && run.includes("pnpm release:dry-run"));
    assert.equal(dryRuns.length > 0, true, `${path} dry-runs`);
    for (const step of dryRuns) {
      assert.equal(step.env?.PLAYWRIGHT_BROWSER_CHANNEL, "chromium", `${path} explicit dry-run browser`);
    }
  }
});

test("Dependabot covers every package ecosystem without automatic merge", () => {
  const config = readYaml(".github/dependabot.yml");
  assert.equal(config.version, 2);
  const actual = config.updates.map((entry) => `${entry["package-ecosystem"]}:${entry.directory}`).sort();
  assert.deepEqual(actual, [
    "composer:/examples/symfony",
    "composer:/packages/php/core",
    "composer:/packages/php/symfony-bundle",
    "docker:/",
    "docker:/packages/php",
    "github-actions:/",
    "gradle:/packages/java",
    "npm:/",
  ]);
  for (const entry of config.updates) {
    assert.deepEqual(entry.schedule, { interval: "weekly" });
    assert.equal(Number.isInteger(entry["open-pull-requests-limit"]), true);
    assert.equal(entry["open-pull-requests-limit"] > 0 && entry["open-pull-requests-limit"] <= 10, true);
    assert.equal(entry["auto-merge"], undefined);
  }
});

test("every workflow-facing gate resolves to one exact local root script", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const expected = {
    "verify:protocol-sdk": "node scripts/release/verify-protocol-sdk.mjs",
    "test:php:compatibility": "node scripts/release/test-php-compatibility.mjs",
    "test:composer:consumer": "node scripts/release/test-composer-consumer.mjs",
    "test:java:release": "node scripts/release/test-java-release.mjs",
    "test:java:source": "node scripts/release/test-java-source.mjs",
    "verify:official-adapters": "node scripts/release/verify-official-adapters.mjs",
    "dashboard:test:e2e": "pnpm --filter @8lines/gauntlet-dashboard exec playwright test --reporter=line",
    "release:security": "node scripts/release/security.mjs",
    "release:stage": "node scripts/release/stage.mjs",
    "release:verify": "node scripts/release/verify.mjs",
    "release:dry-run": "node scripts/release/dry-run.mjs",
    "release:verify-inventory": "node scripts/release/verify-inventory.mjs",
    "release:discard-staged": "node scripts/release/discard-staged.mjs",
    "skills:validate": "node scripts/skills/validate.mjs",
    "skills:test-install": "node --test scripts/skills/test/*.test.mjs",
    "skills:test-evals": "node --test --test-concurrency=1 skill-evals/gauntlet-app-integration/test/*.test.mjs skill-evals/gauntlet-extension-authoring/test/*.test.mjs",
    "docs:check": "node scripts/docs/check-docs.mjs && node --test scripts/docs/test/*.test.mjs",
    "docs:verify-commands": "node scripts/docs/verify-documented-commands.mjs",
  };
  for (const [name, command] of Object.entries(expected)) {
    assert.equal(manifest.scripts?.[name], command, name);
  }
  assert.match(manifest.scripts?.["validate:sdk"] ?? "", /pnpm test:java:source/u);
  assert.doesNotMatch(manifest.scripts?.["validate:sdk"] ?? "", /gradle:[^@\s]+(?:\s|$)/u);
});
