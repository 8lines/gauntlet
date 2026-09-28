import assert from "node:assert/strict";
import { resolve } from "node:path";

const PROJECT = "gauntlet-smoke-static";

export function assertComposeSmokeIsolation(topology, repositoryRoot) {
  assert.deepEqual(topology.networks, {
    "adapter-network": {
      name: `${PROJECT}_adapter-network`,
      ipam: {},
      internal: true,
    },
    "ingress-network": {
      name: `${PROJECT}_ingress-network`,
      ipam: {},
    },
  });
  assert.deepEqual(topology.services["gauntlet"].volumes, [{
    type: "bind",
    source: resolve(repositoryRoot, "conformance/smoke/gauntlet.config.yaml"),
    target: "/etc/gauntlet/config.yaml",
    read_only: true,
    bind: { create_host_path: false },
  }]);
}
