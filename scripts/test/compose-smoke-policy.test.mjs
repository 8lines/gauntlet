import assert from "node:assert/strict";
import { test } from "node:test";
import { assertComposeSmokeIsolation } from "../compose-smoke-policy.mjs";

const repositoryRoot = "/repo";
const configMount = {
  type: "bind",
  source: "/repo/conformance/smoke/gauntlet.config.yaml",
  target: "/etc/gauntlet/config.yaml",
  read_only: true,
  bind: { create_host_path: false },
};

function topology() {
  return {
    networks: {
      "adapter-network": {
        name: "gauntlet-smoke-static_adapter-network",
        ipam: {},
        internal: true,
      },
      "ingress-network": {
        name: "gauntlet-smoke-static_ingress-network",
        ipam: {},
      },
    },
    services: { "gauntlet": { volumes: [structuredClone(configMount)] } },
  };
}

test("accepts only project-owned exact networks and the read-only configuration mount", () => {
  assert.doesNotThrow(() => assertComposeSmokeIsolation(topology(), repositoryRoot));
});

test("rejects shared, externally managed, or expanded networks", () => {
  for (const mutate of [
    (value) => { value.networks["adapter-network"].name = "shared-adapter-network"; },
    (value) => { value.networks["ingress-network"].external = true; },
    (value) => { value.networks["ingress-network"].attachable = true; },
    (value) => { value.networks["adapter-network"].driver_opts = { hostile: "true" }; },
  ]) {
    const value = topology();
    mutate(value);
    assert.throws(() => assertComposeSmokeIsolation(value, repositoryRoot));
  }
});

test("rejects additional, writable, or socket-like Gauntlet mounts", () => {
  for (const mutate of [
    (value) => { value.services["gauntlet"].volumes.push({ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }); },
    (value) => { value.services["gauntlet"].volumes[0].read_only = false; },
    (value) => { value.services["gauntlet"].volumes[0].source = "/etc/passwd"; },
    (value) => { value.services["gauntlet"].volumes[0].target = "/var/run/docker.sock"; },
  ]) {
    const value = topology();
    mutate(value);
    assert.throws(() => assertComposeSmokeIsolation(value, repositoryRoot));
  }
});
