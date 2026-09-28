# Secure Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static Kubernetes example with a linted, schema-validated OCI Helm chart that deploys one hardened Gauntlet instance to an explicit non-production environment and supports optional private ingress and cross-namespace adapter networking.

**Architecture:** Helm values embed the same version 1 control-plane configuration that standalone Compose uses, and the chart renders it into a checksummed ConfigMap mounted at `/etc/gauntlet/config.yaml`. The workload is fixed to one replica, `ClusterIP`, no service-account token, no RBAC, and no ingress or NetworkPolicy by default; optional templates consume explicit private ingress and peer/port rules without discovering cluster resources.

**Tech Stack:** Helm 4-compatible chart API v2, Kubernetes `apps/v1`, `v1`, and `networking.k8s.io/v1` resources, JSON Schema values validation, OCI chart packaging, Node.js 24 manifest verification.

**Spec:** `docs/superpowers/specs/2026-09-02-release-standalone-safety-skills-design.md`

## Global Constraints

- The chart is an application chart named `gauntlet`; chart and application version start at exactly `0.1.0` and are synchronized by the release plan.
- `replicaCount` is exactly `1`; rolling overlap and multiple in-memory control planes are unsupported.
- The Service type is exactly `ClusterIP`; public exposure is never a default.
- Ingress and NetworkPolicy are disabled by default and require explicit values.
- The chart creates no ServiceAccount, Role, RoleBinding, ClusterRole, or ClusterRoleBinding, and sets `automountServiceAccountToken: false` on the Pod.
- The Pod and container are non-root, use runtime-default seccomp, a read-only root filesystem, no privilege escalation, and drop every Linux capability.
- `EnvironmentDescriptor` safety is enforced by the server and SDK implementation; chart schema admits only `development`, `test`, `qa`, `staging`, `uat`, `preview`, and `sandbox` and has no bypass value.
- Every target has an exact `expectedEnvironment`; the chart performs no Docker, namespace, Service, or Kubernetes API discovery.
- The default image is exactly `ghcr.io/8lines/gauntlet:0.1.0`; operators may replace the tag with an immutable `sha256` digest, while `latest` and non-semantic tags are rejected.
- Liveness uses `/health`; startup and readiness use `/ready`; target health never restarts the control plane.
- Configuration changes alter a Pod template checksum and restart the one replica automatically.
- Authentication remains outside v0.1; every enabled ingress example is private and documentation warns against public exposure.
- No PodDisruptionBudget is created for the single-replica process; maintenance and `Recreate` updates have explicit short downtime.

---

### Task 1: Chart Metadata and Fail-Closed Values Schema

**Files:**
- Create: `deploy/helm/gauntlet/Chart.yaml`
- Create: `deploy/helm/gauntlet/values.yaml`
- Create: `deploy/helm/gauntlet/values.schema.json`
- Create: `deploy/helm/gauntlet/.helmignore`
- Create: `deploy/helm/gauntlet/templates/_helpers.tpl`
- Create: `deploy/helm/ci/staging-values.yaml`
- Create: `deploy/helm/test-values-schema.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the `GauntletConfigurationV1` shape from `config/gauntlet-config-v1.schema.json` and the product image coordinates `ghcr.io/8lines/gauntlet`.
- Produces: chart name `gauntlet`, chart version `0.1.0`, app version `0.1.0`, and helper names `gauntlet.name`, `gauntlet.fullname`, `gauntlet.labels`, `gauntlet.selectorLabels`, and `gauntlet.image`.
- Produces: immediately usable immutable image defaults `repository: ghcr.io/8lines/gauntlet`, `tag: 0.1.0`, and empty `digest`; release version tooling later keeps the tag synchronized with `VERSION`.
- Produces: root script `test:helm` invoking `node deploy/helm/test-values-schema.mjs`.
- Produces: exact root development dependency `yaml@2.8.1` for offline rendered-manifest verification in later tasks.

- [ ] **Step 1: Write a failing values-validation runner**

```js
// deploy/helm/test-values-schema.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const chart = "deploy/helm/gauntlet";
const values = "deploy/helm/ci/staging-values.yaml";

function helm(args, expectedStatus) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

helm(["lint", chart, "-f", values], 0);
helm(["template", "gauntlet", chart, "-f", values], 0);
helm(["template", "gauntlet", chart, "-f", values,
  "--set", "config.instance.environment.kind=production"], 1);
helm(["template", "gauntlet", chart, "-f", values,
  "--set", "replicaCount=2"], 1);
helm(["template", "gauntlet", chart, "-f", values,
  "--set", "image.tag=latest"], 1);
helm(["template", "gauntlet", chart, "-f", values,
  "--set-string", "image.tag=edge"], 1);
helm(["template", "gauntlet", chart, "-f", values,
  "--set-json", "config.targets=[]"], 1);
```

- [ ] **Step 2: Run the schema runner and confirm RED**

Run: `node deploy/helm/test-values-schema.mjs`

Expected: FAIL because the chart does not exist.

- [ ] **Step 3: Create exact chart metadata and helper names**

```yaml
# deploy/helm/gauntlet/Chart.yaml
apiVersion: v2
name: gauntlet
description: Private non-production Gauntlet control plane and dashboard
type: application
version: 0.1.0
appVersion: "0.1.0"
kubeVersion: ">=1.29.0-0"
```

`_helpers.tpl` truncates DNS names to 63 characters, emits standard `app.kubernetes.io/name`, `instance`, `version`, `component`, `part-of`, and `managed-by` labels, and renders `repository@digest` when `image.digest` is nonempty or `repository:tag` otherwise.

- [ ] **Step 4: Create safe but intentionally incomplete defaults**

```yaml
# deploy/helm/gauntlet/values.yaml
replicaCount: 1

image:
  repository: ghcr.io/8lines/gauntlet
  tag: "0.1.0"
  digest: ""
  pullPolicy: IfNotPresent
imagePullSecrets: []

config:
  version: 1
  instance:
    name: ""
    environment:
      name: ""
      kind: ""
  targets: []

service:
  type: ClusterIP
  port: 8080

ingress:
  enabled: false
  className: ""
  annotations: {}
  hosts: []
  tls: []

networkPolicy:
  enabled: false
  dns:
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
    podSelector:
      matchLabels:
        k8s-app: kube-dns
  ingressPeers: []
  egressRules: []

resources:
  requests: { cpu: 50m, memory: 64Mi }
  limits: { cpu: 500m, memory: 256Mi }

podAnnotations: {}
podLabels: {}
nodeSelector: {}
tolerations: []
affinity: {}
```

The image coordinate is deployable and immutable from the first chart commit. The otherwise safe defaults cannot render an installable release until an operator supplies the instance environment and at least one target; this is the intended fail-closed behavior.

- [ ] **Step 5: Define the closed values schema**

Use JSON Schema draft-07 because Helm validates `values.schema.json` with that vocabulary. Keep all references local under `definitions`; do not use `$defs`, remote references, regex lookarounds, or format checks that can vary between Helm builds. The root begins with `$schema`, closes all top-level properties, and enforces:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["replicaCount", "image", "config", "service", "ingress", "networkPolicy", "resources"],
  "properties": {
    "replicaCount": { "const": 1 },
    "image": {
      "type": "object",
      "required": ["repository", "tag", "digest", "pullPolicy"],
      "properties": {
        "repository": { "const": "ghcr.io/8lines/gauntlet" },
        "tag": {
          "type": "string",
          "pattern": "^(?:[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)?$",
          "not": { "const": "latest" }
        },
        "digest": { "type": "string", "pattern": "^(?:sha256:[A-Fa-f0-9]{64})?$" },
        "pullPolicy": { "enum": ["IfNotPresent", "Always"] }
      },
      "oneOf": [
        {
          "properties": {
            "tag": { "minLength": 1 },
            "digest": { "const": "" }
          }
        },
        {
          "properties": {
            "tag": { "const": "" },
            "digest": { "pattern": "^sha256:[A-Fa-f0-9]{64}$" }
          }
        }
      ],
      "additionalProperties": false
    },
    "config": {
      "type": "object",
      "required": ["version", "instance", "targets"],
      "properties": {
        "version": { "const": 1 },
        "instance": { "$ref": "#/definitions/instance" },
        "targets": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/definitions/target" }
        }
      },
      "additionalProperties": false
    },
    "service": {
      "type": "object",
      "required": ["type", "port"],
      "properties": {
        "type": { "const": "ClusterIP" },
        "port": { "type": "integer", "minimum": 1, "maximum": 65535 }
      },
      "additionalProperties": false
    }
  }
}
```

The full file also closes and validates `imagePullSecrets`, ingress, NetworkPolicy including its explicit DNS selectors, resources, and scheduling values. Its local `definitions` reproduce the same environment, origin, ID, and target constraints as `config/gauntlet-config-v1.schema.json`; the schema test deep-compares those four fragments so they cannot drift. The chart must validate offline.

- [ ] **Step 6: Add one complete staging fixture**

```yaml
# deploy/helm/ci/staging-values.yaml
config:
  instance:
    name: acme-staging
    environment:
      name: staging
      kind: staging
  targets:
    - id: organizations
      label: Organizations staging
      adapterUrl: http://organizations.acme-staging.svc.cluster.local:8080
      expectedEnvironment:
        name: staging
        kind: staging
      tags: [symfony]
```

- [ ] **Step 7: Add the root command and exact YAML dependency**

```json
{
  "scripts": {
    "test:helm": "node deploy/helm/test-values-schema.mjs"
  },
  "devDependencies": {
    "yaml": "2.8.1"
  }
}
```

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` records `yaml` as an exact root development dependency without changing unrelated versions.

- [ ] **Step 8: Run values validation to confirm GREEN**

Run: `pnpm test:helm`

Expected: PASS for the valid fixture using the chart's default `0.1.0` image tag and expected nonzero exits for production, two replicas, `latest`, non-semantic `edge`, and empty targets.

- [ ] **Step 9: Commit chart metadata and schema**

```bash
git add deploy/helm/gauntlet deploy/helm/ci deploy/helm/test-values-schema.mjs package.json pnpm-lock.yaml
git commit -m "feat(helm): define fail-closed chart values"
```

### Task 2: Hardened Workload, Checksummed Configuration, and Probes

**Files:**
- Create: `deploy/helm/gauntlet/templates/configmap.yaml`
- Create: `deploy/helm/gauntlet/templates/deployment.yaml`
- Create: `deploy/helm/gauntlet/templates/service.yaml`
- Create: `deploy/helm/gauntlet/templates/NOTES.txt`
- Create: `deploy/helm/test-support.mjs`
- Create: `deploy/helm/test-rendered-manifests.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: helper templates and validated values from Task 1.
- Produces: `helm(args, expectedStatus?)` and `render(valuesFiles?, extraArgs?)` from `deploy/helm/test-support.mjs` as the single subprocess/YAML parsing boundary for chart tests.
- Produces: one ConfigMap key `config.yaml`, one `apps/v1` Deployment, and one `ClusterIP` Service.
- Produces: Pod annotation `checksum/config` computed from the rendered ConfigMap.
- Produces: root script `test:helm:rendered` invoking `node deploy/helm/test-rendered-manifests.mjs`.

- [ ] **Step 1: Write a failing rendered-resource verifier**

```js
// deploy/helm/test-support.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

export const stagingValues = "deploy/helm/ci/staging-values.yaml";

export function helm(args, expectedStatus = 0) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

export function render(valuesFiles = [stagingValues], extraArgs = []) {
  const args = [
    "template", "gauntlet", "deploy/helm/gauntlet",
    "--namespace", "acme-staging",
  ];
  for (const valuesFile of valuesFiles) args.push("-f", valuesFile);
  args.push(...extraArgs);
  return parseAllDocuments(helm(args))
    .map((document) => document.toJS())
    .filter((resource) => resource !== null);
}
```

```js
// deploy/helm/test-rendered-manifests.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "./test-support.mjs";

test("default rendered resources are one hardened Deployment, ConfigMap, and ClusterIP Service", () => {
  const resources = render();
  assert.deepEqual(resources.map(({ kind }) => kind).sort(), ["ConfigMap", "Deployment", "Service"]);
  const deployment = resources.find(({ kind }) => kind === "Deployment");
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  const pod = deployment.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault");
  const container = pod.containers[0];
  assert.equal(container.image, "ghcr.io/8lines/gauntlet:0.1.0");
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(container.livenessProbe.httpGet.path, "/health");
  assert.equal(container.readinessProbe.httpGet.path, "/ready");
});
```

- [ ] **Step 2: Run the verifier and confirm RED**

Run: `node --test deploy/helm/test-rendered-manifests.mjs`

Expected: FAIL because no resource templates exist.

- [ ] **Step 3: Render the v1 configuration as a ConfigMap**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "gauntlet.fullname" . }}
  labels:
    {{- include "gauntlet.labels" . | nindent 4 }}
data:
  config.yaml: |
    {{- toYaml .Values.config | nindent 4 }}
```

- [ ] **Step 4: Create one hardened Recreate Deployment**

The Deployment includes this exact Pod/container security and configuration shape:

```yaml
spec:
  replicas: 1
  strategy:
    type: Recreate
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 10
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: gauntlet
          image: {{ include "gauntlet.image" . | quote }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          env:
            - name: GAUNTLET_HOST
              value: "0.0.0.0"
            - name: GAUNTLET_PORT
              value: "8080"
            - name: GAUNTLET_CONFIG_FILE
              value: /etc/gauntlet/config.yaml
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: config
              mountPath: /etc/gauntlet
              readOnly: true
            - name: tmp
              mountPath: /tmp
          livenessProbe:
            httpGet: { path: /health, port: http }
          readinessProbe:
            httpGet: { path: /ready, port: http }
          startupProbe:
            httpGet: { path: /ready, port: http }
      volumes:
        - name: config
          configMap:
            name: {{ include "gauntlet.fullname" . }}
        - name: tmp
          emptyDir:
            medium: Memory
            sizeLimit: 16Mi
```

Include the named container port `http: 8080`, validated resources, image pull secrets, and scheduling values. Do not set `serviceAccountName`; the disabled token mount is the effective API credential boundary.

- [ ] **Step 5: Render only a ClusterIP Service and a safety note**

The Service selects only `gauntlet.selectorLabels`, uses `.Values.service.port`, and targets named port `http`. `NOTES.txt` prints the internal Service DNS and states that authentication is absent and public exposure is unsupported; it does not print adapter origins.

- [ ] **Step 6: Test checksum sensitivity and forbidden Kubernetes resources**

Extend the verifier to render once with the staging fixture and once with `--set config.instance.name=acme-staging-renamed`, then assert different `checksum/config` values. Assert no rendered kind matches `ServiceAccount`, `Role`, `RoleBinding`, `ClusterRole`, `ClusterRoleBinding`, or `PodDisruptionBudget`. Assert no container has a privileged flag, writable root, host namespace, hostPath, or added capability.

- [ ] **Step 7: Run lint and rendered-resource tests to confirm GREEN**

Run: `pnpm test:helm`

Expected: PASS.

Run: `node --test deploy/helm/test-rendered-manifests.mjs`

Expected: PASS with exactly ConfigMap, Deployment, and Service in the default valid render.

- [ ] **Step 8: Commit the hardened workload**

```bash
git add deploy/helm/gauntlet/templates deploy/helm/test-support.mjs \
  deploy/helm/test-rendered-manifests.mjs package.json
git commit -m "feat(helm): render a hardened single-instance workload"
```

### Task 3: Optional Private Ingress

**Files:**
- Create: `deploy/helm/gauntlet/templates/ingress.yaml`
- Create: `deploy/helm/examples/private-alb-values.yaml`
- Create: `deploy/helm/examples/tailscale-values.yaml`
- Create: `deploy/helm/test-private-ingress.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `.Values.ingress.enabled`, `className`, string annotations, hosts, paths, and TLS values validated in Task 1.
- Produces: no Ingress for default values.
- Produces: `networking.k8s.io/v1` Ingress for explicitly enabled private controller values.
- Produces: root script `test:helm:ingress` invoking `node --test deploy/helm/test-private-ingress.mjs`.

- [ ] **Step 1: Write failing private-ingress tests**

```js
// deploy/helm/test-private-ingress.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { render, stagingValues } from "./test-support.mjs";

test("default values render no Ingress", () => {
  assert.equal(render().some(({ kind }) => kind === "Ingress"), false);
});

test("the ALB example is internal and CIDR-bounded", () => {
  const ingress = render([stagingValues, "deploy/helm/examples/private-alb-values.yaml"])
    .find(({ kind }) => kind === "Ingress");
  assert.equal(ingress.spec.ingressClassName, "alb");
  assert.equal(ingress.metadata.annotations["alb.ingress.kubernetes.io/scheme"], "internal");
  assert.equal(ingress.metadata.annotations["alb.ingress.kubernetes.io/inbound-cidrs"], "10.0.0.0/8");
});

test("the Tailscale example is tailnet-only and does not enable Funnel", () => {
  const ingress = render([stagingValues, "deploy/helm/examples/tailscale-values.yaml"])
    .find(({ kind }) => kind === "Ingress");
  assert.equal(ingress.spec.ingressClassName, "tailscale");
  assert.equal("tailscale.com/funnel" in ingress.metadata.annotations, false);
});
```

- [ ] **Step 2: Run ingress tests and confirm RED**

Run: `node --test deploy/helm/test-private-ingress.mjs`

Expected: FAIL because the ingress template and examples do not exist.

- [ ] **Step 3: Implement the generic optional Ingress template**

Render only when `ingress.enabled`. Each host has one or more paths with `pathType`, all backends point to the chart Service and `.Values.service.port`, and TLS values are rendered only when supplied. Apply only operator-supplied string annotations; the chart adds no public-controller annotation.

- [ ] **Step 4: Add exact private ALB and Tailscale examples**

```yaml
# deploy/helm/examples/private-alb-values.yaml
ingress:
  enabled: true
  className: alb
  annotations:
    alb.ingress.kubernetes.io/scheme: internal
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/inbound-cidrs: 10.0.0.0/8
  hosts:
    - host: gauntlet.staging.internal
      paths:
        - path: /
          pathType: Prefix
```

```yaml
# deploy/helm/examples/tailscale-values.yaml
ingress:
  enabled: true
  className: tailscale
  annotations: {}
  hosts:
    - host: gauntlet
      paths:
        - path: /
          pathType: Prefix
  tls:
    - hosts: [gauntlet]
```

Each example is layered after `deploy/helm/ci/staging-values.yaml` during verification, so it contains only ingress differences. For the Tailscale operator, `gauntlet` is the requested MagicDNS label; the operator assigns the tailnet suffix and the example never enables Funnel.

- [ ] **Step 5: Run ingress and base chart tests to confirm GREEN**

Run: `pnpm test:helm:ingress`

Expected: PASS with private annotations/classes and no Funnel annotation.

Run: `pnpm test:helm`

Expected: PASS.

Run: `pnpm test:helm:rendered`

Expected: PASS; default resources remain unchanged.

- [ ] **Step 6: Commit private ingress support**

```bash
git add deploy/helm/gauntlet/templates/ingress.yaml deploy/helm/examples \
  deploy/helm/test-private-ingress.mjs package.json
git commit -m "feat(helm): add explicit private ingress options"
```

### Task 4: Explicit Cross-Namespace NetworkPolicy

**Files:**
- Create: `deploy/helm/gauntlet/templates/networkpolicy.yaml`
- Create: `deploy/helm/examples/cross-namespace-network-policy-values.yaml`
- Create: `deploy/helm/test-network-policy.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `.Values.networkPolicy.enabled`, `ingressPeers`, and `egressRules`.
- Produces: one NetworkPolicy selecting only Gauntlet Pods, with explicit `Ingress` and `Egress` policy types.
- Produces: DNS TCP/UDP 53 egress and explicit adapter peer/port egress only when NetworkPolicy is enabled.

- [ ] **Step 1: Write failing default-denial and cross-namespace tests**

```js
// deploy/helm/test-network-policy.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { render, stagingValues } from "./test-support.mjs";

const crossNamespaceValues = "deploy/helm/examples/cross-namespace-network-policy-values.yaml";

test("default values render no NetworkPolicy", () => {
  assert.equal(render().some(({ kind }) => kind === "NetworkPolicy"), false);
});

test("cross-namespace example allows only selected ingress, DNS, and adapter ports", () => {
  const policy = render([stagingValues, crossNamespaceValues])
    .find(({ kind }) => kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.equal(JSON.stringify(policy).includes("0.0.0.0/0"), false);
  assert.deepEqual(policy.spec.egress.flatMap(({ ports = [] }) => ports.map(({ port }) => port)).sort(), [53, 53, 8080]);
  assert.equal(policy.spec.egress.some(({ to }) => to?.some(({ namespaceSelector }) =>
    namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "acme-staging")), true);
});
```

- [ ] **Step 2: Run NetworkPolicy tests and confirm RED**

Run: `node --test deploy/helm/test-network-policy.mjs`

Expected: FAIL because the template and example do not exist.

- [ ] **Step 3: Define closed peer and port values**

Extend `values.schema.json` so every ingress peer has optional closed `namespaceSelector.matchLabels` and `podSelector.matchLabels`. Every egress rule requires at least one peer and at least one port; each port has protocol `TCP` or `UDP` and integer `port` from 1 through 65535. Arbitrary YAML fragments and `ipBlock` are not accepted in v0.1.

- [ ] **Step 4: Render DNS plus explicit peers and ports**

When enabled, the template always renders DNS egress using the closed `networkPolicy.dns.namespaceSelector` and `networkPolicy.dns.podSelector` values on UDP/TCP 53, then renders the configured egress rules. Defaults are namespace `kube-system` and pod label `k8s-app: kube-dns`; clusters with different DNS labels override only those two selector maps.

```yaml
# deploy/helm/examples/cross-namespace-network-policy-values.yaml
networkPolicy:
  enabled: true
  ingressPeers:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-private
      podSelector:
        matchLabels:
          app.kubernetes.io/component: controller
  egressRules:
    - peers:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: acme-staging
          podSelector:
            matchLabels:
              gauntlet-adapter: enabled
      ports:
        - protocol: TCP
          port: 8080
```

- [ ] **Step 5: Run NetworkPolicy and complete chart tests to confirm GREEN**

Run: `node --test deploy/helm/test-network-policy.mjs`

Expected: PASS.

Run: `pnpm test:helm`

Expected: PASS.

Run: `pnpm test:helm:rendered`

Expected: PASS.

Run: `pnpm test:helm:ingress`

Expected: PASS.

- [ ] **Step 6: Commit explicit network policy support**

```bash
git add deploy/helm/gauntlet/templates/networkpolicy.yaml \
  deploy/helm/gauntlet/values.schema.json \
  deploy/helm/examples/cross-namespace-network-policy-values.yaml \
  deploy/helm/test-network-policy.mjs package.json
git commit -m "feat(helm): add explicit adapter network policies"
```

### Task 5: Helm Operations Documentation and Kustomize Retirement

**Files:**
- Create: `deploy/helm/README.md`
- Create: `deploy/helm/test-documentation.mjs`
- Delete: `deploy/kubernetes/configmap.yaml`
- Delete: `deploy/kubernetes/deployment.yaml`
- Delete: `deploy/kubernetes/service.yaml`
- Delete: `deploy/kubernetes/network-policy.example.yaml`
- Delete: `deploy/kubernetes/kustomization.yaml`
- Replace: `deploy/kubernetes/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished chart and its private ingress/NetworkPolicy examples.
- Produces: exact registry login, pull, install, configuration update, rollout observation, upgrade, rollback, and uninstall commands.
- Produces: a short legacy-path notice at `deploy/kubernetes/README.md` pointing to the supported chart and containing no applicable Kustomize command.

- [ ] **Step 1: Write a failing documentation contract test**

```js
// deploy/helm/test-documentation.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Helm documentation covers the complete private lifecycle", async () => {
  const readme = await readFile(new URL("README.md", import.meta.url), "utf8");
  for (const required of [
    "helm registry login ghcr.io",
    "helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.1.0",
    "helm upgrade --install",
    "helm rollback",
    "helm uninstall",
    "one replica",
    "Recreate",
    "authentication",
    "private",
    "imagePullSecrets",
    "ghcr.io/8lines/gauntlet:0.1.0",
    "checksum/config",
  ]) assert.equal(readme.includes(required), true, required);
});
```

- [ ] **Step 2: Run the documentation test and confirm RED**

Run: `node --test deploy/helm/test-documentation.mjs`

Expected: FAIL because the Helm operations README does not exist.

- [ ] **Step 3: Write exact install, upgrade, and rollback commands**

```bash
helm registry login ghcr.io
helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.1.0
helm upgrade --install gauntlet oci://ghcr.io/8lines/charts/gauntlet \
  --version 0.1.0 \
  --namespace acme-staging \
  --create-namespace \
  -f values.acme-staging.yaml \
  --wait
helm status gauntlet --namespace acme-staging
helm history gauntlet --namespace acme-staging
helm rollback gauntlet 1 --namespace acme-staging --wait
helm uninstall gauntlet --namespace acme-staging
```

Document that `ghcr.io/8lines/gauntlet:0.1.0` is the immutable chart default, release tooling synchronizes that tag with `VERSION`, and an operator may select an immutable digest instead. Also document `imagePullSecrets`, private ingress choices, NetworkPolicy selector adaptation, target changes through values, automatic checksum rollout, logs, probes, expected Recreate downtime, one-replica/in-memory limitation, and the absence of authentication and production support.

- [ ] **Step 4: Retire the static Kustomize deployment after chart parity**

Delete the five YAML manifests. Replace the old README with:

```md
# Kubernetes deployment

The supported Kubernetes artifact is the OCI Helm chart documented in
`deploy/helm/README.md`. The former static Kustomize example was removed because
it did not validate environment identity or restart automatically after a
configuration change.
```

Update the root directory index so `deploy/helm` is supported and `deploy/kubernetes` is only a migration pointer.

- [ ] **Step 5: Package and verify the chart to confirm GREEN**

Run: `node --test deploy/helm/test-documentation.mjs`

Expected: PASS.

Run: `helm lint deploy/helm/gauntlet -f deploy/helm/ci/staging-values.yaml`

Expected: PASS.

Run: `helm package deploy/helm/gauntlet --destination /tmp/gauntlet-chart`

Expected: creates `/tmp/gauntlet-chart/gauntlet-0.1.0.tgz`.

Run: `pnpm test:helm`

Expected: PASS.

Run: `pnpm test:helm:rendered`

Expected: PASS.

Run: `pnpm test:helm:ingress`

Expected: PASS.

Run: `node --test deploy/helm/test-network-policy.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the supported Kubernetes path**

```bash
git add README.md deploy/helm deploy/kubernetes/README.md
git rm deploy/kubernetes/configmap.yaml deploy/kubernetes/deployment.yaml \
  deploy/kubernetes/service.yaml deploy/kubernetes/network-policy.example.yaml \
  deploy/kubernetes/kustomization.yaml
git commit -m "docs(deploy): document Helm install upgrade and rollback"
```
