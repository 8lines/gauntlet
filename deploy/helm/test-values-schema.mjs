import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { parseReleaseVersion } from "../../scripts/release/release-model.mjs";
import { helm, render } from "./test-support.mjs";

const chart = "deploy/helm/gauntlet";
const stagingValues = "deploy/helm/ci/staging-values.yaml";
const sharedSchemaUrl = new URL("../../config/gauntlet-config-v1.schema.json", import.meta.url);
const chartSchemaUrl = new URL("gauntlet/values.schema.json", import.meta.url);
const helpersUrl = new URL("gauntlet/templates/_helpers.tpl", import.meta.url);

function withStaging(extraArgs = [], release = "gauntlet") {
  return [
    "template",
    release,
    chart,
    "-f",
    stagingValues,
    "--kube-version",
    "1.35.0",
    ...extraArgs,
  ];
}

function normalizedDraft7Fragment(value) {
  if (Array.isArray(value)) return value.map(normalizedDraft7Fragment);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "$ref" && typeof child === "string"
      ? child.replace("#/$defs/", "#/definitions/")
      : normalizedDraft7Fragment(child),
  ]));
}

test("staging values lint and render on every maintained Kubernetes line", () => {
  for (const kubernetesVersion of ["1.35.0", "1.36.0", "1.37.0"]) {
    helm(["lint", chart, "-f", stagingValues, "--kube-version", kubernetesVersion], 0);
    helm([
      "template", "gauntlet", chart, "-f", stagingValues,
      "--kube-version", kubernetesVersion,
    ], 0);
  }
  helm([
    "template", "gauntlet", chart, "-f", stagingValues,
    "--kube-version", "1.32.9",
  ], 1);
});

test("chart metadata and defaults are release-aligned but deliberately undeployable", async () => {
  const version = parseReleaseVersion(await readFile(new URL("../../VERSION", import.meta.url)));
  const metadata = parse(await readFile(new URL("gauntlet/Chart.yaml", import.meta.url), "utf8"));
  const defaults = parse(await readFile(new URL("gauntlet/values.yaml", import.meta.url), "utf8"));
  assert.deepEqual(metadata, {
    apiVersion: "v2",
    name: "gauntlet",
    description: "Private non-production Gauntlet control plane and dashboard",
    type: "application",
    version,
    appVersion: version,
    kubeVersion: ">=1.33.0-0",
    annotations: { "artifacthub.io/license": "Apache-2.0" },
  });
  assert.equal(defaults.replicaCount, 1);
  assert.deepEqual(defaults.image, {
    repository: "ghcr.io/8lines/gauntlet",
    tag: version,
    digest: "",
    pullPolicy: "IfNotPresent",
  });
  assert.equal(defaults.service.type, "ClusterIP");
  assert.equal(defaults.service.port, 8080);
  assert.equal(defaults.ingress.enabled, false);
  assert.equal(defaults.networkPolicy.enabled, false);
  assert.equal(defaults.config.instance.name, "");
  assert.deepEqual(defaults.config.instance.environment, { name: "", kind: "" });
  assert.deepEqual(defaults.config.targets, []);
  helm(["lint", chart, "--kube-version", "1.35.0"], 1);
  helm(["template", "gauntlet", chart, "--kube-version", "1.35.0"], 1);
});

test("selector labels quote YAML-like release names as strings", async () => {
  const helpers = await readFile(helpersUrl, "utf8");
  assert.match(
    helpers,
    /^app\.kubernetes\.io\/instance: \{\{ \.Release\.Name \| trunc 63 \| trimSuffix "-" \| quote \}\}$/m,
  );
  for (const release of ["true", "false", "null"]) helm(withStaging([], release), 0);
});

test("the draft-07 values schema preserves all canonical configuration fragments", async () => {
  const shared = JSON.parse(await readFile(sharedSchemaUrl, "utf8"));
  const schema = JSON.parse(await readFile(chartSchemaUrl, "utf8"));
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(Object.hasOwn(schema, "$defs"), false);
  for (const name of ["id", "environment", "origin", "target", "exactOrigin", "widget", "targetWidget"]) {
    assert.deepEqual(schema.definitions[name], normalizedDraft7Fragment(shared.$defs[name]), name);
  }
  const references = JSON.stringify(schema).match(/"\$ref":"([^"]+)"/g) ?? [];
  assert.equal(references.length > 0, true);
  assert.equal(references.every((reference) => reference.includes("#/definitions/")), true);
  assert.equal(/\(\?[=!<]/.test(JSON.stringify(schema)), false, "lookaround is not Helm-portable");
});

test("widget configuration passes through the chart and invalid origins are rejected", () => {
  const resources = render(undefined, [
    "--set-json", "config.widget={\"enabled\":true}",
    "--set-json", "config.targets[0].widget={\"origins\":[\"https://shop.staging.example\"]}",
  ]);
  const configMap = resources.find(({ kind }) => kind === "ConfigMap");
  const rendered = parse(configMap.data["config.yaml"]);
  assert.deepEqual(rendered.widget, { enabled: true });
  assert.deepEqual(rendered.targets[0].widget, { origins: ["https://shop.staging.example"] });

  helm(withStaging([
    "--set-json", "config.targets[0].widget={\"origins\":[\"https://shop.staging.example/\"]}",
  ]), 1);
  helm(withStaging(["--set-json", "config.widget={\"enabled\":\"yes\"}"]), 1);
});

test("valid digest, private ingress, explicit peers, and long release names remain usable", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  helm(withStaging([
    "--set-string", "image.tag=",
    "--set-string", `image.digest=${digest}`,
  ]), 0);
  helm(withStaging([
    "--set-json",
    "ingress={\"enabled\":true,\"className\":\"alb\",\"annotations\":{\"alb.ingress.kubernetes.io/scheme\":\"internal\",\"alb.ingress.kubernetes.io/target-type\":\"ip\",\"alb.ingress.kubernetes.io/inbound-cidrs\":\"10.0.0.0/8\"},\"hosts\":[{\"host\":\"gauntlet.staging.internal\",\"paths\":[{\"path\":\"/\",\"pathType\":\"Prefix\"}]}],\"tls\":[]}",
  ]), 0);
  helm(withStaging([
    "--set-json",
    "ingress={\"enabled\":true,\"className\":\"tailscale\",\"annotations\":{},\"hosts\":[{\"paths\":[{\"path\":\"/\",\"pathType\":\"Prefix\"}]}],\"tls\":[{\"hosts\":[\"gauntlet\"]}]}",
  ]), 0);
  helm(withStaging([
    "--set-json",
    "networkPolicy={\"enabled\":true,\"dns\":{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"kube-system\"}},\"podSelector\":{\"matchLabels\":{\"k8s-app\":\"kube-dns\"}}},\"ingressPeers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"ingress-private\"}},\"podSelector\":{\"matchLabels\":{\"gauntlet-access\":\"allowed\"}}}],\"egressRules\":[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"acme-adapters\"}},\"podSelector\":{\"matchLabels\":{\"gauntlet-adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":8080}]}]}",
  ]), 0);
  helm(withStaging([], "r".repeat(53)), 0);
});

test("all supported non-production kinds and non-token names pass schema validation", () => {
  for (const kind of ["development", "test", "qa", "staging", "uat", "preview", "sandbox"]) {
    helm(withStaging([
      "--set-string", `config.instance.environment.kind=${kind}`,
      "--set-string", `config.targets[0].expectedEnvironment.kind=${kind}`,
    ]), 0);
  }
  for (const name of ["product-demo", "lively", "staging-eu"]) {
    helm(withStaging([
      "--set-string", `config.instance.environment.name=${name}`,
      "--set-string", `config.targets[0].expectedEnvironment.name=${name}`,
    ]), 0);
  }
});

test("Kubernetes DNS and qualified-name length boundaries remain usable", () => {
  const segment63 = "a".repeat(63);
  const prefix253 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  helm(withStaging(["-f", "-"]), 0, {
    input: [
      "imagePullSecrets:",
      `  - name: ${segment63}.internal`,
      "podAnnotations:",
      `  ${prefix253}/${segment63}: value`,
      "podLabels:",
      `  ${prefix253}/${segment63}: value`,
      "",
    ].join("\n"),
  });
});

test("image, environment, target, service, and fixed-shape values fail closed", () => {
  const segment64 = "a".repeat(64);
  const prefix254 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`;
  const invalidCases = [
    ["replica overlap", ["--set", "replicaCount=2"]],
    ["foreign image", ["--set-string", "image.repository=example.invalid/gauntlet"]],
    ["floating tag", ["--set-string", "image.tag=latest"]],
    ["named tag", ["--set-string", "image.tag=edge"]],
    ["short tag", ["--set-string", "image.tag=1.2"]],
    ["leading-zero tag", ["--set-string", "image.tag=01.2.3"]],
    ["prerelease tag", ["--set-string", "image.tag=1.2.3-rc.1"]],
    ["build-metadata tag", ["--set-string", "image.tag=1.2.3+build"]],
    ["oversized numeric tag", ["--set-string", `image.tag=${"1".repeat(126)}.1.1`]],
    ["uppercase digest", ["--set-string", "image.tag=", "--set-string", `image.digest=sha256:${"A".repeat(64)}`]],
    ["short digest", ["--set-string", "image.tag=", "--set-string", "image.digest=sha256:abcd"]],
    ["tag and digest", ["--set-string", `image.digest=sha256:${"a".repeat(64)}`]],
    ["no image identity", ["--set-string", "image.tag="]],
    ["unsupported pull policy", ["--set-string", "image.pullPolicy=Never"]],
    ["image extension", ["--set-string", "image.registrySecret=hidden"]],
    ["unknown top-level field", ["--set-string", "configSecret=hidden"]],
    ["unknown configuration field", ["--set-string", "config.secret=hidden"]],
    ["wrong configuration version", ["--set", "config.version=2"]],
    ["empty instance id", ["--set-string", "config.instance.name="]],
    ["unsupported environment kind", ["--set-string", "config.instance.environment.kind=production"]],
    ["empty targets", ["--set-json", "config.targets=[]"]],
    ["missing target field", ["--set-json", "config.targets=[{\"id\":\"portal\",\"label\":\"Portal\",\"adapterUrl\":\"http://portal:8080\"}]"]],
    ["target extension", ["--set-string", "config.targets[0].secret=hidden"]],
    ["credential URL", ["--set-string", "config.targets[0].adapterUrl=http://user:password@portal:8080"]],
    ["URL path", ["--set-string", "config.targets[0].adapterUrl=http://portal:8080/private"]],
    ["URL query", ["--set-string", "config.targets[0].adapterUrl=http://portal:8080?token=hidden"]],
    ["URL fragment", ["--set-string", "config.targets[0].adapterUrl=http://portal:8080#hidden"]],
    ["public service", ["--set-string", "service.type=LoadBalancer"]],
    ["invalid service port", ["--set", "service.port=0"]],
    ["service extension", ["--set", "service.nodePort=30080"]],
    ["pull-secret extension", ["--set-json", "imagePullSecrets=[{\"name\":\"registry\",\"namespace\":\"other\"}]"]],
    ["pull-secret DNS segment too long", ["--set-json", `imagePullSecrets=[{"name":"${segment64}.internal"}]`]],
    ["annotation DNS segment too long", ["-f", "-"]],
    ["annotation DNS prefix too long", ["-f", "-"]],
    ["annotation name too long", ["-f", "-"]],
    ["resource extension", ["--set-string", "resources.limits.ephemeral-storage=1Gi"]],
    ["toleration extension", ["--set-json", "tolerations=[{\"operator\":\"Exists\",\"secret\":\"hidden\"}]"]],
    ["affinity extension", ["--set-json", "affinity={\"hostPath\":{}}"]],
  ];
  for (const [label, extraArgs] of invalidCases) {
    const input = label === "annotation DNS segment too long"
      ? `podAnnotations:\n  ${segment64}.internal/key: value\n`
      : label === "annotation DNS prefix too long"
        ? `podAnnotations:\n  ${prefix254}/key: value\n`
        : label === "annotation name too long"
          ? `podAnnotations:\n  example.internal/${segment64}: value\n`
          : undefined;
    assert.doesNotThrow(() => helm(withStaging(extraArgs), 1, { input }), label);
  }
});

test("production-like names are denied for both the instance and every target", () => {
  for (const name of ["prod", "PRODUCTION", "live", "pp-prod", "prod-eu", "client.production", "live_eu", "sandbox:prod:blue", "non-production"]) {
    helm(withStaging(["--set-string", `config.instance.environment.name=${name}`]), 1);
    helm(withStaging(["--set-string", `config.targets[0].expectedEnvironment.name=${name}`]), 1);
  }
});

test("ingress and NetworkPolicy values reject unsafe shapes even while disabled", () => {
  const invalidCases = [
    ["enabled ingress without class", ["--set", "ingress.enabled=true", "--set-json", "ingress.hosts=[{\"host\":\"gauntlet.staging.internal\",\"paths\":[{\"path\":\"/\",\"pathType\":\"Prefix\"}]}]"]],
    ["enabled ingress without rules", ["--set", "ingress.enabled=true", "--set-string", "ingress.className=alb"]],
    ["non-string ingress annotation", ["--set-json", "ingress.annotations={\"example.test/value\":7}"]],
    ["relative ingress path", ["--set-json", "ingress.hosts=[{\"host\":\"gauntlet.staging.internal\",\"paths\":[{\"path\":\"relative\",\"pathType\":\"Prefix\"}]}]"]],
    ["unsupported ingress path type", ["--set-json", "ingress.hosts=[{\"host\":\"gauntlet.staging.internal\",\"paths\":[{\"path\":\"/\",\"pathType\":\"Regex\"}]}]"]],
    ["ingress host extension", ["--set-json", "ingress.hosts=[{\"host\":\"gauntlet.staging.internal\",\"paths\":[{\"path\":\"/\",\"pathType\":\"Prefix\"}],\"public\":true}]"]],
    ["ingress path extension", ["--set-json", "ingress.hosts=[{\"host\":\"gauntlet.staging.internal\",\"paths\":[{\"path\":\"/\",\"pathType\":\"Prefix\",\"rewrite\":\"/\"}]}]"]],
    ["empty TLS hosts", ["--set-json", "ingress.tls=[{\"hosts\":[]}]"]],
    ["TLS extension", ["--set-json", "ingress.tls=[{\"hosts\":[\"gauntlet.staging.internal\"],\"public\":true}]"]],
    ["ingress extension", ["--set-string", "ingress.public=true"]],
    ["reserved pod label", ["--set-json", "podLabels={\"app.kubernetes.io/name\":\"replaced\"}"]],
    ["reserved checksum annotation", ["--set-json", "podAnnotations={\"checksum/config\":\"replaced\"}"]],
    ["empty DNS selector", ["--set-json", "networkPolicy.dns.podSelector.matchLabels=null"]],
    ["mutable namespace selector", ["--set-json", "networkPolicy.dns.namespaceSelector.matchLabels={\"team\":\"dns\"}"]],
    ["peer without pod selector", ["--set-json", "networkPolicy.ingressPeers=[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"private-ingress\"}}}]"]],
    ["peer without namespace selector", ["--set-json", "networkPolicy.ingressPeers=[{\"podSelector\":{\"matchLabels\":{\"proxy\":\"enabled\"}}}]"]],
    ["empty peer namespace labels", ["--set-json", "networkPolicy.ingressPeers=[{\"namespaceSelector\":{\"matchLabels\":{}},\"podSelector\":{\"matchLabels\":{\"proxy\":\"enabled\"}}}]"]],
    ["empty peer pod labels", ["--set-json", "networkPolicy.ingressPeers=[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"private-ingress\"}},\"podSelector\":{\"matchLabels\":{}}}]"]],
    ["selector expressions", ["--set-json", "networkPolicy.ingressPeers=[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"private-ingress\"}},\"podSelector\":{\"matchLabels\":{\"proxy\":\"enabled\"},\"matchExpressions\":[]} }]"]],
    ["empty ingress peer", ["--set-json", "networkPolicy.ingressPeers=[{}]"]],
    ["empty egress peers", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[],\"ports\":[{\"protocol\":\"TCP\",\"port\":8080}]}]"]],
    ["empty egress ports", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[]}]"]],
    ["ipBlock peer", ["--set-json", "networkPolicy.ingressPeers=[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"private-ingress\"}},\"podSelector\":{\"matchLabels\":{\"proxy\":\"enabled\"}},\"ipBlock\":{\"cidr\":\"0.0.0.0/0\"}}]"]],
    ["egress ipBlock peer", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}},\"ipBlock\":{\"cidr\":\"0.0.0.0/0\"}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":8080}]}]"]],
    ["unsupported protocol", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"SCTP\",\"port\":8080}]}]"]],
    ["missing port protocol", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"port\":8080}]}]"]],
    ["missing port number", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"TCP\"}]}]"]],
    ["named egress port", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":\"http\"}]}]"]],
    ["fractional egress port", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":8080.5}]}]"]],
    ["zero egress port", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":0}]}]"]],
    ["oversized egress port", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":65536}]}]"]],
    ["egress rule extension", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":8080}],\"except\":[]}]"]],
    ["egress port extension", ["--set-json", "networkPolicy.egressRules=[{\"peers\":[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"adapters\"}},\"podSelector\":{\"matchLabels\":{\"adapter\":\"enabled\"}}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":8080,\"endPort\":8081}]}]"]],
    ["selector extension", ["--set-json", "networkPolicy.ingressPeers=[{\"namespaceSelector\":{\"matchLabels\":{\"kubernetes.io/metadata.name\":\"private-ingress\"},\"secret\":\"hidden\"},\"podSelector\":{\"matchLabels\":{\"proxy\":\"enabled\"}}}]"]],
    ["NetworkPolicy extension", ["--set-string", "networkPolicy.arbitraryManifest=hidden"]],
  ];
  for (const [label, extraArgs] of invalidCases) {
    assert.doesNotThrow(() => helm(withStaging(extraArgs), 1), label);
  }
});
