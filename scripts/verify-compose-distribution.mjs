import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const composeFile = fileURLToPath(new URL("../deploy/compose/compose.yaml", import.meta.url));
const buildOverrideFile = fileURLToPath(new URL("../deploy/compose/compose.build.yaml", import.meta.url));
const environmentFile = fileURLToPath(new URL("../deploy/compose/.env.example", import.meta.url));
const expectedConfigSource = fileURLToPath(new URL("../deploy/compose/config.yaml", import.meta.url));
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function sanitizedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("COMPOSE_") && !key.startsWith("GAUNTLET_")),
  );
}

function renderComposeModel(composeFiles, environmentOverrides = {}) {
  const args = [
    "compose",
    "--env-file", environmentFile,
  ];
  for (const file of composeFiles) args.push("-f", file);
  args.push("config", "--format", "json");
  const result = spawnSync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...sanitizedEnvironment(), ...environmentOverrides },
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: "pipe",
  });
  if (result.error !== undefined) throw result.error;
  assert.equal(result.signal, null, "Compose rendering must not be interrupted");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "", "Compose rendering must not emit warnings");
  return JSON.parse(result.stdout);
}

function assertReleaseImage(image) {
  assert.equal(typeof image, "string");
  const stableVersion = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
  const digest = "@sha256:[0-9a-f]{64}";
  const allowed = new RegExp(
    `^ghcr\\.io/8lines/gauntlet(?::${stableVersion}(?:${digest})?|${digest})$`,
  );
  assert.match(image, allowed, "image must use the official repository and an immutable release coordinate");
}

function ownKeys(value) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.keys(value).sort();
}

function declarativeServiceKeys(service) {
  const keys = ownKeys(service);
  for (const serializerDefault of ["command", "entrypoint"]) {
    if (Object.hasOwn(service, serializerDefault)) {
      assert.equal(service[serializerDefault], null);
    }
  }
  return keys.filter((key) => key !== "command" && key !== "entrypoint");
}

function declarativeNetworkKeys(network) {
  const keys = ownKeys(network);
  if (Object.hasOwn(network, "ipam")) {
    assert.deepEqual(network.ipam, {});
  }
  return keys.filter((key) => key !== "ipam");
}

const model = renderComposeModel([composeFile]);
const composeDocument = parseDocument(readFileSync(composeFile, "utf8"), {
  prettyErrors: false,
  uniqueKeys: true,
});
assert.deepEqual(composeDocument.errors, []);
const composeSourceModel = composeDocument.toJS({ maxAliasCount: 0 });
assert.deepEqual(
  composeSourceModel.services["gauntlet"].volumes[0].bind,
  { create_host_path: false },
);
assert.deepEqual(ownKeys(model), ["name", "networks", "services"]);
assert.equal(model.name, "gauntlet");
assert.deepEqual(ownKeys(model.services), ["gauntlet"]);
assert.deepEqual(ownKeys(model.networks), ["adapters", "ingress"]);
assert.equal(Object.hasOwn(model, "secrets"), false);
assert.equal(Object.hasOwn(model, "configs"), false);
assert.equal(Object.hasOwn(model, "volumes"), false);

const service = model.services["gauntlet"];
assert.deepEqual(declarativeServiceKeys(service), [
  "cap_drop",
  "environment",
  "healthcheck",
  "image",
  "init",
  "networks",
  "pids_limit",
  "ports",
  "read_only",
  "restart",
  "security_opt",
  "stop_grace_period",
  "tmpfs",
  "volumes",
]);
assertReleaseImage(service.image);
for (const forbidden of [
  "build",
  "configs",
  "container_name",
  "devices",
  "device_cgroup_rules",
  "ipc",
  "network_mode",
  "pid",
  "platform",
  "privileged",
  "secrets",
  "user",
  "userns_mode",
  "uts",
]) {
  assert.equal(Object.hasOwn(service, forbidden), false, `${forbidden} must not be configured`);
}

assert.equal(service.restart, "unless-stopped");
assert.equal(service.init, true);
assert.equal(service.read_only, true);
assert.equal(service.pids_limit, 128);
assert.equal(service.stop_grace_period, "10s");
assert.deepEqual(service.cap_drop, ["ALL"]);
assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
assert.equal(Array.isArray(service.tmpfs), true);
assert.equal(service.tmpfs.length, 1);
assert.match(service.tmpfs[0], /^\/tmp:(?:size=(?:16m|16777216),mode=1777|mode=1777,size=(?:16m|16777216))$/);

assert.deepEqual(service.environment, {
  GAUNTLET_CONFIG_FILE: "/etc/gauntlet/config.yaml",
  GAUNTLET_HOST: "0.0.0.0",
  GAUNTLET_PORT: "8080",
  GAUNTLET_MCP_ENABLED: "false",
  GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: "[]",
});

assert.equal(service.ports.length, 1);
assert.deepEqual(service.ports[0], {
  mode: "ingress",
  target: 8080,
  published: "8080",
  protocol: "tcp",
  host_ip: "127.0.0.1",
});

assert.equal(service.volumes.length, 1);
const renderedConfigVolume = service.volumes[0];
assert.deepEqual({ ...renderedConfigVolume, bind: {} }, {
  type: "bind",
  source: expectedConfigSource,
  target: "/etc/gauntlet/config.yaml",
  read_only: true,
  bind: {},
});
assert.deepEqual(
  ownKeys(renderedConfigVolume.bind),
  Object.hasOwn(renderedConfigVolume.bind, "create_host_path") ? ["create_host_path"] : [],
);
if (Object.hasOwn(renderedConfigVolume.bind, "create_host_path")) {
  assert.equal(renderedConfigVolume.bind.create_host_path, false);
}
assert.doesNotMatch(renderedConfigVolume.source, /config\.example\.yaml$/);

assert.deepEqual(ownKeys(service.networks), ["adapters", "ingress"]);
assert.deepEqual(declarativeNetworkKeys(model.networks.adapters), ["external", "name"]);
assert.equal(model.networks.adapters.name, "gauntlet");
assert.equal(model.networks.adapters.external, true);
assert.deepEqual(declarativeNetworkKeys(model.networks.ingress), ["internal", "name"]);
assert.equal(model.networks.ingress.name, "gauntlet_ingress");
assert.equal(model.networks.ingress.internal, true);
assert.notEqual(model.networks.ingress.external, true);

assert.deepEqual(ownKeys(service.healthcheck), [
  "interval",
  "retries",
  "start_period",
  "test",
  "timeout",
]);
assert.deepEqual(service.healthcheck.test.slice(0, 3), ["CMD", "node", "-e"]);
assert.equal(service.healthcheck.test.length, 4);
assert.equal(
  service.healthcheck.test[3],
  "fetch('http://127.0.0.1:8080/ready', { signal: AbortSignal.timeout(1500) }).then((response) => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))",
);
assert.equal(service.healthcheck.interval, "10s");
assert.equal(service.healthcheck.timeout, "2s");
assert.equal(service.healthcheck.retries, 6);
assert.equal(service.healthcheck.start_period, "5s");

const serializedService = JSON.stringify(service);
assert.equal(serializedService.includes("/_gauntlet/v1"), false);
assert.equal(serializedService.includes("/ready"), true);
assert.equal(serializedService.includes("docker.sock"), false);
assert.doesNotMatch(serializedService, /(?:^|[._:-])(?:prod|production|live)(?:$|[._:-])/i);
assert.doesNotMatch(serializedService, /(?:authorization|password|secret|token)/i);

const environmentKeys = readFileSync(environmentFile, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => line.slice(0, line.indexOf("=")));
assert.deepEqual(environmentKeys, [
  "GAUNTLET_IMAGE",
  "GAUNTLET_BIND",
  "GAUNTLET_PORT",
  "GAUNTLET_CONFIG_PATH",
  "GAUNTLET_MCP_ENABLED",
  "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON",
]);

const buildModel = renderComposeModel([composeFile, buildOverrideFile]);
const buildService = buildModel.services["gauntlet"];
assert.equal(buildService.image, "gauntlet:local");
assert.equal(buildService.pull_policy, "build");
assert.deepEqual(ownKeys(buildService.build), ["context", "dockerfile", "target"]);
assert.equal(buildService.build.context, realpathSync(repositoryRoot));
assert.equal(buildService.build.dockerfile, "Dockerfile");
assert.equal(buildService.build.target, "runtime");

function withoutImageSource(renderedModel) {
  const copy = structuredClone(renderedModel);
  const renderedService = copy.services["gauntlet"];
  delete renderedService.image;
  delete renderedService.build;
  delete renderedService.pull_policy;
  return copy;
}

assert.deepEqual(withoutImageSource(buildModel), withoutImageSource(model));

const enabledMcpModel = renderComposeModel([composeFile], {
  GAUNTLET_MCP_ENABLED: "true",
  GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: '["https://ai.internal.example"]',
});
assert.equal(enabledMcpModel.services["gauntlet"].environment.GAUNTLET_MCP_ENABLED, "true");
assert.equal(enabledMcpModel.services["gauntlet"].environment.GAUNTLET_MCP_ALLOWED_ORIGINS_JSON, '["https://ai.internal.example"]');
