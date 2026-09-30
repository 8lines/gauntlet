import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parsePublishedPort } from "./run-compose-smoke.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const imageTag = `gauntlet-product-verification:${randomUUID()}`;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const CONTAINER_READY_TIMEOUT_MS = 15_000;

function commandFailure(command, args, result) {
  if (result.error !== undefined) return result.error;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return new Error(
    `${command} ${args.join(" ")} failed with ${result.signal ?? `status ${String(result.status)}`}${output.length === 0 ? "" : `\n${output}`}`,
  );
}

function runInherited(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw commandFailure(command, args, result);
}

function runCaptured(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: MAX_CAPTURE_BYTES,
    stdio: "pipe",
  });
  if (result.status !== 0) throw commandFailure(command, args, result);
  return result.stdout;
}

/** Starts the product image as a real server, config mounted read-only, one dynamic loopback port. */
function startProductContainer(configHostPath) {
  const containerName = `gauntlet-verify-run-${randomUUID()}`;
  runInherited("docker", [
    "run", "-d", "--name", containerName,
    "--init",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "-p", "127.0.0.1::8080",
    "-v", `${configHostPath}:/etc/gauntlet/config.yaml:ro`,
    imageTag,
  ]);
  return containerName;
}

function stopProductContainer(containerName) {
  spawnSync("docker", ["rm", "--force", containerName], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "ignore",
  });
}

function productContainerOrigin(containerName) {
  return parsePublishedPort(runCaptured("docker", ["port", containerName, "8080/tcp"]));
}

async function waitUntilReady(origin) {
  const deadline = Date.now() + CONTAINER_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // The server may still be starting; retry until the deadline.
    }
    if (Date.now() >= deadline) throw new Error(`${origin}/ready did not become ready in time`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

const runtimeAssertions = String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createSecureContext } from "node:tls";

assert.notEqual(process.getuid(), 0, "runtime UID must be non-root");
assert.notEqual(process.getgid(), 0, "runtime GID must be non-root");
assert.equal(process.env.NODE_ENV, "production");
assert.equal(process.env.GAUNTLET_CONFIG_FILE, "/etc/gauntlet/config.yaml");
assert.equal(process.env.GAUNTLET_DASHBOARD_DIR, "/app/dashboard");
assert.equal(process.env.GAUNTLET_WIDGET_DIR, "/app/widget");
assert.equal(createHash("sha256").update("gauntlet-runtime").digest("hex").length, 64);
createSecureContext();

const requiredPaths = [
  "/app/package.json",
  "/app/dist/main.js",
  "/app/node_modules",
  "/app/node_modules/fastify",
  "/app/dashboard/index.html",
  "/app/widget/index.html",
  "/app/widget/loader.js",
];
for (const pathname of requiredPaths) statSync(pathname);
assert.ok(statSync("/app/widget/index.html").isFile(), "/app/widget/index.html must be a regular file");
assert.ok(statSync("/app/widget/loader.js").isFile(), "/app/widget/loader.js must be a regular file");

const index = readFileSync("/app/dashboard/index.html", "utf8");
const references = [...index.matchAll(/\b(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
  .map((match) => match[1]);
assert.ok(references.some((reference) => reference.endsWith(".js")), "index.html must reference JavaScript");
assert.ok(references.some((reference) => reference.endsWith(".css")), "index.html must reference CSS");
for (const reference of references) {
  assert.match(reference, /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/);
  const artifact = resolve("/app/dashboard", "." + reference);
  assert.ok(artifact.startsWith("/app/dashboard" + sep), "asset must remain below dashboard root");
  assert.ok(statSync(artifact).isFile(), reference);
}

const widgetIndex = readFileSync("/app/widget/index.html", "utf8");
const widgetReferences = [...widgetIndex.matchAll(/\b(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
  .map((match) => match[1]);
assert.ok(widgetReferences.some((reference) => reference.endsWith(".js")), "widget index.html must reference JavaScript");
assert.ok(widgetReferences.some((reference) => reference.endsWith(".css")), "widget index.html must reference CSS");
for (const reference of widgetReferences) {
  assert.match(reference, /^\/widget\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/);
  const artifact = resolve("/app/widget", "." + reference.slice("/widget".length));
  assert.ok(artifact.startsWith("/app/widget" + sep), "widget asset must remain below widget root");
  assert.ok(statSync(artifact).isFile(), reference);
}

const forbiddenPaths = [
  "/app/apps",
  "/app/conformance",
  "/app/docs",
  "/app/packages",
  "/app/scripts",
  "/app/src",
  "/app/test",
  "/app/tests",
  "/app/tsconfig.base.json",
  "/app/pnpm-lock.yaml",
  "/app/pnpm-workspace.yaml",
  "/opt/yarn-v1.22.22",
  "/usr/local/bin/corepack",
  "/usr/local/bin/npm",
  "/usr/local/bin/npx",
  "/usr/local/bin/pnpm",
  "/usr/local/bin/pnpx",
  "/usr/local/bin/yarn",
  "/usr/local/bin/yarnpkg",
  "/usr/local/lib/node_modules",
];
for (const pathname of forbiddenPaths) {
  assert.throws(() => lstatSync(pathname), { code: "ENOENT" }, pathname + " must not exist");
}

const forbiddenPackages = new Set([
  "@playwright/test",
  "@tailwindcss/vite",
  "@types/node",
  "@vitejs/plugin-react",
  "playwright",
  "react",
  "react-dom",
  "tailwindcss",
  "tsx",
  "typescript",
  "vite",
]);

function walk(pathname, visitor) {
  const metadata = lstatSync(pathname);
  visitor(pathname, metadata);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  for (const entry of readdirSync(pathname)) walk(resolve(pathname, entry), visitor);
}

const artifactViolations = {
  declarations: 0,
  maps: 0,
  sourceMapReferences: 0,
};
walk("/app", (pathname, metadata) => {
  if (pathname.endsWith(".map")) artifactViolations.maps += 1;
  if (/\.d\.(?:ts|cts|mts)$/.test(pathname)) artifactViolations.declarations += 1;
  if (metadata.isFile() && /\.(?:js|cjs|mjs)$/.test(pathname)
      && readFileSync(pathname, "utf8").includes("sourceMappingURL")) {
    artifactViolations.sourceMapReferences += 1;
  }
  assert.equal(metadata.uid, 0, pathname + " must be owned by root");
  assert.equal(metadata.gid, 0, pathname + " must be owned by root");
  if (!metadata.isSymbolicLink()) {
    assert.equal(metadata.mode & 0o022, 0, pathname + " must not be group/world writable");
  }
  if (pathname.startsWith("/app/node_modules/") && pathname.endsWith("/package.json") && metadata.isFile()) {
    const manifest = JSON.parse(readFileSync(pathname, "utf8"));
    assert.equal(forbiddenPackages.has(manifest.name), false, manifest.name + " must not be installed");
  }
});
assert.deepEqual(artifactViolations, {
  declarations: 0,
  maps: 0,
  sourceMapReferences: 0,
});

assert.throws(
  () => writeFileSync("/app/.product-image-write-probe", "blocked", { flag: "wx" }),
  (error) => error?.code === "EROFS" || error?.code === "EACCES",
  "/app must not be writable by the runtime user",
);
writeFileSync("/tmp/product-image-write-probe", "ok", { flag: "wx" });
unlinkSync("/tmp/product-image-write-probe");
`;

const expectedDockerignore = [
  "**",
  "!package.json",
  "!pnpm-lock.yaml",
  "!pnpm-workspace.yaml",
  "!tsconfig.base.json",
  "!.npmrc",
  "!apps/",
  "apps/**",
  "!apps/server/",
  "apps/server/**",
  "!apps/server/package.json",
  "!apps/server/tsconfig.json",
  "!apps/server/src/",
  "!apps/server/src/**",
  "!apps/dashboard/",
  "apps/dashboard/**",
  "!apps/dashboard/package.json",
  "!apps/dashboard/tsconfig.json",
  "!apps/dashboard/vite.config.ts",
  "!apps/dashboard/vite.widget.config.ts",
  "!apps/dashboard/index.html",
  "!apps/dashboard/src/",
  "!apps/dashboard/src/**",
  "!apps/dashboard/widget/",
  "!apps/dashboard/widget/**",
  "!packages/",
  "packages/**",
  "!packages/dashboard-client/",
  "packages/dashboard-client/**",
  "!packages/dashboard-client/package.json",
  "!packages/dashboard-client/tsconfig.json",
  "!packages/dashboard-client/src/",
  "!packages/dashboard-client/src/**",
  "!packages/protocol/",
  "packages/protocol/**",
  "!packages/protocol/package.json",
  "!packages/protocol/tsconfig.json",
  "!packages/protocol/src/",
  "!packages/protocol/src/**",
  "!packages/protocol/schemas/",
  "packages/protocol/schemas/**",
  "!packages/protocol/schemas/v1/",
  "!packages/protocol/schemas/v1/**",
  "!packages/protocol/fixtures/",
  "packages/protocol/fixtures/**",
  "!packages/protocol/fixtures/v1/",
  "packages/protocol/fixtures/v1/**",
  "!packages/protocol/fixtures/v1/health.valid.json",
  "!packages/widget/",
  "packages/widget/**",
  "!packages/widget/package.json",
  "!packages/widget/tsconfig.json",
  "!packages/widget/src/",
  "!packages/widget/src/**",
  "!packages/widget-channel/",
  "packages/widget-channel/**",
  "!packages/widget-channel/package.json",
  "!packages/widget-channel/tsconfig.json",
  "!packages/widget-channel/src/",
  "!packages/widget-channel/src/**",
  "!packages/widget-loader/",
  "packages/widget-loader/**",
  "!packages/widget-loader/package.json",
  "!packages/widget-loader/tsconfig.json",
  "!packages/widget-loader/vite.config.ts",
  "!packages/widget-loader/src/",
  "!packages/widget-loader/src/**",
  "!conformance/",
  "conformance/**",
  "!conformance/smoke/",
  "conformance/smoke/**",
  "!conformance/smoke/fake-adapter.mjs",
  "!conformance/smoke/manifest.json",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/kubeconfig",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/",
];

let imageBuilt = false;
let primaryFailure;
try {
  runInherited("docker", ["build", "--target", "runtime", "--tag", imageTag, "."]);
  imageBuilt = true;

  const inspected = JSON.parse(runCaptured("docker", ["image", "inspect", imageTag]));
  assert.equal(inspected.length, 1);
  const image = inspected[0];
  assert.equal(image.Os, "linux");
  assert.ok(["amd64", "arm64", "ppc64le", "s390x"].includes(image.Architecture), image.Architecture);
  assert.equal(image.Config.User, "node");
  assert.equal(image.Config.WorkingDir, "/app");
  assert.deepEqual(image.Config.Cmd, ["node", "dist/main.js"]);
  assert.deepEqual(Object.keys(image.Config.ExposedPorts ?? {}), ["8080/tcp"]);
  assert.equal(image.Config.StopSignal, "SIGTERM");
  assert.equal(image.Config.Healthcheck, undefined);
  assert.ok(image.Config.Env.includes("NODE_ENV=production"));
  assert.ok(image.Config.Env.includes("GAUNTLET_CONFIG_FILE=/etc/gauntlet/config.yaml"));
  assert.ok(image.Config.Env.includes("GAUNTLET_DASHBOARD_DIR=/app/dashboard"));
  assert.ok(image.Config.Env.includes("GAUNTLET_WIDGET_DIR=/app/widget"));

  runCaptured("docker", [
    "run",
    "--rm",
    "--network=none",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--entrypoint", "node",
    imageTag,
    "--input-type=module",
    "--eval", runtimeAssertions,
  ]);
  runCaptured("docker", [
    "run",
    "--rm",
    "--network=none",
    "--read-only",
    "--entrypoint", "/sbin/apk",
    imageTag,
    "info", "--exists", "libcrypto3=3.5.9-r0", "libssl3=3.5.9-r0",
  ]);

  const disabledConfigPath = resolve(repositoryRoot, "conformance/smoke/gauntlet.config.yaml");
  let disabledContainer;
  try {
    disabledContainer = startProductContainer(disabledConfigPath);
    const origin = productContainerOrigin(disabledContainer);
    await waitUntilReady(origin);
    const ready = await fetch(origin + "/ready");
    assert.equal(ready.status, 200);
    const loader = await fetch(origin + "/widget/loader.js");
    assert.equal(loader.status, 404);
  } finally {
    if (disabledContainer !== undefined) stopProductContainer(disabledContainer);
  }

  const widgetConfigDirectory = mkdtempSync(join(tmpdir(), "gauntlet-verify-widget-"));
  try {
    const widgetConfigPath = join(widgetConfigDirectory, "config.yaml");
    writeFileSync(
      widgetConfigPath,
      [
        "version: 1",
        "instance:",
        "  name: verify-widget",
        "  environment:",
        "    name: verify-widget",
        "    kind: test",
        "widget:",
        "  enabled: true",
        "targets:",
        "  - id: widget-target",
        "    label: Widget target",
        "    adapterUrl: http://127.0.0.1:9",
        "    expectedEnvironment:",
        "      name: verify-widget",
        "      kind: test",
        "    widget:",
        "      origins: [https://widget.example.test]",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o644, flag: "wx" },
    );
    let enabledContainer;
    try {
      enabledContainer = startProductContainer(widgetConfigPath);
      const origin = productContainerOrigin(enabledContainer);
      await waitUntilReady(origin);
      const loader = await fetch(origin + "/widget/loader.js");
      assert.equal(loader.status, 200);
      assert.equal(loader.headers.get("cross-origin-resource-policy"), "cross-origin");
    } finally {
      if (enabledContainer !== undefined) stopProductContainer(enabledContainer);
    }
  } finally {
    rmSync(widgetConfigDirectory, { recursive: true, force: true });
  }

  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /^ARG NODE_IMAGE=docker\.io\/library\/node:24\.20\.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf$/m,
  );
  assert.doesNotMatch(dockerfile, /--chown(?:=|\s)/);
  assert.doesNotMatch(dockerfile, /^\s*HEALTHCHECK\b/m);
  assert.match(dockerfile, /^ARG GAUNTLET_VERSION$/m);
  assert.match(dockerfile, /^ARG GAUNTLET_REVISION$/m);
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.source="https:\/\/github\.com\/8lines\/gauntlet" \\\n+      org\.opencontainers\.image\.version="\$GAUNTLET_VERSION" \\\n+      org\.opencontainers\.image\.revision="\$GAUNTLET_REVISION" \\\n+      org\.opencontainers\.image\.licenses="Apache-2\.0"$/m,
  );

  const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8")
    .trimEnd()
    .split(/\r?\n/);
  assert.deepEqual(dockerignore, expectedDockerignore);
  assert.equal(
    readFileSync(new URL("../.npmrc", import.meta.url), "utf8"),
    "engine-strict=true\nstrict-peer-dependencies=true\n",
    "the only admitted npm configuration must remain credential-free",
  );
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  if (imageBuilt) {
    const cleanup = spawnSync("docker", ["image", "rm", imageTag], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (cleanup.status !== 0 && primaryFailure === undefined) {
      throw commandFailure("docker", ["image", "rm", imageTag], cleanup);
    }
  }
}
