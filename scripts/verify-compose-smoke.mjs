import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { computeRevision, manifestSemanticsAreValid } from "../packages/protocol/dist/index.js";
import { assertComposeSmokeIsolation } from "./compose-smoke-policy.mjs";
import { sanitizedSmokeEnvironment } from "./run-compose-smoke.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(repositoryRoot, "compose.smoke.yaml");
const composeSource = readFileSync(composeFile, "utf8");
const rootReadme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
const result = spawnSync("docker", [
  "compose",
  "--project-name", "gauntlet-smoke-static",
  "--project-directory", repositoryRoot,
  "-f", composeFile,
  "config",
  "--format", "json",
], {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: sanitizedSmokeEnvironment(process.env),
  maxBuffer: 1024 * 1024,
  stdio: "pipe",
});
if (result.status !== 0) {
  throw new Error("Compose smoke topology did not render");
}

const topology = JSON.parse(result.stdout);
assert.equal(topology.volumes, undefined);
assert.equal(topology.secrets, undefined);
assert.equal(topology.configs, undefined);
assert.doesNotMatch(composeSource, /^name:/m);
assert.deepEqual(Object.keys(topology.services).sort(), ["fake-adapter-a", "fake-adapter-b", "gauntlet"]);
assertComposeSmokeIsolation(topology, repositoryRoot);
assert.match(composeSource, /^  ingress-network:\n    internal: false$/m);

for (const name of ["fake-adapter-a", "fake-adapter-b"]) {
  const service = topology.services[name];
  assert.equal(service.build.context, repositoryRoot);
  assert.deepEqual(Object.keys(service.networks), ["adapter-network"]);
  assert.equal(service.ports, undefined, `${name} must not publish a host port`);
  assert.deepEqual(service.expose, ["8081"]);
  assert.equal(service.build.target, "smoke-adapter");
  assert.equal(service.read_only, true);
  assert.equal(service.init, true);
  assert.equal(service.pids_limit, 64);
  assert.deepEqual(service.tmpfs, ["/tmp:rw,noexec,nosuid,nodev,size=8m,mode=1777"]);
  assert.equal(service.stop_grace_period, "10s");
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
  assert.equal(service.privileged, undefined);
  assert.equal(service.volumes, undefined);
  assert.deepEqual(service.healthcheck, {
    test: [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:8081/_gauntlet/v1/health', { signal: AbortSignal.timeout(1500) }).then((response) => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))",
    ],
    timeout: "2s",
    interval: "2s",
    retries: 30,
    start_period: "2s",
  });
}

const gauntlet = topology.services["gauntlet"];
assert.equal(gauntlet.build.context, repositoryRoot);
assert.deepEqual(gauntlet.environment, {
  GAUNTLET_CONFIG_FILE: "/etc/gauntlet/config.yaml",
  GAUNTLET_HOST: "0.0.0.0",
  GAUNTLET_PORT: "8080",
});
assert.deepEqual(Object.keys(gauntlet.networks).sort(), ["adapter-network", "ingress-network"]);
assert.equal(gauntlet.build.target, "runtime");
assert.equal(gauntlet.ports.length, 1);
assert.deepEqual(gauntlet.ports[0], {
  mode: "ingress",
  target: 8080,
  published: "0",
  protocol: "tcp",
  host_ip: "127.0.0.1",
});
assert.equal(gauntlet.read_only, true);
assert.equal(gauntlet.init, true);
assert.equal(gauntlet.pids_limit, 128);
assert.deepEqual(gauntlet.tmpfs, ["/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777"]);
assert.equal(gauntlet.stop_grace_period, "10s");
assert.deepEqual(gauntlet.cap_drop, ["ALL"]);
assert.deepEqual(gauntlet.security_opt, ["no-new-privileges:true"]);
assert.equal(gauntlet.privileged, undefined);
assert.deepEqual(Object.keys(gauntlet.depends_on).sort(), ["fake-adapter-a", "fake-adapter-b"]);
for (const dependency of Object.values(gauntlet.depends_on)) {
  assert.deepEqual(dependency, { condition: "service_healthy", required: true });
}
assert.deepEqual(gauntlet.healthcheck, {
  test: [
    "CMD",
    "node",
    "-e",
    "fetch('http://127.0.0.1:8080/ready', { signal: AbortSignal.timeout(1500) }).then((response) => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))",
  ],
  timeout: "2s",
  interval: "2s",
  retries: 30,
  start_period: "2s",
});
for (const service of Object.values(topology.services)) {
  assert.equal(service.image, undefined, "smoke services must use local builds only");
  assert.equal(service.container_name, undefined);
  assert.equal(service.platform, undefined);
  assert.equal(service.network_mode, undefined);
  assert.equal(service.pid, undefined);
  assert.equal(service.ipc, undefined);
  assert.equal(service.devices, undefined);
  assert.equal(service.secrets, undefined);
  assert.equal(service.env_file, undefined);
  assert.equal(service.credential_spec, undefined);
  assert.equal(service.extra_hosts, undefined);
  assert.equal(service.hostname, undefined);
  assert.equal(service.userns_mode, undefined);
}

const smokeReadme = rootReadme.match(/^### Container smoke test\n([\s\S]*?)(?=^## )/m)?.[1];
assert.ok(smokeReadme !== undefined, "root README must contain the bounded smoke section");
assert.match(smokeReadme, /\n~~~sh\npnpm smoke:compose\n~~~\n/);
assert.doesNotMatch(smokeReadme, /docker compose|GAUNTLET_URL|127\.0\.0\.1:8080|tc_project/);

const manifest = JSON.parse(readFileSync(
  resolve(repositoryRoot, "conformance/smoke/manifest.json"),
  "utf8",
));
assert.deepEqual(manifest.application.environment, { name: "compose-smoke", kind: "test" });
assert.equal(manifest.features.length, 0);
assert.equal(manifest.operations.length, 0);
assert.equal(manifest.dataSources.length, 0);
assert.equal(computeRevision(manifest, "manifestRevision"), manifest.manifestRevision);
assert.equal(manifestSemanticsAreValid(manifest), true);
