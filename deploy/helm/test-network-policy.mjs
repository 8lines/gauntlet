import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import {
  render,
  stagingValues,
} from "./test-support.mjs";

const networkPolicyValues = "deploy/helm/examples/acme-network-policy-values.yaml";
const maintainedKubernetesVersions = ["1.35.0", "1.36.0", "1.37.0"];
const stableSelector = {
  "app.kubernetes.io/name": "gauntlet",
  "app.kubernetes.io/instance": "gauntlet",
};
const dnsPeer = {
  namespaceSelector: {
    matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
  },
  podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
};
const ingressPeer = {
  namespaceSelector: {
    matchLabels: { "kubernetes.io/metadata.name": "tailscale" },
  },
  podSelector: { matchLabels: { "gauntlet-access": "allowed" } },
};
const adapterPeer = {
  namespaceSelector: {
    matchLabels: { "kubernetes.io/metadata.name": "acme-adapters" },
  },
  podSelector: { matchLabels: { "gauntlet-adapter": "enabled" } },
};

function renderPolicy(extraArgs = [], options = {}) {
  return render([stagingValues, networkPolicyValues], extraArgs, options);
}

function policies(resources) {
  return resources.filter(({ kind }) => kind === "NetworkPolicy");
}

function assertExactPeer(peer) {
  assert.deepEqual(Object.keys(peer).sort(), ["namespaceSelector", "podSelector"]);
  for (const selector of [peer.namespaceSelector, peer.podSelector]) {
    assert.deepEqual(Object.keys(selector), ["matchLabels"]);
    assert.equal(Object.keys(selector.matchLabels).length > 0, true);
  }
  assert.deepEqual(Object.keys(peer.namespaceSelector.matchLabels), [
    "kubernetes.io/metadata.name",
  ]);
}

test("disabled NetworkPolicy values render no policy on every maintained Kubernetes line", () => {
  for (const kubeVersion of maintainedKubernetesVersions) {
    assert.deepEqual(policies(render(undefined, [], { kubeVersion })), []);
  }
});

test("a populated fixture still renders no policy when explicitly disabled", () => {
  assert.deepEqual(policies(renderPolicy([
    "--set", "networkPolicy.enabled=false",
  ])), []);
});

test("the Acme fixture renders one exact selector-only isolation policy", () => {
  for (const kubeVersion of maintainedKubernetesVersions) {
    const resources = renderPolicy([], { kubeVersion });
    const renderedPolicies = policies(resources);
    assert.equal(renderedPolicies.length, 1);
    const policy = renderedPolicies[0];
    assert.equal(policy.apiVersion, "networking.k8s.io/v1");
    assert.equal(policy.metadata.name, "gauntlet");
    assert.equal(policy.metadata.namespace, "acme-staging");
    assert.deepEqual(policy.spec, {
      podSelector: { matchLabels: stableSelector },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{
        from: [ingressPeer],
        ports: [{ protocol: "TCP", port: 8080 }],
      }],
      egress: [
        {
          to: [dnsPeer],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        {
          to: [adapterPeer],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    });

    const deployment = resources.find(({ kind }) => kind === "Deployment");
    const service = resources.find(({ kind }) => kind === "Service");
    assert.deepEqual(policy.spec.podSelector.matchLabels, deployment.spec.selector.matchLabels);
    assert.deepEqual(policy.spec.podSelector.matchLabels, service.spec.selector);
    const configuration = parse(resources
      .find(({ kind }) => kind === "ConfigMap")
      .data["config.yaml"]);
    assert.equal(
      configuration.targets[0].adapterUrl,
      "http://organizations.acme-adapters.svc.cluster.local:8080",
    );
  }
});

test("empty ingress peers render a literal empty ingress list", () => {
  const [policy] = policies(renderPolicy([
    "--set-json", "networkPolicy.ingressPeers=[]",
  ]));
  assert.equal(Object.hasOwn(policy.spec, "ingress"), true);
  assert.deepEqual(policy.spec.ingress, []);
});

test("empty adapter egress keeps exactly the ordered DNS-only rule", () => {
  const [policy] = policies(renderPolicy([
    "--set-json", "networkPolicy.egressRules=[]",
  ]));
  assert.deepEqual(policy.spec.egress, [{
    to: [dnsPeer],
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  }]);
});

test("Pod ingress stays TCP 8080 independently of the Service port", () => {
  const resources = renderPolicy(["--set", "service.port=9090"]);
  const [policy] = policies(resources);
  assert.deepEqual(policy.spec.ingress[0].ports, [{ protocol: "TCP", port: 8080 }]);
  assert.equal(resources.find(({ kind }) => kind === "Service").spec.ports[0].port, 9090);
});

test("selector-only NetworkPolicy blocks ALB ingress instead of broadening source peers", () => {
  const sentinel = "network-policy-alb-secret-472801";
  const privateAlb = {
    enabled: true,
    className: "alb",
    annotations: {
      "alb.ingress.kubernetes.io/scheme": "internal",
      "alb.ingress.kubernetes.io/target-type": "ip",
      "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8",
      "gauntlet.8lines.dev/review-marker": sentinel,
    },
    hosts: [{
      host: "gauntlet.staging.internal",
      paths: [{ path: "/", pathType: "Prefix" }],
    }],
    tls: [],
  };
  assert.deepEqual(
    renderPolicy(["--set-json", `ingress=${JSON.stringify(privateAlb)}`], {
      expectedStatus: 1,
    }),
    [],
  );
  assert.throws(
    () => renderPolicy(["--set-json", `ingress=${JSON.stringify(privateAlb)}`]),
    (error) => {
      assert.equal(
        error.message,
        "Pinned Helm command failed with unexpected status 1 (expected 0)",
      );
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

test("adapter URL changes never infer NetworkPolicy peers or ports", () => {
  const sentinel = "url-must-not-select";
  const resources = renderPolicy([
    "--set-string",
    `config.targets[0].adapterUrl=http://${sentinel}.acme-adapters.svc.cluster.local:9443`,
  ]);
  const [policy] = policies(resources);
  assert.deepEqual(policy.spec.egress, [
    {
      to: [dnsPeer],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
    {
      to: [adapterPeer],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);
  assert.equal(JSON.stringify(policy).includes(sentinel), false);
  assert.equal(JSON.stringify(policy).includes("9443"), false);
});

test("each declared adapter rule remains one ordered exact egress rule", () => {
  const extraRule = {
    peers: [
      {
        namespaceSelector: {
          matchLabels: { "kubernetes.io/metadata.name": "acme-telemetry" },
        },
        podSelector: { matchLabels: { "gauntlet-adapter": "telemetry" } },
      },
      {
        namespaceSelector: {
          matchLabels: { "kubernetes.io/metadata.name": "acme-observability" },
        },
        podSelector: { matchLabels: { "gauntlet-adapter": "metrics" } },
      },
    ],
    ports: [
      { protocol: "UDP", port: 8125 },
      { protocol: "TCP", port: 8443 },
    ],
  };
  const [policy] = policies(renderPolicy([
    "--set-json", `networkPolicy.egressRules[1]=${JSON.stringify(extraRule)}`,
  ]));
  assert.equal(policy.spec.egress.length, 3);
  assert.deepEqual(policy.spec.egress[2], {
    to: extraRule.peers,
    ports: extraRule.ports,
  });
});

test("every rendered peer is a nonempty namespace-and-Pod intersection", () => {
  const [policy] = policies(renderPolicy());
  const peers = [
    ...policy.spec.ingress.flatMap((rule) => rule.from),
    ...policy.spec.egress.flatMap((rule) => rule.to),
  ];
  for (const peer of peers) assertExactPeer(peer);
  for (const rule of [...policy.spec.ingress, ...policy.spec.egress]) {
    assert.deepEqual(Object.keys(rule).sort(), [
      policy.spec.ingress.includes(rule) ? "from" : "ports",
      policy.spec.ingress.includes(rule) ? "ports" : "to",
    ].sort());
    assert.equal(rule.ports.length > 0, true);
    for (const port of rule.ports) {
      assert.deepEqual(Object.keys(port).sort(), ["port", "protocol"]);
    }
  }
  assert.equal(JSON.stringify(policy).includes("ipBlock"), false);
});

test("unsafe disabled peer extensions fail closed without leaking their values", () => {
  const sentinel = "network-policy-secret-740921";
  const input = [
    "networkPolicy:",
    "  enabled: false",
    "  ingressPeers:",
    "    - namespaceSelector:",
    "        matchLabels:",
    "          kubernetes.io/metadata.name: tailscale",
    "      podSelector:",
    "        matchLabels:",
    "          gauntlet-access: allowed",
    "      ipBlock:",
    `        cidr: ${sentinel}`,
    "",
  ].join("\n");
  assert.deepEqual(
    render([stagingValues, "-"], [], { input, expectedStatus: 1 }),
    [],
  );
  assert.throws(
    () => render([stagingValues, "-"], [], { input }),
    (error) => {
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

test("the policy template cannot inspect targets or perform cluster/network lookups", async () => {
  const source = await readFile(
    new URL("gauntlet/templates/networkpolicy.yaml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\.(?:Files|Capabilities)|\.Values\.config|adapterUrl|ipBlock/);
  assert.doesNotMatch(
    source,
    /\b(?:lookup|tpl|getHostByName|env|expandenv|randAlphaNum|randAlpha|randNumeric|randAscii)\b/,
  );
  assert.match(
    source,
    /fail "selector-only NetworkPolicy cannot safely admit ALB sources"/,
  );
});

test("the fixture documents selector, DNS, CNI, additive, ingress, and auth limits", async () => {
  const source = await readFile(
    new URL("examples/acme-network-policy-values.yaml", import.meta.url),
    "utf8",
  );
  for (const required of [
    "CNI",
    "additive",
    "not HTTP authentication",
    "immutable kubernetes.io/metadata.name",
    "networkPolicy.dns.namespaceSelector.matchLabels",
    "networkPolicy.dns.podSelector.matchLabels",
    "data-plane proxy Pods",
    "cannot safely admit ALB sources",
  ]) {
    assert.equal(source.includes(required), true, required);
  }
});
