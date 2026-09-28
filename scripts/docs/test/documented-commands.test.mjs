import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseDocumentedCommandArguments,
  planDocumentedCommandChecks,
  runDocumentedCommandChecks,
} from "../verify-documented-commands.mjs";
import { RELEASE_STAGE_ARTIFACT_COUNT } from "../../release/release-model.mjs";

const VERSION = "0.1.0";
const LOCAL_IMAGE = `gauntlet.local/gauntlet:${VERSION}`;
const EXPECTED_IMAGE_ID = `sha256:${"7".repeat(64)}`;
const MANIFEST_IMAGE_ID = `sha256:${"9".repeat(64)}`;
const DIFFERENT_IMAGE_ID = `sha256:${"8".repeat(64)}`;

function commandResult(stdout = "", overrides = {}) {
  return { status: 0, signal: null, stdout, stderr: "", ...overrides };
}

function renderedChart(version = VERSION) {
  const releaseImage = `ghcr.io/8lines/gauntlet:${version}`;
  return [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: gauntlet",
    "spec:",
    "  replicas: 1",
    "  template:",
    "    spec:",
    "      containers:",
    "        - name: gauntlet",
    `          image: ${releaseImage}`,
    "---",
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    "  name: gauntlet",
    "spec:",
    "  type: ClusterIP",
    "",
  ].join("\n");
}

function archiveInspection(versionOrOptions = VERSION) {
  const version = typeof versionOrOptions === "string" ? versionOrOptions : VERSION;
  return {
    platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
    runtimeImageIds: Object.freeze([EXPECTED_IMAGE_ID, MANIFEST_IMAGE_ID]),
    tag: `gauntlet.local/gauntlet:${version}`,
  };
}

function inventoryReport(version = VERSION) {
  return `${JSON.stringify({
    schemaVersion: 1,
    ok: true,
    version,
    sourceCommit: "1".repeat(40),
    artifacts: RELEASE_STAGE_ARTIFACT_COUNT,
    manifestSha256: "2".repeat(64),
    checksumsSha256: "3".repeat(64),
    nativeImage: {
      path: `image/gauntlet-${version}.docker.tar`,
      sha256: "4".repeat(64),
    },
    multiPlatformOci: {
      path: `image/gauntlet-${version}.oci.tar`,
      sha256: "5".repeat(64),
      platforms: ["linux/amd64", "linux/arm64"],
      verification: "deeply-validated-during-staging",
    },
    helmChart: {
      path: `helm/gauntlet-${version}.tgz`,
      sha256: "6".repeat(64),
    },
  })}\n`;
}

function localFlow({
  cleanup,
  clearOnRemove = true,
  load,
  loadedImageId = EXPECTED_IMAGE_ID,
  missingImageStdout = "",
} = {}) {
  const calls = [];
  let imageId;
  return {
    calls,
    runner: async (invocation) => {
      calls.push(invocation);
      const { phase } = invocation;
      if (phase === "inventory") return commandResult(inventoryReport());
      if (phase === "docker-context") return commandResult('"unix:///var/run/docker.sock"\n');
      if (phase === "docker-info") return commandResult('"26.0.0"\n');
      if (phase === "image-absence") {
        return commandResult(missingImageStdout, { status: 1, stderr: `No such image: ${LOCAL_IMAGE}\n` });
      }
      if (phase === "image-load") {
        imageId = loadedImageId;
        return load === undefined
          ? commandResult(`Loaded image: ${LOCAL_IMAGE}\n`)
          : load();
      }
      if (phase === "image-reconcile" || phase === "image-cleanup-absence") {
        return imageId === undefined
          ? commandResult(missingImageStdout, { status: 1, stderr: `No such image: ${LOCAL_IMAGE}\n` })
          : commandResult(`${imageId}\n`);
      }
      if (phase === "image-cleanup") {
        if (clearOnRemove) imageId = undefined;
        return cleanup === undefined ? commandResult(`Untagged: ${LOCAL_IMAGE}\n`) : cleanup();
      }
      if (phase === "image-label") return commandResult(`${VERSION}\n`);
      if (phase === "helm-metadata") {
        return commandResult(`apiVersion: v2\nname: gauntlet\nversion: ${VERSION}\nappVersion: ${VERSION}\n`);
      }
      if (phase === "helm-render") return commandResult(renderedChart());
      throw new Error(`Unexpected phase ${phase}`);
    },
  };
}

function fixture(t, version = VERSION) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-doc-command-test-")));
  const releaseRoot = resolve(root, ".artifacts/release", version);
  const temporaryRoot = resolve(root, ".tmp");
  for (const path of [
    resolve(root, "deploy/compose"),
    resolve(root, "deploy/helm/ci"),
    resolve(releaseRoot, "image"),
    resolve(releaseRoot, "helm"),
    temporaryRoot,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  for (const [path, bytes] of [
    [resolve(root, "VERSION"), `${version}\n`],
    [resolve(root, "deploy/compose/compose.yaml"), "services: {}\n"],
    [resolve(root, "deploy/helm/ci/staging-values.yaml"), "config: {}\n"],
    [resolve(releaseRoot, `image/gauntlet-${version}.docker.tar`), "image\n"],
    [resolve(releaseRoot, `helm/gauntlet-${version}.tgz`), "chart\n"],
    [resolve(releaseRoot, "release-manifest.json"), "{}\n"],
    [resolve(releaseRoot, "SHA256SUMS"), "checksums\n"],
  ]) {
    writeFileSync(path, bytes, { mode: 0o600 });
  }
  chmodSync(root, 0o700);
  t.after(() => import("node:fs").then(({ rmSync }) => rmSync(root, { recursive: true, force: true })));
  return { releaseRoot, root, temporaryRoot };
}

test("plans only local checks against exact staged 0.1.0 artifacts", (t) => {
  const paths = fixture(t);
  const plan = planDocumentedCommandChecks(paths);

  assert.equal(plan.imageArchive, resolve(paths.releaseRoot, "image/gauntlet-0.1.0.docker.tar"));
  assert.equal(plan.localImage, "gauntlet.local/gauntlet:0.1.0");
  assert.equal(plan.chartArchive, resolve(paths.releaseRoot, "helm/gauntlet-0.1.0.tgz"));
  assert.equal(plan.chartValues, resolve(paths.root, "deploy/helm/ci/staging-values.yaml"));
  assert.deepEqual(plan.composeFiles, [
    resolve(paths.root, "deploy/compose/compose.yaml"),
    resolve(paths.temporaryRoot, "compose.local-image.yaml"),
  ]);

  const executable = plan.commands
    .map(({ command, args }) => [command, ...args].join(" "))
    .join("\n");
  assert.doesNotMatch(executable, /docker (?:login|pull|push)|helm (?:pull|push|install)|npm publish|git push|gh api|kubectl apply/u);
  assert.match(executable, /docker load --input .*gauntlet-0\.1\.0\.docker\.tar/u);
  assert.match(executable, /helm show chart .*gauntlet-0\.1\.0\.tgz/u);
  assert.match(executable, /helm template gauntlet-docs .*gauntlet-0\.1\.0\.tgz/u);
  assert.match(executable, /--values .*deploy\/helm\/ci\/staging-values\.yaml/u);
  assert.match(executable, /--kube-version 1\.35\.0/u);
  assert.doesNotMatch(executable, /--set-string|--skip-schema-validation/u);
  assert.deepEqual(plan.commands[0], {
    phase: "inventory",
    command: process.execPath,
    args: [
      resolve(paths.root, "scripts/release/verify-inventory.mjs"),
      "--release-root",
      paths.releaseRoot,
    ],
    workingDirectory: paths.root,
    expectedStatus: 0,
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.commands), true);
});

test("derives every documented-command check from a bumped 0.1.1 VERSION", async (t) => {
  const version = "0.1.1";
  const paths = fixture(t, version);
  const localImage = `gauntlet.local/gauntlet:${version}`;
  let imageId;
  const result = await runDocumentedCommandChecks({
    ...paths,
    archiveInspector: () => archiveInspection(version),
    runner: async ({ phase }) => {
      if (phase === "inventory") return commandResult(inventoryReport(version));
      if (phase === "docker-context") return commandResult('"unix:///var/run/docker.sock"\n');
      if (phase === "docker-info") return commandResult('"26.0.0"\n');
      if (phase === "image-absence" || phase === "image-cleanup-absence") {
        return imageId === undefined
          ? commandResult("", { status: 1, stderr: `No such image: ${localImage}\n` })
          : commandResult(`${imageId}\n`);
      }
      if (phase === "image-load") {
        imageId = EXPECTED_IMAGE_ID;
        return commandResult(`Loaded image: ${localImage}\n`);
      }
      if (phase === "image-label") return commandResult(`${version}\n`);
      if (phase === "helm-metadata") {
        return commandResult(`apiVersion: v2\nname: gauntlet\nversion: ${version}\nappVersion: ${version}\n`);
      }
      if (phase === "helm-render") return commandResult(renderedChart(version));
      if (phase === "image-reconcile") return commandResult(`${imageId}\n`);
      if (phase === "image-cleanup") {
        imageId = undefined;
        return commandResult(`Untagged: ${localImage}\n`);
      }
      throw new Error(`Unexpected phase ${phase}`);
    },
  });

  assert.deepEqual(result, { exitCode: 0, ok: true });
  const plan = planDocumentedCommandChecks(paths);
  assert.equal(plan.version, version);
  assert.equal(plan.imageArchive, resolve(paths.releaseRoot, `image/gauntlet-${version}.docker.tar`));
  assert.deepEqual(
    parseDocumentedCommandArguments(["--release-root", `.artifacts/release/${version}`], paths.root),
    { releaseRoot: paths.releaseRoot },
  );
});

test("rejects a zero-exit inventory verifier result without its complete success report", async (t) => {
  const paths = fixture(t);
  const calls = [];
  const result = await runDocumentedCommandChecks({
    ...paths,
    runner: async ({ phase }) => {
      calls.push(phase);
      return {
        status: 0,
        signal: null,
        stdout: '{"ok":true}\n',
        stderr: "",
      };
    },
  });

  assert.deepEqual(result, {
    code: "OUTPUT_INVALID",
    exitCode: 1,
    ok: false,
    phase: "inventory",
  });
  assert.deepEqual(calls, ["inventory"]);
});

test("rejects a wrong release version, unsafe paths, and missing artifacts", (t) => {
  const paths = fixture(t);
  assert.throws(
    () => planDocumentedCommandChecks({
      ...paths,
      releaseRoot: resolve(paths.root, ".artifacts/release/0.2.0"),
    }),
    /Documented command verification failed closed/u,
  );
  assert.throws(
    () => planDocumentedCommandChecks({ ...paths, temporaryRoot: paths.root }),
    /Documented command verification failed closed/u,
  );

  const image = resolve(paths.releaseRoot, "image/gauntlet-0.1.0.docker.tar");
  writeFileSync(image, "", { mode: 0o600 });
  assert.throws(
    () => planDocumentedCommandChecks(paths),
    /Documented command verification failed closed/u,
  );
});

test("treats an occupied local image tag as a failure before loading", async (t) => {
  const paths = fixture(t);
  const calls = [];
  const result = await runDocumentedCommandChecks({
    ...paths,
    runner: async ({ phase }) => {
      calls.push(phase);
      const stdout = phase === "inventory"
        ? inventoryReport()
        : phase === "docker-context"
          ? '"unix:///var/run/docker.sock"\n'
          : phase === "docker-info" ? '"26.0.0"\n' : "";
      return { status: 0, signal: null, stdout, stderr: "" };
    },
  });
  assert.deepEqual(result, {
    code: "PHASE_FAILED",
    exitCode: 0,
    ok: false,
    phase: "image-absence",
  });
  assert.deepEqual(calls, ["inventory", "docker-context", "docker-info", "image-absence"]);
});

test("runs fail-fast with argument arrays and preserves the failed phase", async (t) => {
  const paths = fixture(t);
  const calls = [];
  const result = await runDocumentedCommandChecks({
    ...paths,
    archiveInspector: archiveInspection,
    runner: async ({ phase, command, args, workingDirectory }) => {
      calls.push({ phase, command, args, workingDirectory });
      const status = ["image-absence", "image-cleanup-absence"].includes(phase)
        ? 1
        : phase === "helm-render" ? 17 : 0;
      const stdout = phase === "inventory"
        ? inventoryReport()
        : phase === "docker-context"
          ? '"unix:///var/run/docker.sock"\n'
          : phase === "docker-info"
            ? '"26.0.0"\n'
            : phase === "image-load"
              ? `Loaded image: ${LOCAL_IMAGE}\n`
              : phase === "image-label"
                ? `${VERSION}\n`
                : phase === "helm-metadata"
                  ? `apiVersion: v2\nname: gauntlet\nversion: ${VERSION}\nappVersion: ${VERSION}\n`
                  : phase === "image-reconcile"
                    ? `${EXPECTED_IMAGE_ID}\n`
                    : "";
      const stderr = ["image-absence", "image-cleanup-absence"].includes(phase)
        ? `Error: No such image: ${LOCAL_IMAGE}\n`
        : "";
      return { status, signal: null, stdout, stderr };
    },
  });

  assert.deepEqual(calls.map(({ phase }) => phase), [
    "inventory",
    "docker-context",
    "docker-info",
    "image-absence",
    "image-load",
    "image-label",
    "helm-metadata",
    "helm-render",
    "image-reconcile",
    "image-cleanup",
    "image-cleanup-absence",
  ]);
  assert.deepEqual(result, {
    code: "PHASE_FAILED",
    exitCode: 17,
    ok: false,
    phase: "helm-render",
  });
  for (const call of calls) {
    assert.equal(Array.isArray(call.args), true);
    assert.equal(
      call.workingDirectory,
      paths.root,
    );
  }
});

test("rejects malformed runner results instead of treating them as success", async (t) => {
  const paths = fixture(t);
  const result = await runDocumentedCommandChecks({
    ...paths,
    runner: async () => ({ status: 0 }),
  });
  assert.deepEqual(result, {
    code: "EXECUTION_FAILED",
    exitCode: 1,
    ok: false,
    phase: "inventory",
  });
});

for (const scenario of [
  {
    name: "throws",
    load: () => { throw new Error("load crashed after mutation"); },
    expected: { code: "EXECUTION_FAILED", exitCode: 1, ok: false, phase: "image-load" },
  },
  {
    name: "returns a malformed result",
    load: () => ({ status: 0 }),
    expected: { code: "EXECUTION_FAILED", exitCode: 1, ok: false, phase: "image-load" },
  },
  {
    name: "returns a nonzero status",
    load: () => commandResult("", { status: 17, stderr: "load failed\n" }),
    expected: { code: "PHASE_FAILED", exitCode: 17, ok: false, phase: "image-load" },
  },
  {
    name: "returns invalid success output",
    load: () => commandResult("unexpected output\n"),
    expected: { code: "OUTPUT_INVALID", exitCode: 1, ok: false, phase: "image-load" },
  },
]) {
  test(`reconciles and removes the archive-owned tag when docker load ${scenario.name}`, async (t) => {
    const paths = fixture(t);
    const flow = localFlow({ load: scenario.load });
    const result = await runDocumentedCommandChecks({
      ...paths,
      archiveInspector: archiveInspection,
      runner: flow.runner,
    });

    assert.deepEqual(result, scenario.expected);
    assert.deepEqual(flow.calls.slice(-3).map(({ phase }) => phase), [
      "image-reconcile",
      "image-cleanup",
      "image-cleanup-absence",
    ]);
    assert.deepEqual(flow.calls.at(-2).args, ["image", "rm", LOCAL_IMAGE]);
  });
}

test("does not remove a loaded tag whose reconciled image ID differs from the archive", async (t) => {
  const paths = fixture(t);
  const flow = localFlow({ loadedImageId: DIFFERENT_IMAGE_ID });
  const result = await runDocumentedCommandChecks({
    ...paths,
    archiveInspector: archiveInspection,
    runner: flow.runner,
  });

  assert.deepEqual(result, {
    code: "CLEANUP_FAILED",
    exitCode: 1,
    ok: false,
    phase: "image-cleanup",
  });
  assert.equal(flow.calls.some(({ phase }) => phase === "image-cleanup"), false);
});

test("removes the archive-owned tag with OrbStack's manifest ID and newline-only missing-image output", async (t) => {
  const paths = fixture(t);
  const flow = localFlow({ loadedImageId: MANIFEST_IMAGE_ID, missingImageStdout: "\n" });
  const result = await runDocumentedCommandChecks({
    ...paths,
    archiveInspector: archiveInspection,
    runner: flow.runner,
  });

  assert.deepEqual(result, { exitCode: 0, ok: true });
  assert.deepEqual(flow.calls.slice(-3).map(({ phase }) => phase), [
    "image-reconcile",
    "image-cleanup",
    "image-cleanup-absence",
  ]);
  assert.deepEqual(flow.calls.at(-2).args, ["image", "rm", LOCAL_IMAGE]);
});

test("fails cleanup when the exact loaded tag remains after removal", async (t) => {
  const paths = fixture(t);
  const flow = localFlow({ clearOnRemove: false });
  const result = await runDocumentedCommandChecks({
    ...paths,
    archiveInspector: archiveInspection,
    runner: flow.runner,
  });

  assert.deepEqual(result, {
    code: "CLEANUP_FAILED",
    exitCode: 1,
    ok: false,
    phase: "image-cleanup",
  });
  assert.equal(flow.calls.at(-1).phase, "image-cleanup-absence");
});

test("accepts confirmed tag absence when docker rm returns a malformed result after mutating", async (t) => {
  const paths = fixture(t);
  const flow = localFlow({ cleanup: () => ({ status: 0 }) });
  const result = await runDocumentedCommandChecks({
    ...paths,
    archiveInspector: archiveInspection,
    runner: flow.runner,
  });

  assert.deepEqual(result, { exitCode: 0, ok: true });
  assert.equal(flow.calls.at(-1).phase, "image-cleanup-absence");
});

test("accepts exact image labels and a one-replica private chart, then cleans the loaded image", async (t) => {
  const paths = fixture(t);
  const flow = localFlow();
  const events = [];
  const result = await runDocumentedCommandChecks({
    ...paths,
    archiveInspector: () => {
      events.push("archive-inspection");
      return archiveInspection();
    },
    runner: async (invocation) => {
      if (invocation.phase === "image-load") events.push("image-load");
      return flow.runner(invocation);
    },
  });
  assert.deepEqual(result, { exitCode: 0, ok: true });
  assert.deepEqual(events, ["archive-inspection", "image-load"]);
  assert.deepEqual(flow.calls.slice(-3).map(({ phase }) => phase), [
    "image-reconcile",
    "image-cleanup",
    "image-cleanup-absence",
  ]);
  assert.deepEqual(
    flow.calls.at(-3).args,
    ["image", "inspect", LOCAL_IMAGE, "--format", "{{.Id}}"],
  );
});
