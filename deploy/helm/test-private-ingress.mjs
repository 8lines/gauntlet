import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { helm, helmChart, render, stagingValues } from "./test-support.mjs";

const kubernetesVersions = ["1.35.0", "1.36.0", "1.37.0"];

const privateAlbIngress = {
  enabled: true,
  className: "alb",
  annotations: {
    "alb.ingress.kubernetes.io/scheme": "internal",
    "alb.ingress.kubernetes.io/target-type": "ip",
    "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8",
  },
  hosts: [{
    host: "gauntlet.staging.internal",
    paths: [{ path: "/", pathType: "Prefix" }],
  }],
  tls: [],
};

const tailscaleIngress = {
  enabled: true,
  className: "tailscale",
  annotations: {},
  hosts: [{
    paths: [{ path: "/", pathType: "Prefix" }],
  }],
  tls: [{ hosts: ["gauntlet"] }],
};

function renderIngress(ingress, options = {}) {
  const {
    expectedStatus = 0,
    extraArgs = [],
    kubeVersion = "1.35.0",
  } = options;
  return render([stagingValues, "-"], extraArgs, {
    expectedStatus,
    input: stringify({ ingress }),
    kubeVersion,
  });
}

function rejectIngress(ingress, label, kubeVersion = "1.35.0") {
  assert.deepEqual(
    renderIngress(ingress, { expectedStatus: 1, kubeVersion }),
    [],
    label,
  );
}

function onlyIngress(resources) {
  const ingresses = resources.filter(({ kind }) => kind === "Ingress");
  assert.equal(ingresses.length, 1);
  return ingresses[0];
}

function chartBackend(port) {
  return {
    service: {
      name: "gauntlet",
      port: { number: port },
    },
  };
}

test("default values render no Ingress on every maintained Kubernetes line", () => {
  for (const kubeVersion of kubernetesVersions) {
    assert.equal(
      render(undefined, [], { kubeVersion }).some(({ kind }) => kind === "Ingress"),
      false,
      kubeVersion,
    );
  }
});

test("the private ALB example renders one exact internal Ingress on every maintained Kubernetes line", async () => {
  const version = (await readFile(new URL("../../VERSION", import.meta.url), "utf8")).trimEnd();
  const chart = parse(await readFile(
    new URL("gauntlet/Chart.yaml", import.meta.url),
    "utf8",
  ));
  assert.equal(chart.version, version);
  assert.equal(chart.appVersion, version);
  for (const kubeVersion of kubernetesVersions) {
    const resources = render([
      stagingValues,
      "deploy/helm/examples/private-alb-values.yaml",
    ], [], { kubeVersion });
    const ingress = onlyIngress(resources);

    assert.equal(ingress.apiVersion, "networking.k8s.io/v1");
    assert.equal(ingress.metadata.name, "gauntlet");
    assert.equal(ingress.metadata.namespace, "acme-staging");
    assert.deepEqual(ingress.metadata.labels, {
      "helm.sh/chart": `${chart.name}-${version}`,
      "app.kubernetes.io/name": "gauntlet",
      "app.kubernetes.io/instance": "gauntlet",
      "app.kubernetes.io/version": version,
      "app.kubernetes.io/component": "control-plane",
      "app.kubernetes.io/part-of": "gauntlet",
      "app.kubernetes.io/managed-by": "Helm",
    });
    assert.deepEqual(ingress.metadata.annotations, {
      "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8",
      "alb.ingress.kubernetes.io/scheme": "internal",
      "alb.ingress.kubernetes.io/target-type": "ip",
    });
    assert.deepEqual(ingress.spec, {
      ingressClassName: "alb",
      rules: [{
        host: "gauntlet.staging.internal",
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: chartBackend(8080),
          }],
        },
      }],
    });
    assert.equal(Object.hasOwn(ingress.spec, "defaultBackend"), false);
    assert.equal(resources.filter(({ kind }) => kind === "Ingress").length, 1);
    assert.deepEqual(
      resources.map(({ kind }) => kind).sort(),
      ["ConfigMap", "Deployment", "Ingress", "Service"],
    );
    assert.equal(resources.some(({ kind }) => [
      "ClusterRole",
      "ClusterRoleBinding",
      "Role",
      "RoleBinding",
      "Secret",
      "ServiceAccount",
    ].includes(kind)), false);
  }
});

test("the Tailscale example uses one hostless rule and one short MagicDNS request", () => {
  for (const kubeVersion of kubernetesVersions) {
    const ingress = onlyIngress(render([
      stagingValues,
      "deploy/helm/examples/tailscale-values.yaml",
    ], [], { kubeVersion }));

    assert.equal(Object.hasOwn(ingress.metadata, "annotations"), false);
    assert.deepEqual(ingress.spec, {
      ingressClassName: "tailscale",
      tls: [{ hosts: ["gauntlet"] }],
      rules: [{
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: chartBackend(8080),
          }],
        },
      }],
    });
    assert.equal(Object.hasOwn(ingress.spec.tls[0], "secretName"), false);
    assert.equal(Object.hasOwn(ingress.spec.rules[0], "host"), false);
    assert.equal(Object.hasOwn(ingress.spec, "defaultBackend"), false);
  }
});

test("generic controllers preserve rule, path, TLS, annotation, and numbered backend order", () => {
  const ingress = onlyIngress(renderIngress({
    enabled: true,
    className: "private-nginx",
    annotations: {
      "example.internal/owner": "test-team",
      "nginx.ingress.kubernetes.io/ssl-redirect": "true",
    },
    hosts: [
      {
        host: "first.staging.internal",
        paths: [
          { path: "/exact", pathType: "Exact" },
          { path: "/", pathType: "Prefix" },
        ],
      },
      {
        host: "second.staging.internal",
        paths: [{ path: "/custom", pathType: "ImplementationSpecific" }],
      },
    ],
    tls: [
      { hosts: ["first.staging.internal"], secretName: "first-private-cert" },
      { hosts: ["second.staging.internal"] },
    ],
  }, {
    extraArgs: ["--set", "service.port=9090"],
  }));

  assert.deepEqual(ingress.metadata.annotations, {
    "example.internal/owner": "test-team",
    "nginx.ingress.kubernetes.io/ssl-redirect": "true",
  });
  assert.deepEqual(ingress.spec, {
    ingressClassName: "private-nginx",
    tls: [
      { hosts: ["first.staging.internal"], secretName: "first-private-cert" },
      { hosts: ["second.staging.internal"] },
    ],
    rules: [
      {
        host: "first.staging.internal",
        http: {
          paths: [
            { path: "/exact", pathType: "Exact", backend: chartBackend(9090) },
            { path: "/", pathType: "Prefix", backend: chartBackend(9090) },
          ],
        },
      },
      {
        host: "second.staging.internal",
        http: {
          paths: [{
            path: "/custom",
            pathType: "ImplementationSpecific",
            backend: chartBackend(9090),
          }],
        },
      },
    ],
  });
});

test("ordinary ingress rejects host, path, and TLS ambiguity", () => {
  const cases = [
    ["hostless ordinary rule", {
      enabled: true,
      className: "private-nginx",
      annotations: {},
      hosts: [{ paths: [{ path: "/", pathType: "Prefix" }] }],
      tls: [],
    }],
    ["duplicate rule hosts", {
      enabled: true,
      className: "private-nginx",
      annotations: {},
      hosts: [
        { host: "duplicate.staging.internal", paths: [{ path: "/one", pathType: "Prefix" }] },
        { host: "duplicate.staging.internal", paths: [{ path: "/two", pathType: "Prefix" }] },
      ],
      tls: [],
    }],
    ["duplicate paths with different path types", {
      enabled: true,
      className: "private-nginx",
      annotations: {},
      hosts: [{
        host: "gauntlet.staging.internal",
        paths: [
          { path: "/duplicate", pathType: "Exact" },
          { path: "/duplicate", pathType: "Prefix" },
        ],
      }],
      tls: [],
    }],
    ["globally duplicate TLS host", {
      enabled: true,
      className: "private-nginx",
      annotations: {},
      hosts: [{
        host: "gauntlet.staging.internal",
        paths: [{ path: "/", pathType: "Prefix" }],
      }],
      tls: [
        { hosts: ["gauntlet.staging.internal"] },
        { hosts: ["gauntlet.staging.internal"] },
      ],
    }],
    ["TLS host without a matching rule", {
      enabled: true,
      className: "private-nginx",
      annotations: {},
      hosts: [{
        host: "gauntlet.staging.internal",
        paths: [{ path: "/", pathType: "Prefix" }],
      }],
      tls: [{ hosts: ["other.staging.internal"] }],
    }],
  ];

  for (const [label, ingress] of cases) rejectIngress(ingress, label);
});

test("Tailscale mode rejects non-controller shapes, secrets, FQDNs, and Funnel at any value", () => {
  const cases = [
    ["named rule", {
      ...tailscaleIngress,
      hosts: [{
        host: "gauntlet",
        paths: [{ path: "/", pathType: "Prefix" }],
      }],
    }],
    ["more than one rule", {
      ...tailscaleIngress,
      hosts: [
        { paths: [{ path: "/", pathType: "Prefix" }] },
        { paths: [{ path: "/second", pathType: "Prefix" }] },
      ],
    }],
    ["missing TLS block", { ...tailscaleIngress, tls: [] }],
    ["more than one TLS block", {
      ...tailscaleIngress,
      tls: [{ hosts: ["gauntlet"] }, { hosts: ["other-gauntlet"] }],
    }],
    ["more than one requested MagicDNS label", {
      ...tailscaleIngress,
      tls: [{ hosts: ["gauntlet", "other-gauntlet"] }],
    }],
    ["MagicDNS FQDN instead of a short label", {
      ...tailscaleIngress,
      tls: [{ hosts: ["gauntlet.example.ts.net"] }],
    }],
    ["controller-managed TLS secret override", {
      ...tailscaleIngress,
      tls: [{ hosts: ["gauntlet"], secretName: "operator-secret" }],
    }],
    ["Funnel enabled", {
      ...tailscaleIngress,
      annotations: { "tailscale.com/funnel": "true" },
    }],
    ["Funnel key present with false text", {
      ...tailscaleIngress,
      annotations: { "tailscale.com/funnel": "false" },
    }],
  ];

  for (const [label, ingress] of cases) rejectIngress(ingress, label);
});

test("the template independently bounds the Tailscale MagicDNS label", () => {
  const longMagicDnsLabel = "a".repeat(64);
  const input = stringify({
    ingress: {
      ...tailscaleIngress,
      tls: [{ hosts: [longMagicDnsLabel] }],
    },
  });

  assert.doesNotThrow(() => helm([
    "template",
    "gauntlet",
    helmChart,
    "--namespace",
    "acme-staging",
    "--kube-version",
    "1.35.0",
    "--skip-schema-validation",
    "-f",
    stagingValues,
    "-f",
    "-",
  ], 1, { input }));
});

test("ALB mode rejects missing, malformed, broad, or public controller settings", () => {
  const annotationsWithoutScheme = {
    "alb.ingress.kubernetes.io/target-type": "ip",
    "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8",
  };
  const annotationsWithoutTargetType = {
    "alb.ingress.kubernetes.io/scheme": "internal",
    "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8",
  };
  const annotationsWithoutCidrs = {
    "alb.ingress.kubernetes.io/scheme": "internal",
    "alb.ingress.kubernetes.io/target-type": "ip",
  };
  const cases = [
    ["missing scheme", { ...privateAlbIngress, annotations: annotationsWithoutScheme }],
    ["internet-facing scheme", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/scheme": "internet-facing",
      },
    }],
    ["missing target type", { ...privateAlbIngress, annotations: annotationsWithoutTargetType }],
    ["instance target type", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/target-type": "instance",
      },
    }],
    ["missing inbound CIDRs", { ...privateAlbIngress, annotations: annotationsWithoutCidrs }],
    ["blank inbound CIDRs", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "   ",
      },
    }],
    ["empty entry in inbound CIDRs", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8, ,192.168.0.0/16",
      },
    }],
    ["all-IPv4 inbound CIDR", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "0.0.0.0/0",
      },
    }],
    ["noncanonical all-IPv4 inbound CIDR", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/0",
      },
    }],
    ["zero-padded all-IPv4 prefix", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/00",
      },
    }],
    ["all-IPv6 inbound CIDR in a list", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8, ::/0",
      },
    }],
    ["non-CIDR text", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "not-a-cidr",
      },
    }],
    ["invalid IPv4 octet", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "999.999.999.999/32",
      },
    }],
    ["out-of-range IPv4 prefix", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/33",
      },
    }],
    ["negative IPv4 prefix", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/-1",
      },
    }],
    ["nonnumeric IPv4 prefix", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/private",
      },
    }],
    ["public IPv4 range", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "8.8.8.8/32",
      },
    }],
    ["noncanonical private network address", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.1.2.3/8",
      },
    }],
    ["noncanonical partial-octet network address", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.65.0.0/10",
      },
    }],
    ["prefix broader than the RFC1918 172 block", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "172.16.0.0/11",
      },
    }],
    ["prefix broader than the RFC1918 192 block", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "192.168.0.0/15",
      },
    }],
    ["zero-padded IPv4 octet", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "010.0.0.0/8",
      },
    }],
    ["zero-padded private prefix", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/08",
      },
    }],
    ["IPv6 range outside the v0.1 boundary", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "fd00::/8",
      },
    }],
    ["two public halves covering all IPv4", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "0.0.0.0/1,128.0.0.0/1",
      },
    }],
    ["public frontend NLB", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/enable-frontend-nlb": "true",
        "alb.ingress.kubernetes.io/frontend-nlb-scheme": "internet-facing",
      },
    }],
    ["frontend NLB EIP allocations", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/enable-frontend-nlb": "true",
        "alb.ingress.kubernetes.io/frontend-nlb-scheme": "internal",
        "alb.ingress.kubernetes.io/frontend-nlb-eip-allocations": "eipalloc-public",
      },
    }],
  ];

  for (const [label, ingress] of cases) rejectIngress(ingress, label);
});

test("ALB mode accepts canonical bounded RFC1918 IPv4 ranges", () => {
  for (const inboundCidrs of [
    "10.0.0.0/8",
    "10.64.0.0/10",
    "172.16.0.0/12",
    "172.20.0.0/14",
    "192.168.0.0/16",
    "192.168.42.0/24",
    "10.0.0.1/32, 172.31.255.255/32, 192.168.255.255/32",
  ]) {
    assert.doesNotThrow(() => renderIngress({
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": inboundCidrs,
      },
    }), inboundCidrs);
  }
});

test("public and ambiguous settings fail on every maintained Kubernetes line", () => {
  const cases = [
    ["broad ALB", {
      ...privateAlbIngress,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8,0.0.0.0/0",
      },
    }],
    ["Tailscale Funnel", {
      ...tailscaleIngress,
      annotations: { "tailscale.com/funnel": "false" },
    }],
    ["duplicate host", {
      enabled: true,
      className: "private-nginx",
      annotations: {},
      hosts: [
        { host: "duplicate.staging.internal", paths: [{ path: "/", pathType: "Prefix" }] },
        { host: "duplicate.staging.internal", paths: [{ path: "/other", pathType: "Prefix" }] },
      ],
      tls: [],
    }],
  ];

  for (const kubeVersion of kubernetesVersions) {
    for (const [label, ingress] of cases) {
      rejectIngress(ingress, `${label} on ${kubeVersion}`, kubeVersion);
    }
  }
});

test("unsafe dormant ingress settings fail before the enabled branch", () => {
  const cases = [
    ["disabled ordinary hostless rule", {
      enabled: false,
      className: "private-nginx",
      annotations: {},
      hosts: [{ paths: [{ path: "/", pathType: "Prefix" }] }],
      tls: [],
    }],
    ["disabled Tailscale Funnel", {
      ...tailscaleIngress,
      enabled: false,
      annotations: { "tailscale.com/funnel": "false" },
    }],
    ["disabled public ALB", {
      ...privateAlbIngress,
      enabled: false,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/scheme": "internet-facing",
      },
    }],
    ["disabled malformed ALB CIDR", {
      ...privateAlbIngress,
      enabled: false,
      annotations: {
        ...privateAlbIngress.annotations,
        "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/not-a-prefix",
      },
    }],
  ];

  for (const kubeVersion of kubernetesVersions) {
    for (const [label, ingress] of cases) {
      rejectIngress(ingress, `${label} on ${kubeVersion}`, kubeVersion);
    }
  }
});

test("validation failures expose only fixed diagnostics", async () => {
  const sentinel = "ingress-secret-sentinel-871943";
  const ingress = {
    ...privateAlbIngress,
    annotations: {
      ...privateAlbIngress.annotations,
      "alb.ingress.kubernetes.io/inbound-cidrs": `0.0.0.0/0,${sentinel}`,
    },
  };

  assert.throws(
    () => renderIngress(ingress),
    (error) => {
      assert.equal(
        error.message,
        "Pinned Helm command failed with unexpected status 1 (expected 0)",
      );
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );

  const source = await readFile(
    new URL("gauntlet/templates/ingress.yaml", import.meta.url),
    "utf8",
  );
  const failLines = source.split("\n").filter((line) => /\bfail\b/.test(line));
  assert.equal(failLines.length >= 10, true);
  for (const line of failLines) {
    assert.match(line, /^\s*\{\{-?\s*fail\s+"[A-Za-z0-9 .:/-]+"\s*-?\}\}\s*$/);
  }
  assert.doesNotMatch(source, /\bfail\s+(?:\$|printf|\()/);
  assert.equal(
    source.lastIndexOf("fail") < source.indexOf("{{- if .Values.ingress.enabled }}"),
    true,
  );
});
