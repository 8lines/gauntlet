import assert from "node:assert/strict";
import test from "node:test";

import {
  DRY_RUN_PHASE_TIMEOUT_MS,
  LOCAL_REGISTRY_IMAGE,
  assertLocalRegistryInvocation,
  createLocalRegistryPlan,
  parseDryRunArguments,
  runDryRun,
  runDryRunCli,
} from "../dry-run.mjs";
import { allUnitsPlan, createReleasePlan } from "../plan.mjs";
import { RELEASE_UNITS, dependencyOrder, unitById } from "../units.mjs";
import { phasesForUnits } from "../verify.mjs";

const ROOT = "/workspace/gauntlet";
const VERSION = "0.1.0";
const COMMIT = "1".repeat(40);
const SET = "local-111111111111";
const RELEASE_ROOT = `${ROOT}/.artifacts/release/${SET}`;
const STAGED_UNITS = Object.freeze(dependencyOrder().map((id) => Object.freeze({ id, version: VERSION })));
const REPORTED_UNITS = Object.freeze(STAGED_UNITS.map(({ id, version }) => ({ id, version, tag: `${unitById(id).tagPrefix}${version}` })));
const TOKEN = "a".repeat(32);
const CONTAINER_ID = "b".repeat(64);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const MANIFEST_IMAGE_ID = `sha256:${"9".repeat(64)}`;
const PUSH_DIGEST = `sha256:${"d".repeat(64)}`;
const MANIFEST_SHA256 = "e".repeat(64);
const CHECKSUMS_SHA256 = "f".repeat(64);
const NATIVE_SHA256 = "1".repeat(64);
const OCI_SHA256 = "2".repeat(64);
const CHART_SHA256 = "3".repeat(64);
const REGISTRY_IMAGE = "registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e";
const PHASES = [
  "source", "node", "php", "java", "conformance", "skills", "dashboard", "image", "compose", "helm",
  "security", "packages", "inventory", "documentation",
];
const ALL_UNITS_PLAN = allUnitsPlan(new Map(RELEASE_UNITS.map(({ id }) => [id, VERSION])));
const ALL_UNITS = () => ({ plan: ALL_UNITS_PLAN, path: null });
const PHP_PLAN = createReleasePlan([{ id: "php-core", from: "0.1.0", to: "0.1.1" }]);

function commandResult(stdout = "", overrides = {}) {
  return { status: 0, signal: null, stdout, stderr: "", ...overrides };
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function versionReport(version = VERSION) {
  return jsonLine({ command: "check", mismatches: [], ok: true, tag: null, version });
}

function developmentReport(version = VERSION, { units = ALL_UNITS_PLAN.order } = {}) {
  const partial = new Set(["php", "java", "security", "packages", "documentation"]);
  const needed = new Set(phasesForUnits(units));
  return jsonLine({
    schemaVersion: 1,
    mode: "development",
    scope: "source-only",
    status: "partial",
    ok: false,
    sourceChecksOk: true,
    releaseReady: false,
    version,
    units,
    phases: PHASES.map((name) => !needed.has(name)
      ? { name, status: "skipped", reason: "not-in-release-plan", commands: 0 }
      : name === "inventory"
        ? { name, status: "not-run", reason: "excluded-in-development-mode", commands: 0 }
        : partial.has(name)
          ? { name, status: "partial", reason: "release-evidence-excluded", commands: 1, excluded: `${name}-release` }
          : { name, status: "passed", commands: 1 }),
  });
}

function securityReport() {
  const names = [
    "source-snapshot", "composer-audit", "credential-material", "pnpm-audit", "production-defaults",
    "trivy-filesystem", "trivy-image",
  ];
  return jsonLine({
    schemaVersion: 1,
    mode: "release",
    scope: "exact-commit-and-staged-image",
    sourceCommit: COMMIT,
    sourceChecksOk: true,
    ok: true,
    checks: names.map((name) => ({ name, required: true, status: "passed" })),
    reports: [
      "composer-audit.json",
      "credential-material.json",
      "pnpm-audit.json",
      "production-defaults.json",
      "source-snapshot.json",
      "trivy-filesystem.json",
      "trivy-image.json",
    ],
  });
}

function stageOutput(overrides = {}) {
  return jsonLine({
    artifacts: 19,
    outputDirectory: RELEASE_ROOT,
    releaseSet: SET,
    sourceCommit: COMMIT,
    units: STAGED_UNITS,
    ...overrides,
  });
}

function inventoryReport(overrides = {}) {
  return jsonLine({
    schemaVersion: 2,
    ok: true,
    releaseSet: SET,
    sourceCommit: COMMIT,
    units: REPORTED_UNITS,
    artifacts: 19,
    manifestSha256: MANIFEST_SHA256,
    checksumsSha256: CHECKSUMS_SHA256,
    nativeImage: {
      path: `image/gauntlet-${VERSION}.docker.tar`,
      sha256: NATIVE_SHA256,
    },
    multiPlatformOci: {
      path: `image/gauntlet-${VERSION}.oci.tar`,
      sha256: OCI_SHA256,
      platforms: ["linux/amd64", "linux/arm64"],
      verification: "deeply-validated-during-staging",
    },
    helmChart: {
      path: `helm/gauntlet-${VERSION}.tgz`,
      sha256: CHART_SHA256,
    },
    ...overrides,
  });
}

function archiveInspector() {
  return Object.freeze({
    platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
    runtimeImageIds: Object.freeze([IMAGE_ID, MANIFEST_IMAGE_ID]),
    tag: `gauntlet.local/gauntlet:${VERSION}`,
  });
}

function fakeWorkspace({ occupied = false, removeFails = false } = {}) {
  const events = [];
  const owned = {
    root: `/tmp/gauntlet-release-dry-run-${TOKEN}`,
    registryStorage: `/tmp/gauntlet-release-dry-run-${TOKEN}/registry`,
    helmPullDirectory: `/tmp/gauntlet-release-dry-run-${TOKEN}/helm-pull`,
    token: TOKEN,
    device: "42",
    inode: "73",
    uid: 501,
    gid: 20,
  };
  return {
    events,
    owned,
    lifecycle: {
      outputExists: async (releaseRoot) => {
        events.push(["output-exists", releaseRoot]);
        return occupied;
      },
      create: async () => {
        events.push(["create", owned.root]);
        return owned;
      },
      remove: async (value) => {
        events.push(["remove", value.root]);
        if (removeFails) throw new Error("private temp cleanup detail");
      },
    },
  };
}

function createSuccessfulRunner(calls, {
  headSequence = [COMMIT],
  helmStatusChannel = "stdout",
  orbStackAbsenceOutput = false,
  override,
  registryStartStderr = "",
  runtimeImageId = IMAGE_ID,
} = {}) {
  const images = new Set();
  let containerExists = false;
  let headIndex = 0;
  const containerName = `gauntlet-release-registry-${TOKEN.slice(0, 24)}`;
  const registryTag = `127.0.0.1:49152/gauntlet:${VERSION}`;
  const registryDigest = `127.0.0.1:49152/gauntlet@${PUSH_DIGEST}`;
  const sourceTag = `gauntlet.local/gauntlet:${VERSION}`;
  const chartReference = `127.0.0.1:49152/gauntlet-charts/gauntlet:${VERSION}`;
  return async (invocation) => {
    calls.push(structuredClone(invocation));
    const replacement = override?.(invocation, { images, containerExists });
    if (replacement !== undefined) return replacement;
    const { command, args } = invocation;

    if (command === "git" && args.includes("--show-toplevel")) return commandResult(`${ROOT}\n`);
    if (command === "git" && args.includes("HEAD^{commit}")) {
      const value = headSequence[Math.min(headIndex, headSequence.length - 1)];
      headIndex += 1;
      return commandResult(`${value}\n`);
    }
    if (command === "git" && args.includes("status")) return commandResult();
    if (command === process.execPath && args[0]?.endsWith("/version.mjs")) return commandResult(versionReport());
    if (command === process.execPath && args[0]?.endsWith("/verify.mjs")) return commandResult(developmentReport());
    if (command === "pnpm" && ["test:composer:consumer", "test:java:release"].includes(args[0])) return commandResult();
    if (command === process.execPath && args[0]?.endsWith("/stage.mjs")) return commandResult(stageOutput());
    if (command === process.execPath && args[0]?.endsWith("/security.mjs")) return commandResult(securityReport());
    if (command === process.execPath && args[0]?.endsWith("/verify-inventory.mjs")) return commandResult(inventoryReport());
    if (command === "pnpm" && args[0] === "docs:verify-commands") {
      return commandResult(jsonLine({ exitCode: 0, ok: true }), {
        stderr: `$ node scripts/docs/verify-documented-commands.mjs --release-root .artifacts/release/${SET}\n`,
      });
    }
    if (command === "docker" && args[0] === "context") return commandResult('"unix:///var/run/docker.sock"\n');
    if (command === "docker" && args[0] === "container" && args[1] === "inspect" && !args.includes("--format")) {
      return commandResult(orbStackAbsenceOutput ? "[]\n" : "", {
        status: 1,
        stderr: `Error: No such container: ${containerName}\n`,
      });
    }
    if (command === "docker" && args[0] === "run") {
      containerExists = true;
      return commandResult(`${CONTAINER_ID}\n`, { stderr: registryStartStderr });
    }
    if (command === "docker" && args[0] === "port") return commandResult("127.0.0.1:49152\n");
    if (command === "curl") return commandResult("{}\n");
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
      const reference = args[2];
      return images.has(reference)
        ? commandResult(`${runtimeImageId}\n`)
        : commandResult(orbStackAbsenceOutput ? "\n" : "", {
          status: 1,
          stderr: `Error: No such image: ${reference}\n`,
        });
    }
    if (command === "docker" && args[0] === "load") {
      images.add(sourceTag);
      return commandResult(`Loaded image: ${sourceTag}\n`);
    }
    if (command === "docker" && args[0] === "image" && args[1] === "tag") {
      assert.equal(images.has(args[2]), true);
      images.add(args[3]);
      return commandResult();
    }
    if (command === "docker" && args[0] === "image" && args[1] === "push") {
      return commandResult(`The push refers to repository [${registryTag.slice(0, registryTag.lastIndexOf(":"))}]\n${VERSION}: digest: ${PUSH_DIGEST} size: 1987\n`);
    }
    if (command === "docker" && args[0] === "image" && args[1] === "rm") {
      images.delete(args[2]);
      return commandResult(`Untagged: ${args[2]}\n`);
    }
    if (command === "docker" && args[0] === "image" && args[1] === "pull") {
      images.add(registryDigest);
      return commandResult(`Digest: ${PUSH_DIGEST}\nStatus: Downloaded newer image for ${registryDigest}\n`);
    }
    if (command === "helm" && args[0] === "push") {
      const output = `Pushed: ${chartReference}\nDigest: ${PUSH_DIGEST}\n`;
      return helmStatusChannel === "stderr" ? commandResult("", { stderr: output }) : commandResult(output);
    }
    if (command === "helm" && args[0] === "pull") {
      const output = `Pulled: ${chartReference}\nDigest: ${PUSH_DIGEST}\n`;
      return helmStatusChannel === "stderr" ? commandResult("", { stderr: output }) : commandResult(output);
    }
    if (command === "helm" && args[0] === "show") {
      return commandResult("apiVersion: v2\nname: gauntlet\nversion: 0.1.0\nappVersion: 0.1.0\n");
    }
    if (command === "docker" && args[0] === "container" && args[1] === "inspect" && args.includes("--format")) {
      return containerExists
        ? commandResult(`${TOKEN}\n`)
        : commandResult("", { status: 1, stderr: `Error: No such container: ${containerName}\n` });
    }
    if (command === "docker" && args[0] === "rm") {
      containerExists = false;
      return commandResult(`${containerName}\n`);
    }
    throw new Error(`unexpected fake invocation: ${command} ${args.join(" ")}`);
  };
}

test("uses a pinned registry and permits only task-owned loopback registry commands", () => {
  assert.equal(LOCAL_REGISTRY_IMAGE, REGISTRY_IMAGE);
  assert.deepEqual(parseDryRunArguments([]), { planPath: null, releaseSet: null });
  for (const invalid of [["--help"], ["--keep"], [undefined], ""] ) {
    assert.throws(() => parseDryRunArguments(invalid), /Usage: dry-run\.mjs/u);
  }

  const workspace = fakeWorkspace().owned;
  const plan = createLocalRegistryPlan({
    root: ROOT,
    releaseRoot: RELEASE_ROOT,
    version: VERSION,
    workspace,
    port: 49152,
  });
  assert.equal(plan.imageArchive, `${RELEASE_ROOT}/image/gauntlet-${VERSION}.docker.tar`);
  assert.equal(plan.chartArchive, `${RELEASE_ROOT}/helm/gauntlet-${VERSION}.tgz`);
  assert.equal(
    createLocalRegistryPlan({
      root: ROOT, releaseRoot: `${ROOT}/.artifacts/release/release-2026-10-03.1`, version: VERSION, workspace, port: 49152,
    }).imageArchive,
    `${ROOT}/.artifacts/release/release-2026-10-03.1/image/gauntlet-${VERSION}.docker.tar`,
  );
  for (const releaseRoot of [
    `${ROOT}/.artifacts/release/${VERSION}`,
    `${ROOT}/.artifacts/release/local-1111`,
    `${ROOT}/.artifacts/other/${SET}`,
    `/tmp/.artifacts/release/${SET}`,
  ]) {
    assert.throws(
      () => createLocalRegistryPlan({ root: ROOT, releaseRoot, version: VERSION, workspace, port: 49152 }),
      /Local registry plan is invalid/u,
      releaseRoot,
    );
  }
  assert.equal(plan.start.command, "docker");
  assert.equal(plan.start.args.includes(REGISTRY_IMAGE), true);
  assert.equal(plan.start.args.includes("127.0.0.1::5000"), true);
  assert.equal(plan.imageTag, `127.0.0.1:49152/gauntlet:${VERSION}`);
  assert.equal(plan.chartRepository, "oci://127.0.0.1:49152/gauntlet-charts");
  for (const invocation of plan.commands) assert.doesNotThrow(() => assertLocalRegistryInvocation(invocation, plan));

  const executable = plan.commands.map(({ command, args }) => [command, ...args].join(" ")).join("\n");
  assert.doesNotMatch(executable, /docker login|npm publish|git push|gh api|kubectl|helm install/u);
  assert.doesNotMatch(executable, /(?:docker image push|docker image pull|helm push|helm pull).*ghcr\.io/u);
  assert.throws(
    () => assertLocalRegistryInvocation({ command: "docker", args: ["image", "push", "ghcr.io/8lines/gauntlet:0.1.0"], workingDirectory: ROOT }, plan),
    /Local registry command is not allowed/u,
  );
  assert.throws(
    () => assertLocalRegistryInvocation({ command: "kubectl", args: ["apply", "-f", "release.yaml"], workingDirectory: ROOT }, plan),
    /Local registry command is not allowed/u,
  );
});

test("the complete dry-run orders every gate, rechecks source identity, and cleans only owned resources", async () => {
  const calls = [];
  const workspace = fakeWorkspace();
  const report = await runDryRun({ readPlan: ALL_UNITS,
    root: ROOT,
    runner: createSuccessfulRunner(calls),
    workspace: workspace.lifecycle,
    archiveInspector,
  });

  const rendered = calls.map(({ command, args }) => [command, ...args].join(" "));
  const index = (needle) => rendered.findIndex((line) => line.includes(needle));
  assert.ok(index("scripts/release/verify.mjs") < index("test:composer:consumer"));
  assert.ok(index("test:composer:consumer") < index("test:java:release"));
  assert.ok(index("test:java:release") < index("scripts/release/stage.mjs"));
  assert.ok(index("scripts/release/stage.mjs") < index("scripts/release/security.mjs"));
  assert.ok(index("scripts/release/security.mjs") < index("scripts/release/verify-inventory.mjs"));
  assert.ok(index("scripts/release/verify-inventory.mjs") < index("docs:verify-commands"));
  assert.equal(rendered.some((line) => line.includes("sha256sum")), false);
  assert.ok(index("docs:verify-commands") < index(`docker run --detach`));
  assert.equal(rendered.includes(`pnpm docs:verify-commands --release-root .artifacts/release/${SET}`), true);
  const stageCall = calls.find(({ args }) => args[0]?.endsWith("/stage.mjs"));
  assert.deepEqual(stageCall.args, [`${ROOT}/scripts/release/stage.mjs`, "--output", RELEASE_ROOT, "--release-set", SET]);
  assert.deepEqual(calls.find(({ args }) => args[0]?.endsWith("/verify.mjs")).args, [`${ROOT}/scripts/release/verify.mjs`]);
  assert.equal(rendered.some((line) => line.includes("--plan")), false);
  assert.deepEqual(report.units, ALL_UNITS_PLAN.units);
  assert.equal(
    rendered.includes(`${process.execPath} ${ROOT}/scripts/release/security.mjs --image-archive .artifacts/release/${SET}/image/gauntlet-${VERSION}.docker.tar`),
    true,
  );
  assert.equal(rendered.includes(`${process.execPath} ${ROOT}/scripts/release/verify-inventory.mjs --release-root ${RELEASE_ROOT}`), true);
  assert.ok(index("docker image push 127.0.0.1:49152") < index("helm push"));
  assert.equal(calls.filter(({ command, args }) => command === "git" && args.includes("HEAD^{commit}")).length, 3);
  assert.equal(calls.filter(({ command, args }) => command === "git" && args.includes("status")).length, 3);
  assert.equal(rendered.some((line) => /docker login|git (?:commit|push)|kubectl/u.test(line)), false);
  assert.equal(rendered.some((line) => /docker image (?:push|pull) (?!127\.0\.0\.1:)/u.test(line)), false);

  assert.deepEqual(report.phases.map(({ name, status }) => [name, status]), PHASES.map((name) => [name, "passed"]));
  assert.deepEqual({
    mode: report.mode,
    scope: report.scope,
    status: report.status,
    ok: report.ok,
    sourceChecksOk: report.sourceChecksOk,
    releaseReady: report.releaseReady,
    version: report.version,
    sourceCommit: report.sourceCommit,
    releaseSet: report.releaseSet,
  }, {
    mode: "dry-run",
    scope: "complete-local-rehearsal",
    status: "passed",
    ok: true,
    sourceChecksOk: true,
    releaseReady: true,
    version: VERSION,
    sourceCommit: COMMIT,
    releaseSet: SET,
  });
  assert.deepEqual(report.evidence, {
    inventory: {
      artifacts: 19,
      manifestSha256: MANIFEST_SHA256,
      checksumsSha256: CHECKSUMS_SHA256,
    },
    localRegistryRehearsal: {
      scope: "host-platform-native-image-and-version-bound-helm-chart",
      nativeImage: {
        path: `image/gauntlet-${VERSION}.docker.tar`,
        sha256: NATIVE_SHA256,
        platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
        pushedDigest: PUSH_DIGEST,
        pulledDigest: PUSH_DIGEST,
      },
      multiPlatformOci: {
        path: `image/gauntlet-${VERSION}.oci.tar`,
        sha256: OCI_SHA256,
        platforms: ["linux/amd64", "linux/arm64"],
        verification: "deeply-validated-during-staging",
        registryRehearsal: "not-pushed-or-pulled-locally",
      },
      helmChart: {
        path: `helm/gauntlet-${VERSION}.tgz`,
        sha256: CHART_SHA256,
        pushedDigest: PUSH_DIGEST,
        pulledBy: `version:${VERSION}`,
      },
    },
  });
  assert.deepEqual(workspace.events, [
    ["output-exists", RELEASE_ROOT],
    ["create", workspace.owned.root],
    ["remove", workspace.owned.root],
  ]);
  assert.equal(rendered.some((line) => line === `docker rm --force gauntlet-release-registry-${TOKEN.slice(0, 24)}`), true);
  assert.equal(rendered.some((line) => line === `docker image rm gauntlet.local/gauntlet:${VERSION}`), true);
});

test("the complete dry-run accepts the verified manifest digest reported by OrbStack", async () => {
  const calls = [];
  const workspace = fakeWorkspace();
  const report = await runDryRun({ readPlan: ALL_UNITS,
    root: ROOT,
    runner: createSuccessfulRunner(calls, {
      orbStackAbsenceOutput: true,
      runtimeImageId: MANIFEST_IMAGE_ID,
    }),
    workspace: workspace.lifecycle,
    archiveInspector,
  });

  assert.equal(report.releaseReady, true);
  assert.equal(calls.some(({ command, args }) => command === "docker"
    && args[0] === "image" && args[1] === "rm"
    && args[2] === `gauntlet.local/gauntlet:${VERSION}`), true);
});

test("the complete dry-run accepts canonical Helm 4 push and pull evidence on stderr", async () => {
  const calls = [];
  const workspace = fakeWorkspace();
  const report = await runDryRun({ readPlan: ALL_UNITS,
    root: ROOT,
    runner: createSuccessfulRunner(calls, { helmStatusChannel: "stderr" }),
    workspace: workspace.lifecycle,
    archiveInspector,
  });

  assert.equal(report.releaseReady, true);
});

test("the complete dry-run accepts cold-cache pull progress from the pinned registry image", async () => {
  const calls = [];
  const workspace = fakeWorkspace();
  const report = await runDryRun({ readPlan: ALL_UNITS,
    root: ROOT,
    runner: createSuccessfulRunner(calls, {
      registryStartStderr: `Unable to find image '${REGISTRY_IMAGE}' locally\nDigest: ${REGISTRY_IMAGE.slice(REGISTRY_IMAGE.indexOf("sha256:"))}\n`,
    }),
    workspace: workspace.lifecycle,
    archiveInspector,
  });

  assert.equal(report.releaseReady, true);
});

test("the dry-run rejects malformed runtime image identity evidence before docker mutation", async () => {
  const invalidLists = [
    [IMAGE_ID],
    [IMAGE_ID, IMAGE_ID],
    [IMAGE_ID, `sha256:${"z".repeat(64)}`],
    [IMAGE_ID, MANIFEST_IMAGE_ID, `sha256:${"8".repeat(64)}`],
  ];

  for (const runtimeImageIds of invalidLists) {
    const calls = [];
    const workspace = fakeWorkspace();
    await assert.rejects(
      runDryRun({ readPlan: ALL_UNITS,
        root: ROOT,
        runner: createSuccessfulRunner(calls),
        workspace: workspace.lifecycle,
        archiveInspector: () => ({
          platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
          runtimeImageIds,
          tag: `gauntlet.local/gauntlet:${VERSION}`,
        }),
      }),
      (error) => error.code === "OUTPUT_INVALID" && error.phase === "image",
    );
    assert.equal(calls.some(({ command }) => command === "docker"), false);
  }
});

test("dirty source and occupied release output short-circuit before any mutation", async () => {
  const dirtyCalls = [];
  const dirtyWorkspace = fakeWorkspace();
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS,
      root: ROOT,
      workspace: dirtyWorkspace.lifecycle,
      runner: createSuccessfulRunner(dirtyCalls, {
        override: ({ command, args }) => command === "git" && args.includes("status")
          ? commandResult(" M private-file\0")
          : undefined,
      }),
    }),
    (error) => error.code === "SOURCE_NOT_CLEAN" && error.phase === "source",
  );
  assert.equal(dirtyCalls.some(({ args }) => args.some((value) => value.endsWith?.("/verify.mjs"))), false);
  assert.equal(dirtyWorkspace.events.length, 0);

  const occupiedCalls = [];
  const occupiedWorkspace = fakeWorkspace({ occupied: true });
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS, root: ROOT, runner: createSuccessfulRunner(occupiedCalls), workspace: occupiedWorkspace.lifecycle }),
    (error) => error.code === "OUTPUT_OCCUPIED" && error.phase === "source",
  );
  assert.equal(occupiedCalls.some(({ args }) => args.some((value) => value.endsWith?.("/verify.mjs"))), false);
  assert.equal(occupiedWorkspace.events.some(([name]) => name === "create"), false);
});

test("a changed HEAD at either identity recheck fails before later release work", async () => {
  const calls = [];
  const workspace = fakeWorkspace();
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS,
      root: ROOT,
      workspace: workspace.lifecycle,
      runner: createSuccessfulRunner(calls, { headSequence: [COMMIT, "2".repeat(40)] }),
    }),
    (error) => error.code === "SOURCE_MUTATED" && error.phase === "source",
  );
  assert.equal(calls.some(({ args }) => args.some((value) => value.endsWith?.("/stage.mjs"))), false);
  assert.equal(workspace.events.some(([name]) => name === "create"), false);
});

test("malformed command results and unevidenced outputs fail closed at their owning phase", async () => {
  const cases = [
    {
      name: "malformed runner result",
      code: "MALFORMED_RESULT",
      phase: "source",
      override: ({ command, args }) => command === "git" && args.includes("--show-toplevel")
        ? { status: 0, stdout: `${ROOT}\n`, stderr: "" }
        : undefined,
    },
    {
      name: "stage output mismatch",
      code: "OUTPUT_INVALID",
      phase: "packages",
      override: ({ args }) => args[0]?.endsWith("/stage.mjs") ? commandResult("staged\n") : undefined,
    },
    {
      name: "verify reports other units than the plan",
      code: "OUTPUT_INVALID",
      phase: "source",
      override: ({ args }) => args[0]?.endsWith("/verify.mjs")
        ? commandResult(developmentReport(VERSION, { units: ["php-core"] }))
        : undefined,
    },
    ...[
      ["18 artifacts", { artifacts: 18 }],
      ["20 artifacts", { artifacts: 20 }],
      ["another release set", { releaseSet: "local-222222222222" }],
      ["another output directory", { outputDirectory: `${ROOT}/.artifacts/release/${VERSION}` }],
      ["another source commit", { sourceCommit: "2".repeat(40) }],
      ["no application unit", { artifacts: 12, units: STAGED_UNITS.filter(({ id }) => id !== "gauntlet") }],
      ["an application at another version", { units: STAGED_UNITS.map((unit) => unit.id === "gauntlet" ? { ...unit, version: "0.1.1" } : unit) }],
      ["units out of dependency order", { units: [...STAGED_UNITS].reverse() }],
      ["no units", { artifacts: 0, units: [] }],
      ["a schema 1 version field", { version: VERSION }],
    ].map(([name, overrides]) => ({
      name: `stage output reports ${name}`,
      code: "OUTPUT_INVALID",
      phase: "packages",
      override: ({ args }) => args[0]?.endsWith("/stage.mjs") ? commandResult(stageOutput(overrides)) : undefined,
    })),
    {
      name: "security is not a full pass",
      code: "OUTPUT_INVALID",
      phase: "security",
      override: ({ args }) => args[0]?.endsWith("/security.mjs")
        ? commandResult(jsonLine({ ...JSON.parse(securityReport()), ok: false }))
        : undefined,
    },
    {
      name: "security omits managed reports",
      code: "OUTPUT_INVALID",
      phase: "security",
      override: ({ args }) => args[0]?.endsWith("/security.mjs")
        ? commandResult(jsonLine({ ...JSON.parse(securityReport()), reports: [] }))
        : undefined,
    },
    {
      name: "inventory report has the wrong fixed artifact count",
      code: "OUTPUT_INVALID",
      phase: "inventory",
      override: ({ args }) => args[0]?.endsWith("/verify-inventory.mjs")
        ? commandResult(inventoryReport({ artifacts: 18 }))
        : undefined,
    },
    {
      name: "inventory report belongs to another release set",
      code: "OUTPUT_INVALID",
      phase: "inventory",
      override: ({ args }) => args[0]?.endsWith("/verify-inventory.mjs")
        ? commandResult(inventoryReport({ releaseSet: "release-2026-10-03.1" }))
        : undefined,
    },
    {
      name: "inventory report has other units than the stage",
      code: "OUTPUT_INVALID",
      phase: "inventory",
      override: ({ args }) => args[0]?.endsWith("/verify-inventory.mjs")
        ? commandResult(inventoryReport({ units: REPORTED_UNITS.slice(1) }))
        : undefined,
    },
    {
      name: "inventory report is schema 1",
      code: "OUTPUT_INVALID",
      phase: "inventory",
      override: ({ args }) => args[0]?.endsWith("/verify-inventory.mjs")
        ? commandResult(inventoryReport({ schemaVersion: 1 }))
        : undefined,
    },
    {
      name: "inventory report has an unexpected field",
      code: "OUTPUT_INVALID",
      phase: "inventory",
      override: ({ args }) => args[0]?.endsWith("/verify-inventory.mjs")
        ? commandResult(inventoryReport({ diagnostic: "not-closed" }))
        : undefined,
    },
    {
      name: "documented command report is incomplete",
      code: "OUTPUT_INVALID",
      phase: "documentation",
      override: ({ command, args }) => command === "pnpm" && args[0] === "docs:verify-commands"
        ? commandResult(jsonLine({ ok: true }))
        : undefined,
    },
    {
      name: "registry binds outside loopback",
      code: "OUTPUT_INVALID",
      phase: "image",
      override: ({ command, args }) => command === "docker" && args[0] === "port"
        ? commandResult("0.0.0.0:49152\n")
        : undefined,
    },
    {
      name: "registry refuses a remote Docker daemon",
      code: "OUTPUT_INVALID",
      phase: "image",
      override: ({ command, args }) => command === "docker" && args[0] === "context"
        ? commandResult('"ssh://builder.example"\n')
        : undefined,
    },
    {
      name: "registry readiness output is malformed",
      code: "OUTPUT_INVALID",
      phase: "image",
      override: ({ command }) => command === "curl" ? commandResult("\n") : undefined,
    },
    {
      name: "image push has no canonical digest",
      code: "OUTPUT_INVALID",
      phase: "image",
      override: ({ command, args }) => command === "docker" && args[0] === "image" && args[1] === "push"
        ? commandResult("Pushed maybe\n")
        : undefined,
    },
    {
      name: "pulled chart metadata has the wrong version",
      code: "OUTPUT_INVALID",
      phase: "helm",
      override: ({ command, args }) => command === "helm" && args[0] === "show"
        ? commandResult("apiVersion: v2\nname: gauntlet\nversion: 9.9.9\nappVersion: 9.9.9\n")
        : undefined,
    },
    {
      name: "chart pull reports a digest other than the pushed digest",
      code: "OUTPUT_INVALID",
      phase: "helm",
      override: ({ command, args }) => command === "helm" && args[0] === "pull"
        ? commandResult("", { stderr: `Pulled: 127.0.0.1:49152/gauntlet-charts/gauntlet:${VERSION}\nDigest: sha256:${"8".repeat(64)}\n` })
        : undefined,
    },
    {
      name: "chart push reports status in both output channels",
      code: "OUTPUT_INVALID",
      phase: "helm",
      override: ({ command, args }) => command === "helm" && args[0] === "push"
        ? commandResult(`Pushed: 127.0.0.1:49152/gauntlet-charts/gauntlet:${VERSION}\nDigest: ${PUSH_DIGEST}\n`, { stderr: "duplicate status\n" })
        : undefined,
    },
    {
      name: "chart pull is silent",
      code: "OUTPUT_INVALID",
      phase: "helm",
      override: ({ command, args }) => command === "helm" && args[0] === "pull"
        ? commandResult()
        : undefined,
    },
  ];

  for (const scenario of cases) {
    const calls = [];
    const workspace = fakeWorkspace();
    await assert.rejects(
      runDryRun({ readPlan: ALL_UNITS,
        root: ROOT,
        workspace: workspace.lifecycle,
        archiveInspector,
        runner: createSuccessfulRunner(calls, { override: scenario.override }),
      }),
      (error) => {
        assert.equal(error.code, scenario.code, scenario.name);
        assert.equal(error.phase, scenario.phase, scenario.name);
        return true;
      },
    );
  }
});

test("phase failures short-circuit but registry failures still clean images, container, and temp root", async () => {
  const earlyCalls = [];
  const earlyWorkspace = fakeWorkspace();
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS,
      root: ROOT,
      workspace: earlyWorkspace.lifecycle,
      runner: createSuccessfulRunner(earlyCalls, {
        override: ({ args }) => args[0]?.endsWith("/security.mjs")
          ? commandResult("", { status: 23, stderr: "private scanner failure" })
          : undefined,
      }),
    }),
    (error) => {
      assert.equal(error.code, "PHASE_FAILED");
      assert.equal(error.phase, "security");
      assert.equal(error.exitCode, 23);
      assert.deepEqual(error.report.phases.find(({ name }) => name === "image"), {
        name: "image", status: "not-run", reason: "release-rehearsal-not-reached",
      });
      assert.deepEqual(error.report.phases.find(({ name }) => name === "helm"), {
        name: "helm", status: "not-run", reason: "release-rehearsal-not-reached",
      });
      return true;
    },
  );
  assert.equal(earlyCalls.some(({ args }) => args[0]?.endsWith?.("/verify-inventory.mjs")), false);
  assert.equal(earlyWorkspace.events.some(([name]) => name === "create"), false);

  const registryCalls = [];
  const registryWorkspace = fakeWorkspace();
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS,
      root: ROOT,
      workspace: registryWorkspace.lifecycle,
      archiveInspector,
      runner: createSuccessfulRunner(registryCalls, {
        override: ({ command, args }) => command === "helm" && args[0] === "pull"
          ? commandResult("", { status: 31, stderr: "private chart failure" })
          : undefined,
      }),
    }),
    (error) => {
      assert.equal(error.code, "PHASE_FAILED");
      assert.equal(error.phase, "helm");
      assert.equal(error.exitCode, 31);
      assert.deepEqual(error.report.phases.find(({ name }) => name === "image"), { name: "image", status: "passed" });
      assert.deepEqual(error.report.phases.find(({ name }) => name === "helm"), { name: "helm", status: "failed" });
      return true;
    },
  );
  const rendered = registryCalls.map(({ command, args }) => [command, ...args].join(" "));
  assert.equal(rendered.some((line) => line === `docker image rm gauntlet.local/gauntlet:${VERSION}`), true);
  assert.equal(rendered.some((line) => line === `docker rm --force gauntlet-release-registry-${TOKEN.slice(0, 24)}`), true);
  assert.equal(registryWorkspace.events.at(-1)[0], "remove");
});

test("load, tag and pull are registered before mutation and reconciled after malformed observations", async () => {
  const sourceTag = `gauntlet.local/gauntlet:${VERSION}`;
  const imageTag = `127.0.0.1:49152/gauntlet:${VERSION}`;
  const digestReference = `127.0.0.1:49152/gauntlet@${PUSH_DIGEST}`;
  const scenarios = [
    {
      name: "load",
      override: ({ command, args }, { images }) => {
        if (command === "docker" && args[0] === "load") {
          images.add(sourceTag);
          return { status: 0, stdout: "loaded", stderr: "" };
        }
        return undefined;
      },
    },
    {
      name: "tag inspection",
      override: (() => {
        let malformed = true;
        return ({ command, args }, { images }) => {
          if (command === "docker" && args[0] === "image" && args[1] === "tag") {
            images.add(args[3]);
            return commandResult();
          }
          if (malformed && command === "docker" && args[0] === "image" && args[1] === "inspect"
              && args[2] === imageTag && images.has(imageTag)) {
            malformed = false;
            return commandResult("not-an-image-id\n");
          }
          return undefined;
        };
      })(),
    },
    {
      name: "pull",
      override: ({ command, args }, { images }) => {
        if (command === "docker" && args[0] === "image" && args[1] === "pull") {
          images.add(digestReference);
          return { status: 0, stdout: "pulled", stderr: "" };
        }
        return undefined;
      },
    },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const workspace = fakeWorkspace();
    await assert.rejects(
      runDryRun({ readPlan: ALL_UNITS,
        root: ROOT,
        runner: createSuccessfulRunner(calls, { override: scenario.override }),
        workspace: workspace.lifecycle,
        archiveInspector,
      }),
      (error) => ["MALFORMED_RESULT", "OUTPUT_INVALID"].includes(error.code),
      scenario.name,
    );
    const removed = calls
      .filter(({ command, args }) => command === "docker" && args[0] === "image" && args[1] === "rm")
      .map(({ args }) => args[2]);
    const expected = scenario.name === "load" ? sourceTag : scenario.name === "tag inspection" ? imageTag : digestReference;
    assert.equal(removed.includes(expected), true, scenario.name);
  }
});

test("image reconciliation refuses a changed image ID and requires confirmed absence", async () => {
  const sourceTag = `gauntlet.local/gauntlet:${VERSION}`;
  const mismatchedCalls = [];
  const mismatchedWorkspace = fakeWorkspace();
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS,
      root: ROOT,
      workspace: mismatchedWorkspace.lifecycle,
      archiveInspector,
      runner: createSuccessfulRunner(mismatchedCalls, {
        override: ({ command, args }, { images }) => command === "docker" && args[0] === "image"
          && args[1] === "inspect" && args[2] === sourceTag && images.has(sourceTag)
          ? commandResult(`sha256:${"8".repeat(64)}\n`)
          : undefined,
      }),
    }),
    (error) => {
      assert.equal(error.code, "CLEANUP_FAILED");
      assert.deepEqual(error.report.phases.find(({ name }) => name === "image"), { name: "image", status: "failed" });
      assert.deepEqual(error.report.phases.find(({ name }) => name === "helm"), {
        name: "helm", status: "not-run", reason: "short-circuited",
      });
      return true;
    },
  );
  assert.equal(mismatchedCalls.some(({ command, args }) => command === "docker"
    && args[0] === "image" && args[1] === "rm" && args[2] === sourceTag), false);

  const retainedCalls = [];
  const retainedWorkspace = fakeWorkspace();
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS,
      root: ROOT,
      workspace: retainedWorkspace.lifecycle,
      archiveInspector,
      runner: createSuccessfulRunner(retainedCalls, {
        override: ({ command, args }) => command === "docker" && args[0] === "image" && args[1] === "rm"
          ? commandResult(`Untagged: ${args[2]}\n`)
          : undefined,
      }),
    }),
    (error) => error.code === "CLEANUP_FAILED",
  );
});

test("image reconciliation trusts confirmed absence even if remove output is malformed", async () => {
  const calls = [];
  const workspace = fakeWorkspace();
  const report = await runDryRun({ readPlan: ALL_UNITS,
    root: ROOT,
    workspace: workspace.lifecycle,
    archiveInspector,
    runner: createSuccessfulRunner(calls, {
      override: ({ command, args }, { images }) => {
        if (command === "docker" && args[0] === "image" && args[1] === "rm") {
          images.delete(args[2]);
          return { status: 0, stdout: "removed" };
        }
        return undefined;
      },
    }),
  });
  assert.equal(report.releaseReady, true);
});

test("any container or temporary-directory cleanup failure overrides success and fails closed", async () => {
  const containerCalls = [];
  const containerWorkspace = fakeWorkspace();
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS,
      root: ROOT,
      workspace: containerWorkspace.lifecycle,
      archiveInspector,
      runner: createSuccessfulRunner(containerCalls, {
        override: ({ command, args }) => command === "docker" && args[0] === "rm"
          ? commandResult("", { status: 1, stderr: "cannot remove" })
          : undefined,
      }),
    }),
    (error) => error.code === "CLEANUP_FAILED",
  );
  assert.equal(containerWorkspace.events.at(-1)[0], "remove");

  const directoryCalls = [];
  const directoryWorkspace = fakeWorkspace({ removeFails: true });
  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS,
      root: ROOT,
      workspace: directoryWorkspace.lifecycle,
      archiveInspector,
      runner: createSuccessfulRunner(directoryCalls),
    }),
    (error) => error.code === "CLEANUP_FAILED",
  );
});

test("malformed workspace ownership is rejected and handed back to its creating lifecycle", async () => {
  const calls = [];
  const workspace = fakeWorkspace();
  const returned = { ...workspace.owned, token: "not-an-owner-token" };
  workspace.lifecycle.create = async () => {
    workspace.events.push(["create", returned.root]);
    return returned;
  };

  await assert.rejects(
    runDryRun({ readPlan: ALL_UNITS, root: ROOT, runner: createSuccessfulRunner(calls), workspace: workspace.lifecycle, archiveInspector }),
    (error) => error.code === "MALFORMED_RESULT" && error.phase === "image",
  );
  assert.deepEqual(workspace.events.at(-1), ["remove", returned.root]);
  assert.equal(calls.some(({ command }) => command === "docker"), false);
});

test("dry-run dependency accessors are rejected without evaluation", async () => {
  let accessed = false;
  const options = {
    root: ROOT,
    workspace: fakeWorkspace().lifecycle,
    get runner() {
      accessed = true;
      return async () => commandResult();
    },
  };
  await assert.rejects(
    runDryRun(options),
    (error) => error.code === "INVALID_OPTIONS" && error.phase === null,
  );
  assert.equal(accessed, false);
});

test("the dry-run CLI is strict and never returns child diagnostics", async () => {
  let called = false;
  const invalid = await runDryRunCli(["--keep"], {
    root: ROOT,
    readPlan: ALL_UNITS,
    runner: async () => {
      called = true;
      return commandResult();
    },
    workspace: fakeWorkspace().lifecycle,
  });
  assert.equal(called, false);
  assert.deepEqual(invalid, {
    exitCode: 2,
    stdout: "",
    stderr: '{"error":{"code":"INVALID_ARGUMENTS","message":"Usage: dry-run.mjs [--plan PATH] [--release-set release-YYYY-MM-DD.N|local-<12 hex>]"},"ok":false,"releaseReady":false}\n',
  });

  const failed = await runDryRunCli([], {
    root: ROOT,
    readPlan: ALL_UNITS,
    runner: async () => { throw new Error("secret diagnostic 1730"); },
    workspace: fakeWorkspace().lifecycle,
  });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stdout, "");
  assert.equal(JSON.stringify(failed).includes("secret diagnostic 1730"), false);
  assert.deepEqual(JSON.parse(failed.stderr).error, {
    code: "EXECUTION_FAILED",
    message: "Release dry-run failed safely",
    phase: "source",
  });

  assert.deepEqual(
    parseDryRunArguments(["--plan", ".release/plan.json", "--release-set", "release-2026-10-03.1"]),
    { planPath: ".release/plan.json", releaseSet: "release-2026-10-03.1" },
  );
  assert.deepEqual(
    parseDryRunArguments(["--release-set", SET, "--plan", ".release/plan.json"]),
    { planPath: ".release/plan.json", releaseSet: SET },
  );
  assert.deepEqual(parseDryRunArguments(["--plan", ".release/plan.json"]), { planPath: ".release/plan.json", releaseSet: null });
  for (const argv of [
    ["--plan", "a.json", "--plan", "b.json"],
    ["--release-set", SET, "--release-set", SET],
    ["--release-set", "0.1.0"],
    ["--release-set", "release-2026-13-01.1"],
    ["--plan", "a.json", "extra"],
    ["--plan"],
    ["--plan", "../outside.json"],
  ]) {
    let invoked = false;
    const rejected = await runDryRunCli(argv, {
      root: ROOT,
      runner: async () => { invoked = true; return commandResult(); },
      workspace: fakeWorkspace().lifecycle,
    });
    assert.equal(rejected.exitCode, 2, argv.join(" "));
    assert.equal(JSON.parse(rejected.stderr).error.code, "INVALID_ARGUMENTS", argv.join(" "));
    assert.equal(invoked, false);
  }

  const forwarded = [];
  const cli = await runDryRunCli(["--plan", ".release/plan.json"], {
    root: ROOT,
    runner: createSuccessfulRunner([]),
    workspace: fakeWorkspace().lifecycle,
    archiveInspector,
    readPlan: (root, planPath) => {
      forwarded.push([root, planPath]);
      return { plan: ALL_UNITS_PLAN, path: planPath };
    },
  });
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.deepEqual(forwarded, [[ROOT, ".release/plan.json"]]);
});

test("a php-core plan runs only its release work and skips the application rehearsal", async () => {
  const calls = [];
  const workspace = fakeWorkspace();
  const runner = createSuccessfulRunner(calls, { override: (invocation) => {
    const [script] = invocation.args;
    if (invocation.command === process.execPath && script?.endsWith("/verify.mjs")) return commandResult(developmentReport(VERSION, { units: ["php-core"] }));
    if (invocation.command === process.execPath && script?.endsWith("/stage.mjs")) {
      return commandResult(jsonLine({
        artifacts: 1, outputDirectory: `${ROOT}/.artifacts/release/local-111111111111`, releaseSet: "local-111111111111",
        sourceCommit: COMMIT, units: [{ id: "php-core", version: "0.1.1" }],
      }));
    }
    if (invocation.command === process.execPath && script?.endsWith("/verify-inventory.mjs")) {
      return commandResult(inventoryReport({ units: [{ id: "php-core", version: "0.1.1", tag: "php-core-v0.1.1" }], artifacts: 1, nativeImage: null, multiPlatformOci: null, helmChart: null }));
    }
    return undefined;
  } });
  const report = await runDryRun({
    root: ROOT, runner, workspace: workspace.lifecycle, archiveInspector, planPath: ".release/plan.json",
    readPlan: () => ({ plan: PHP_PLAN, path: ".release/plan.json" }),
  });
  assert.equal(report.releaseReady, true);
  assert.deepEqual(report.units, [{ id: "php-core", from: "0.1.0", to: "0.1.1" }]);
  assert.equal(report.releaseSet, SET);
  assert.equal(report.version, VERSION);
  const commands = calls.map(({ command, args }) => `${command} ${args.join(" ")}`);
  assert.ok(commands.some((line) => line === "pnpm test:composer:consumer"));
  for (const absent of ["test:java:release", "security.mjs", "docs:verify-commands", "docker", "helm"]) {
    assert.ok(!commands.some((line) => line.includes(absent)), absent);
  }
  assert.ok(calls.find(({ args }) => args[0]?.endsWith("/stage.mjs")).args.includes("--plan"));
  assert.deepEqual(calls.find(({ args }) => args[0]?.endsWith("/stage.mjs")).args, [
    `${ROOT}/scripts/release/stage.mjs`, "--output", RELEASE_ROOT, "--plan", ".release/plan.json", "--release-set", SET,
  ]);
  assert.ok(calls.find(({ args }) => args[0]?.endsWith("/verify.mjs")).args.join(" ").endsWith("--plan .release/plan.json"));
  for (const name of ["java", "image", "helm", "security", "dashboard"]) {
    assert.equal(report.phases.find((phase) => phase.name === name).status, "skipped", name);
  }
  assert.deepEqual(report.phases.find((phase) => phase.name === "dashboard"), { name: "dashboard", status: "skipped", reason: "not-in-release-plan" });
  for (const name of ["source", "php", "conformance", "packages", "inventory", "documentation"]) {
    assert.equal(report.phases.find((phase) => phase.name === name).status, "passed", name);
  }
  assert.equal(report.evidence.localRegistryRehearsal, null);
  assert.equal(workspace.events.some(([name]) => name === "create"), false);
});

test("a planned release set names the release root and must match the source commit when local", async () => {
  const calls = [];
  const named = "release-2026-10-03.1";
  const namedRoot = `${ROOT}/.artifacts/release/${named}`;
  const report = await runDryRun({
    root: ROOT, workspace: fakeWorkspace().lifecycle, archiveInspector, releaseSet: named, readPlan: ALL_UNITS,
    runner: createSuccessfulRunner(calls, { override: ({ command, args }) => {
      if (command === process.execPath && args[0]?.endsWith("/stage.mjs")) {
        return commandResult(stageOutput({ outputDirectory: namedRoot, releaseSet: named }));
      }
      if (command === process.execPath && args[0]?.endsWith("/verify-inventory.mjs")) return commandResult(inventoryReport({ releaseSet: named }));
      if (command === "pnpm" && args[0] === "docs:verify-commands") {
        return commandResult(jsonLine({ exitCode: 0, ok: true }), {
          stderr: `$ node scripts/docs/verify-documented-commands.mjs --release-root .artifacts/release/${named}\n`,
        });
      }
      return undefined;
    } }),
  });
  assert.equal(report.releaseSet, named);
  assert.deepEqual(calls.find(({ args }) => args[0]?.endsWith("/stage.mjs")).args.slice(-2), ["--release-set", named]);

  await assert.rejects(
    runDryRun({
      root: ROOT, workspace: fakeWorkspace().lifecycle, archiveInspector, releaseSet: "local-222222222222", readPlan: ALL_UNITS,
      runner: createSuccessfulRunner([]),
    }),
    (error) => error.code === "RELEASE_SET_MISMATCH" && error.phase === "source",
  );
});

test("an empty or unreadable release plan fails at source before verification", async () => {
  for (const readPlan of [
    () => ({ plan: createReleasePlan([]), path: ".release/plan.json" }),
    () => { throw new Error("private plan detail"); },
  ]) {
    const calls = [];
    await assert.rejects(
      runDryRun({ root: ROOT, workspace: fakeWorkspace().lifecycle, archiveInspector, readPlan, runner: createSuccessfulRunner(calls) }),
      (error) => error.code === "OUTPUT_INVALID" && error.phase === "source" && !JSON.stringify(error.report).includes("private"),
    );
    assert.equal(calls.some(({ args }) => args[0]?.endsWith?.("/verify.mjs")), false);
  }
});

test("every dry-run phase runs with its raised timeout", async () => {
  const calls = [];
  await runDryRun({ root: ROOT, runner: createSuccessfulRunner(calls), workspace: fakeWorkspace().lifecycle, archiveInspector, readPlan: ALL_UNITS });
  const timeouts = new Map(calls.map(({ phase, timeoutMs }) => [phase, timeoutMs]));
  assert.equal(timeouts.get("source"), 180 * 60_000);
  assert.equal(timeouts.get("packages"), 60 * 60_000);
  assert.equal(timeouts.get("documentation"), 60 * 60_000);
  assert.equal(timeouts.get("helm"), 60 * 60_000);
  assert.equal(timeouts.get("security"), 90 * 60_000);
  assert.deepEqual({ ...DRY_RUN_PHASE_TIMEOUT_MS }, {
    source: 180 * 60_000, php: 90 * 60_000, java: 90 * 60_000, packages: 60 * 60_000, security: 90 * 60_000,
    inventory: 30 * 60_000, documentation: 60 * 60_000, image: 60 * 60_000, helm: 60 * 60_000,
  });
});
