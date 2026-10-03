import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import {
  helm,
  helmChart,
  parseHelmDocuments,
  render,
  renderNotes,
  stagingValues,
} from "./test-support.mjs";

test("the staging configuration renders as the only ConfigMap payload", () => {
  const resources = render();
  const configMaps = resources.filter(({ kind }) => kind === "ConfigMap");
  assert.equal(configMaps.length, 1);
  const configMap = configMaps[0];
  assert.equal(configMap.apiVersion, "v1");
  assert.equal(configMap.metadata.name, "gauntlet");
  assert.equal(configMap.metadata.namespace, "acme-staging");
  assert.deepEqual(Object.keys(configMap.data), ["config.yaml"]);
  assert.equal(Object.hasOwn(configMap, "binaryData"), false);
  assert.equal(configMap.data["config.yaml"].endsWith("\n"), false);
  assert.deepEqual(parse(configMap.data["config.yaml"]), {
    version: 1,
    instance: {
      name: "acme-staging",
      environment: { name: "staging", kind: "staging" },
    },
    targets: [{
      id: "organizations",
      label: "Organizations staging",
      adapterUrl: "http://organizations.acme-staging.svc.cluster.local:8080",
      expectedEnvironment: { name: "staging", kind: "staging" },
      tags: ["symfony"],
    }],
  });
});

test("configuration rendering rejects duplicate target IDs", () => {
  const input = [
    "config:",
    "  targets:",
    "    - id: duplicate",
    "      label: First",
    "      adapterUrl: http://first:8080",
    "      expectedEnvironment:",
    "        name: staging",
    "        kind: staging",
    "    - id: duplicate",
    "      label: Second",
    "      adapterUrl: http://second:8080",
    "      expectedEnvironment:",
    "        name: staging",
    "        kind: staging",
    "",
  ].join("\n");
  assert.deepEqual(
    render([stagingValues, "-"], [], { input, expectedStatus: 1 }),
    [],
  );
});

test("configuration rendering enforces the 983040-byte cap without leaking values", () => {
  const sentinel = "size-sentinel-884203";
  const targets = Array.from({ length: 128 }, (_, targetIndex) => ({
    id: `target-${targetIndex}`,
    label: targetIndex === 0 ? sentinel : `Target ${targetIndex}`,
    adapterUrl: `http://target-${targetIndex}:8080`,
    expectedEnvironment: { name: "staging", kind: "staging" },
    tags: Array.from({ length: 32 }, (_, tagIndex) => {
      const suffix = `-${targetIndex}-${tagIndex}`;
      return `${"🧪".repeat(128 - suffix.length)}${suffix}`;
    }),
  }));
  const input = stringify({ config: { targets } });
  assert.equal(Buffer.byteLength(input, "utf8") > 983_040, true);

  assert.deepEqual(
    render([stagingValues, "-"], [], { input, expectedStatus: 1 }),
    [],
  );
  assert.throws(
    () => render([stagingValues, "-"], [], { input }),
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

test("the staging render is exactly one hardened single-instance internal workload", () => {
  const resources = render();
  assert.deepEqual(
    resources.map(({ kind }) => kind).sort(),
    ["ConfigMap", "Deployment", "Service"],
  );

  const deployment = resources.find(({ kind }) => kind === "Deployment");
  const selector = {
    "app.kubernetes.io/name": "gauntlet",
    "app.kubernetes.io/instance": "gauntlet",
  };
  assert.equal(deployment.apiVersion, "apps/v1");
  assert.equal(deployment.metadata.name, "gauntlet");
  assert.equal(deployment.metadata.namespace, "acme-staging");
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.revisionHistoryLimit, 2);
  assert.deepEqual(deployment.spec.strategy, { type: "Recreate" });
  assert.deepEqual(deployment.spec.selector, { matchLabels: selector });
  assert.deepEqual(
    Object.fromEntries(Object.entries(deployment.spec.template.metadata.labels)
      .filter(([key]) => key in selector)),
    selector,
  );
  assert.match(deployment.spec.template.metadata.annotations["checksum/config"], /^[0-9a-f]{64}$/);

  const pod = deployment.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.terminationGracePeriodSeconds, 10);
  assert.equal(Object.hasOwn(pod, "serviceAccountName"), false);
  assert.deepEqual(pod.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.equal(pod.containers.length, 1);
  const container = pod.containers[0];
  assert.equal(container.name, "gauntlet");
  assert.equal(container.image, "ghcr.io/8lines/gauntlet:0.1.8");
  assert.equal(container.imagePullPolicy, "IfNotPresent");
  assert.deepEqual(container.ports, [{ name: "http", containerPort: 8080, protocol: "TCP" }]);
  assert.deepEqual(container.env, [
    { name: "GAUNTLET_HOST", value: "0.0.0.0" },
    { name: "GAUNTLET_PORT", value: "8080" },
    { name: "GAUNTLET_CONFIG_FILE", value: "/etc/gauntlet/config.yaml" },
    { name: "GAUNTLET_MCP_ENABLED", value: "false" },
    { name: "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON", value: "[]" },
  ]);
  assert.deepEqual(container.securityContext, {
    allowPrivilegeEscalation: false,
    privileged: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  });
  assert.deepEqual(container.resources, {
    requests: { cpu: "50m", memory: "64Mi" },
    limits: { cpu: "500m", memory: "256Mi" },
  });
  assert.deepEqual(container.volumeMounts, [
    { name: "config", mountPath: "/etc/gauntlet", readOnly: true },
    { name: "tmp", mountPath: "/tmp" },
  ]);
  assert.deepEqual(container.startupProbe, {
    httpGet: { path: "/ready", port: "http", scheme: "HTTP" },
    periodSeconds: 2,
    timeoutSeconds: 1,
    failureThreshold: 30,
    successThreshold: 1,
  });
  assert.deepEqual(container.readinessProbe, {
    httpGet: { path: "/ready", port: "http", scheme: "HTTP" },
    periodSeconds: 5,
    timeoutSeconds: 2,
    failureThreshold: 3,
    successThreshold: 1,
  });
  assert.deepEqual(container.livenessProbe, {
    httpGet: { path: "/health", port: "http", scheme: "HTTP" },
    periodSeconds: 10,
    timeoutSeconds: 2,
    failureThreshold: 3,
    successThreshold: 1,
  });
  assert.deepEqual(pod.volumes, [
    {
      name: "config",
      configMap: {
        name: "gauntlet",
        defaultMode: 292,
        items: [{ key: "config.yaml", path: "config.yaml" }],
      },
    },
    { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
  ]);

  const service = resources.find(({ kind }) => kind === "Service");
  assert.equal(service.apiVersion, "v1");
  assert.equal(service.metadata.name, "gauntlet");
  assert.equal(service.metadata.namespace, "acme-staging");
  assert.deepEqual(service.spec, {
    type: "ClusterIP",
    selector,
    ports: [{ name: "http", port: 8080, targetPort: "http", protocol: "TCP" }],
  });
});

test("safe pod metadata and scheduling render without changing stable selectors", () => {
  const resources = render([stagingValues, "-"], [], {
    input: [
      "podLabels:",
      "  team: quality",
      "imagePullSecrets:",
      "  - name: ghcr-gauntlet",
      "podAnnotations:",
      "  example.internal/owner: test-team",
      "nodeSelector:",
      "  kubernetes.io/os: linux",
      "tolerations:",
      "  - key: dedicated",
      "    operator: Equal",
      "    value: gauntlet",
      "    effect: NoSchedule",
      "affinity:",
      "  podAntiAffinity:",
      "    preferredDuringSchedulingIgnoredDuringExecution: []",
      "",
    ].join("\n"),
  });
  const deployment = resources.find(({ kind }) => kind === "Deployment");
  const service = resources.find(({ kind }) => kind === "Service");
  const stableSelector = {
    "app.kubernetes.io/name": "gauntlet",
    "app.kubernetes.io/instance": "gauntlet",
  };
  assert.deepEqual(deployment.spec.selector.matchLabels, stableSelector);
  assert.deepEqual(service.spec.selector, stableSelector);
  assert.equal(Object.hasOwn(deployment.metadata.labels, "team"), false);
  assert.equal(Object.hasOwn(service.metadata.labels, "team"), false);
  assert.equal(deployment.spec.template.metadata.labels.team, "quality");
  assert.equal(
    deployment.spec.template.metadata.annotations["example.internal/owner"],
    "test-team",
  );
  assert.match(deployment.spec.template.metadata.annotations["checksum/config"], /^[0-9a-f]{64}$/);
  assert.deepEqual(deployment.spec.template.spec.nodeSelector, { "kubernetes.io/os": "linux" });
  assert.deepEqual(deployment.spec.template.spec.imagePullSecrets, [{ name: "ghcr-gauntlet" }]);
  assert.deepEqual(deployment.spec.template.spec.tolerations, [{
    key: "dedicated",
    operator: "Equal",
    value: "gauntlet",
    effect: "NoSchedule",
  }]);
  assert.deepEqual(deployment.spec.template.spec.affinity, {
    podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [] },
  });
});

test("the Pod checksum follows the full ConfigMap and ignores Service-only changes", () => {
  const checksum = (resources) => resources
    .find(({ kind }) => kind === "Deployment")
    .spec.template.metadata.annotations["checksum/config"];
  const baseline = checksum(render());
  const configurationChanged = checksum(render(
    undefined,
    ["--set-string", "config.instance.name=acme-staging-renamed"],
  ));
  const serviceResources = render(undefined, ["--set", "service.port=9090"]);
  const serviceChanged = checksum(serviceResources);

  assert.notEqual(configurationChanged, baseline);
  assert.equal(serviceChanged, baseline);
  assert.equal(
    serviceResources.find(({ kind }) => kind === "Service").spec.ports[0].port,
    9090,
  );
});

test("Helm 4 dry-run NOTES expose only the internal unauthenticated endpoint warning", () => {
  const notes = renderNotes();
  assert.match(notes, /gauntlet\.acme-staging\.svc\.cluster\.local:8080/);
  assert.match(notes, /non-production/i);
  assert.match(notes, /private network/i);
  assert.match(notes, /authentication is not included/i);
  assert.match(notes, /public exposure is unsupported/i);
  for (const forbidden of [
    "organizations",
    "Organizations staging",
    "http://organizations.acme-staging.svc.cluster.local:8080",
  ]) assert.equal(notes.includes(forbidden), false);
});

test("YAML-like legal namespace labels remain strings on every namespaced resource", () => {
  for (const namespace of ["true", "false", "null"]) {
    const resources = parseHelmDocuments(helm([
      "template",
      "gauntlet",
      helmChart,
      "--namespace",
      namespace,
      "--kube-version",
      "1.35.0",
      "-f",
      stagingValues,
    ]));
    assert.equal(resources.length, 3);
    for (const resource of resources) assert.equal(resource.metadata.namespace, namespace);
  }
});

test("small multibyte and template-like configuration stays literal with case-sensitive IDs", () => {
  const firstLabel = "Łódź 🧪 {{ malicious }}";
  const input = stringify({
    config: {
      targets: [
        {
          id: "Portal",
          label: firstLabel,
          adapterUrl: "http://portal-one:8080",
          expectedEnvironment: { name: "staging", kind: "staging" },
          tags: ["wielojęzyczny"],
        },
        {
          id: "portal",
          label: "lowercase portal",
          adapterUrl: "http://portal-two:8080",
          expectedEnvironment: { name: "staging", kind: "staging" },
        },
      ],
    },
  });
  const resources = render([stagingValues, "-"], [], { input });
  const configuration = parse(resources
    .find(({ kind }) => kind === "ConfigMap")
    .data["config.yaml"]);
  assert.equal(configuration.targets.length, 2);
  assert.equal(configuration.targets[0].label, firstLabel);
  assert.equal(configuration.targets[0].tags[0], "wielojęzyczny");
  assert.deepEqual(configuration.targets.map(({ id }) => id), ["Portal", "portal"]);
});

test("reserved Pod labels and checksum annotations fail without leaking their values", () => {
  const sentinel = "reserved-metadata-sentinel-561230";
  const collisions = [
    ...[
      "app.kubernetes.io/name",
      "app.kubernetes.io/instance",
      "app.kubernetes.io/version",
      "app.kubernetes.io/component",
      "app.kubernetes.io/part-of",
      "app.kubernetes.io/managed-by",
      "helm.sh/chart",
    ].map((key) => ["--set-json", `podLabels={"${key}":"${sentinel}"}`]),
    ["--set-json", `podAnnotations={"checksum/config":"${sentinel}"}`],
  ];
  for (const [flag, value] of collisions) {
    assert.deepEqual(render(undefined, [flag, value], { expectedStatus: 1 }), []);
  }
  for (const [flag, value] of [collisions[0], collisions.at(-1)]) {
    assert.throws(
      () => render(undefined, [flag, value]),
      (error) => {
        assert.equal(error.message.includes(sentinel), false);
        assert.equal(error.message.startsWith("Pinned Helm command failed"), true);
        return true;
      },
    );
  }
});

function assertExactKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertClosedHardenedSurface(resources) {
  assert.deepEqual(resources.map(({ kind }) => kind).sort(), ["ConfigMap", "Deployment", "Service"]);
  const labels = {
    "helm.sh/chart": "gauntlet-0.1.8",
    "app.kubernetes.io/name": "gauntlet",
    "app.kubernetes.io/instance": "gauntlet",
    "app.kubernetes.io/version": "0.1.8",
    "app.kubernetes.io/component": "control-plane",
    "app.kubernetes.io/part-of": "gauntlet",
    "app.kubernetes.io/managed-by": "Helm",
  };
  const selector = {
    "app.kubernetes.io/name": "gauntlet",
    "app.kubernetes.io/instance": "gauntlet",
  };
  const configMap = resources.find(({ kind }) => kind === "ConfigMap");
  assertExactKeys(configMap, ["apiVersion", "data", "kind", "metadata"]);
  assertExactKeys(configMap.metadata, ["labels", "name", "namespace"]);
  assert.deepEqual(configMap.metadata.labels, labels);
  assertExactKeys(configMap.data, ["config.yaml"]);
  assert.equal(typeof configMap.data["config.yaml"], "string");
  assert.equal(Buffer.byteLength(configMap.data["config.yaml"], "utf8") <= 983_040, true);
  assert.equal(Object.hasOwn(configMap, "immutable"), false);
  assert.equal(Object.hasOwn(configMap, "binaryData"), false);
  const deployment = resources.find(({ kind }) => kind === "Deployment");
  assertExactKeys(deployment, ["apiVersion", "kind", "metadata", "spec"]);
  assertExactKeys(deployment.metadata, ["labels", "name", "namespace"]);
  assert.deepEqual(deployment.metadata.labels, labels);
  assertExactKeys(deployment.spec, ["replicas", "revisionHistoryLimit", "selector", "strategy", "template"]);
  assertExactKeys(deployment.spec.template, ["metadata", "spec"]);
  assertExactKeys(deployment.spec.template.metadata, ["annotations", "labels"]);
  assert.deepEqual(deployment.spec.template.metadata.labels, labels);
  assertExactKeys(deployment.spec.template.metadata.annotations, ["checksum/config"]);
  assert.deepEqual(deployment.spec.selector, { matchLabels: selector });
  const pod = deployment.spec.template.spec;
  assertExactKeys(pod, [
    "automountServiceAccountToken",
    "containers",
    "enableServiceLinks",
    "securityContext",
    "terminationGracePeriodSeconds",
    "volumes",
  ]);
  const container = pod.containers[0];
  assertExactKeys(container, [
    "env",
    "image",
    "imagePullPolicy",
    "livenessProbe",
    "name",
    "ports",
    "readinessProbe",
    "resources",
    "securityContext",
    "startupProbe",
    "volumeMounts",
  ]);
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(pod.containers.length, 1);
  assert.equal(Object.hasOwn(pod, "initContainers"), false);
  assert.equal(Object.hasOwn(pod, "ephemeralContainers"), false);
  for (const field of [
    "hostNetwork",
    "hostPID",
    "hostIPC",
    "shareProcessNamespace",
    "serviceAccount",
    "serviceAccountName",
  ]) assert.equal(Object.hasOwn(pod, field), false);
  assert.deepEqual(pod.volumes.map((volume) => Object.keys(volume).sort()), [
    ["configMap", "name"],
    ["emptyDir", "name"],
  ]);
  assert.equal(container.securityContext.privileged, false);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.runAsNonRoot, true);
  assert.deepEqual(container.securityContext.capabilities, { drop: ["ALL"] });
  for (const field of ["args", "command", "envFrom"])
    assert.equal(Object.hasOwn(container, field), false);
  assert.equal(Object.hasOwn(container.ports[0], "hostPort"), false);
  assert.deepEqual(container.env.map(({ name }) => name), [
    "GAUNTLET_HOST",
    "GAUNTLET_PORT",
    "GAUNTLET_CONFIG_FILE",
    "GAUNTLET_MCP_ENABLED",
    "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON",
  ]);
  assert.deepEqual(
    [container.startupProbe.httpGet.path, container.readinessProbe.httpGet.path, container.livenessProbe.httpGet.path],
    ["/ready", "/ready", "/health"],
  );
  for (const probe of [container.startupProbe, container.readinessProbe, container.livenessProbe]) {
    assertExactKeys(probe, [
      "failureThreshold",
      "httpGet",
      "periodSeconds",
      "successThreshold",
      "timeoutSeconds",
    ]);
    assertExactKeys(probe.httpGet, ["path", "port", "scheme"]);
  }
  const service = resources.find(({ kind }) => kind === "Service");
  assertExactKeys(service, ["apiVersion", "kind", "metadata", "spec"]);
  assertExactKeys(service.metadata, ["labels", "name", "namespace"]);
  assert.deepEqual(service.metadata.labels, labels);
  assertExactKeys(service.spec, ["ports", "selector", "type"]);
  assert.deepEqual(service.spec.selector, selector);
  assertExactKeys(service.spec.ports[0], ["name", "port", "protocol", "targetPort"]);
  assert.equal(service.spec.type, "ClusterIP");
  assert.equal(service.spec.ports.length, 1);
  for (const field of ["externalIPs", "externalName", "loadBalancerIP", "loadBalancerClass"]) {
    assert.equal(Object.hasOwn(service.spec, field), false);
  }
}

test("the rendered-safety assertions reject unsafe manifest mutations", () => {
  const baseline = render();
  assert.doesNotThrow(() => assertClosedHardenedSurface(baseline));
  const mutationCases = [
    ["extra Secret", (resources) => resources.push({ apiVersion: "v1", kind: "Secret", metadata: { name: "bad" } })],
    ["second container", (resources) => resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers.push({ name: "sidecar" })],
    ["init container", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.initContainers = [{ name: "init" }]; }],
    ["ephemeral container", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.ephemeralContainers = [{ name: "debug" }]; }],
    ["host network", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.hostNetwork = true; }],
    ["shared process namespace", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.shareProcessNamespace = true; }],
    ["service account", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.serviceAccountName = "default"; }],
    ["host path", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.volumes[0] = { name: "host", hostPath: { path: "/" } }; }],
    ["credential volume", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.volumes[0] = { name: "credentials", secret: { secretName: "bad" } }; }],
    ["privileged", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].securityContext.privileged = true; }],
    ["added capability", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].securityContext.capabilities.add = ["NET_ADMIN"]; }],
    ["host port", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].ports[0].hostPort = 8080; }],
    ["extra env", (resources) => resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].env.push({ name: "TOKEN", value: "bad" })],
    ["envFrom", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].envFrom = [{ secretRef: { name: "bad" } }]; }],
    ["command", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].command = ["sh"]; }],
    ["args", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].args = ["-c", "bad"]; }],
    ["wrong readiness", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].readinessProbe.httpGet.path = "/health"; }],
    ["public Service", (resources) => { resources.find(({ kind }) => kind === "Service").spec.type = "LoadBalancer"; }],
    ["second Service port", (resources) => resources.find(({ kind }) => kind === "Service").spec.ports.push({ port: 80 })],
    ["immutable ConfigMap", (resources) => { resources.find(({ kind }) => kind === "ConfigMap").immutable = true; }],
    ["binary ConfigMap", (resources) => { resources.find(({ kind }) => kind === "ConfigMap").binaryData = { secret: "bad" }; }],
    ["extra ConfigMap key", (resources) => { resources.find(({ kind }) => kind === "ConfigMap").data.extra = "bad"; }],
    ["unknown container field", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].stdin = true; }],
    ["unknown Pod field", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.template.spec.dnsPolicy = "Default"; }],
    ["unknown Deployment field", (resources) => { resources.find(({ kind }) => kind === "Deployment").spec.paused = true; }],
  ];
  for (const [label, mutate] of mutationCases) {
    const resources = structuredClone(baseline);
    mutate(resources);
    assert.throws(() => assertClosedHardenedSurface(resources), label);
  }
});

test("chart sources keep one bounded value-free configuration path and exact checksum", async () => {
  const templateDirectory = new URL("gauntlet/templates/", import.meta.url);
  const names = (await readdir(templateDirectory)).sort();
  const sources = Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    await readFile(new URL(name, templateDirectory), "utf8"),
  ])));
  const allTemplates = Object.values(sources).join("\n");
  assert.equal((allTemplates.match(/toYaml \.Values\.config/g) ?? []).length, 1);
  assert.match(
    sources["_configuration.tpl"],
    /\$configuration := toYaml \.Values\.config \| trimSuffix "\\n"/,
  );
  assert.match(
    sources["_configuration.tpl"],
    /if gt \(len \$configuration\) 983040/,
  );
  assert.deepEqual(
    sources["_configuration.tpl"].match(/fail "[^"]+"/g),
    [
      'fail "Gauntlet configuration contains duplicate target IDs"',
      'fail "Gauntlet configuration exceeds the 983040-byte chart limit"',
    ],
  );
  assert.equal(
    sources["_configuration.tpl"].indexOf("duplicate target IDs")
      < sources["_configuration.tpl"].indexOf("toYaml .Values.config"),
    true,
  );
  for (const [name, source] of Object.entries(sources)) {
    if (name !== "_configuration.tpl") assert.doesNotMatch(source, /\.Values\.config/);
  }
  assert.equal(
    (sources["configmap.yaml"].match(/include "gauntlet\.configuration"/g) ?? []).length,
    1,
  );
  assert.equal(sources["configmap.yaml"].includes("config.yaml: |-"), true);
  assert.equal((sources["_configuration.tpl"].match(/len \$configuration/g) ?? []).length, 1);
  assert.equal((sources["_configuration.tpl"].match(/983040/g) ?? []).length, 2);
  assert.doesNotMatch(sources["NOTES.txt"], /\.Values\.config|adapterUrl|publicUrl|targets/);
  assert.equal(
    sources["deployment.yaml"].includes(
      'checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum | quote }}',
    ),
    true,
  );
  for (const name of ["configmap.yaml", "deployment.yaml", "service.yaml"]) {
    assert.equal(sources[name].includes("namespace: {{ .Release.Namespace | quote }}"), true, name);
  }
  assert.doesNotMatch(
    allTemplates,
    /{{-?\s*(?:tpl|lookup|getHostByName|rand[A-Za-z0-9]*|env|expandenv)\b|\.Files\b/,
  );
});

test("MCP settings render only explicit endpoint settings and reject malformed values", () => {
  const resources = render([stagingValues, "-"], [], { input: stringify({
    mcp: { enabled: true, allowedOrigins: ["https://ai.internal.example"] },
  }) });
  const env = resources.find(({ kind }) => kind === "Deployment").spec.template.spec.containers[0].env;
  assert.equal(env.find(({ name }) => name === "GAUNTLET_MCP_ENABLED").value, "true");
  assert.equal(env.find(({ name }) => name === "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON").value, '["https://ai.internal.example"]');
  for (const mcp of [
    { enabled: "true" },
    { allowedOrigins: ["*"] },
    { allowedOrigins: ["https://user:password@example.test"] },
    { allowedOrigins: ["https://example.test/path"] },
    { unexpected: true },
  ]) {
    assert.deepEqual(render([stagingValues, "-"], [], { input: stringify({ mcp }), expectedStatus: 1 }), []);
  }
});
