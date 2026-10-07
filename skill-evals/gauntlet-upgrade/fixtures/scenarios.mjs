// Synthetic, hermetic upgrade scenarios. Every version, guide, digest, and deployment below is
// invented for the evaluation; none of it describes a real release or a customer deployment.

const DEPLOYED = "0.2.0";

const composeVariables = Object.freeze([
  "GAUNTLET_IMAGE",
  "GAUNTLET_BIND",
  "GAUNTLET_PORT",
  "GAUNTLET_CONFIG_PATH",
  "GAUNTLET_MCP_ENABLED",
  "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON",
  "GAUNTLET_AUTH_SECRET",
]);

const composeRequired = Object.freeze(["GAUNTLET_IMAGE", "GAUNTLET_BIND", "GAUNTLET_CONFIG_PATH"]);

const helmValuesWithoutPersistence = Object.freeze([
  "replicaCount",
  "image",
  "imagePullSecrets",
  "config",
  "service",
  "ingress",
  "networkPolicy",
  "resources",
  "podAnnotations",
  "podLabels",
  "nodeSelector",
  "tolerations",
  "affinity",
]);

const composeEnv = [
  "# Installed Gauntlet Compose environment for acme-staging. Keep this file private (mode 0600).",
  "GAUNTLET_IMAGE=ghcr.io/8lines/gauntlet:0.2.0",
  "GAUNTLET_BIND=127.0.0.1",
  "GAUNTLET_PORT=8080",
  "GAUNTLET_CONFIG_PATH=./config.yaml",
  "GAUNTLET_MCP_ENABLED=false",
  "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON=[]",
  "GAUNTLET_AUTH_SECRET=",
  "",
].join("\n");

const composeConfig = [
  "version: 1",
  "instance:",
  "  name: acme-staging",
  "  environment:",
  "    name: staging",
  "    kind: staging",
  "targets:",
  "  - id: billing",
  "    label: Billing staging",
  "    adapterUrl: http://acme-staging-billing:8080",
  "    expectedEnvironment:",
  "      name: staging",
  "      kind: staging",
  "",
].join("\n");

function helmValues({ persistence }) {
  return [
    "# Complete environment values for the acme-staging Gauntlet release. Not an overlay.",
    "replicaCount: 1",
    "",
    "image:",
    "  repository: ghcr.io/8lines/gauntlet",
    '  tag: "0.2.0"',
    '  digest: ""',
    "  pullPolicy: IfNotPresent",
    "imagePullSecrets: []",
    "",
    "config:",
    "  version: 1",
    "  instance:",
    "    name: acme-staging",
    "    environment:",
    "      name: staging",
    "      kind: staging",
    "  targets:",
    "    - id: organizations",
    "      label: Organizations staging",
    "      adapterUrl: http://organizations.acme-staging.svc.cluster.local:8080",
    "      expectedEnvironment:",
    "        name: staging",
    "        kind: staging",
    "",
    "service:",
    "  type: ClusterIP",
    "  port: 8080",
    "",
    "ingress:",
    "  enabled: false",
    '  className: ""',
    "  annotations: {}",
    "  hosts: []",
    "  tls: []",
    "",
    "networkPolicy:",
    "  enabled: false",
    "  ingressPeers: []",
    "  egressRules: []",
    "",
    "resources:",
    "  requests:",
    '    cpu: "50m"',
    "    memory: 64Mi",
    "  limits:",
    '    cpu: "500m"',
    "    memory: 256Mi",
    "",
    ...(persistence ? [
      "persistence:",
      "  enabled: true",
      "  size: 1Gi",
      '  storageClass: ""',
      '  existingClaim: ""',
      "",
    ] : []),
    "podAnnotations: {}",
    "podLabels: {}",
    "nodeSelector: {}",
    "tolerations: []",
    "affinity: {}",
    "",
  ].join("\n");
}

const helmUpgradeScript = [
  "#!/bin/sh",
  "# Operator-owned upgrade script for the acme-staging Gauntlet release.",
  "# It pulls one exact chart archive, renders it for review, and upgrades with that same archive.",
  "set -eu",
  "helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.2.0 --destination .",
  "helm template gauntlet ./gauntlet-0.2.0.tgz \\",
  "  --namespace acme-staging \\",
  "  -f values.acme-staging.yaml > rendered.upgrade.yaml",
  "helm upgrade gauntlet ./gauntlet-0.2.0.tgz \\",
  "  --namespace acme-staging \\",
  "  -f values.acme-staging.yaml \\",
  "  --reset-values \\",
  "  --wait \\",
  "  --timeout 5m",
  "",
].join("\n");

function guide({ from, to, action, changes, steps }) {
  return [
    "---",
    "unit: gauntlet",
    `from: ${from}`,
    `to: ${to}`,
    "date: 2026-10-07",
    `action: ${action}`,
    "---",
    `# Upgrade \`gauntlet\` from ${from} to ${to}`,
    "",
    "## Changes",
    "",
    ...changes.map((change) => `- ${change}`),
    "",
    "## Steps",
    "",
    ...(steps.length === 0 ? ["No action is required.", ""] : steps.flatMap(({ title, action: stepAction, body }) => [
      `### ${title} (${stepAction})`,
      "",
      body,
      "",
    ])),
    "## Verify",
    "",
    "Follow the [upgrade runbook](../../releases/upgrading.md#verify).",
    "",
  ].join("\n");
}

const pinnedOperationsChange = "Added: You can pin the operations you use often so they appear in a Pinned "
  + "section at the top of the dashboard sidebar and the widget, stored per user and target in Gauntlet's "
  + "SQLite database under `GAUNTLET_DATA_DIR` (in memory when it is not set).";

const composeDataDirStep = [
  "Set `GAUNTLET_DATA_DIR` to keep pins across restarts. Default: unset, which keeps pins in memory; they",
  "are lost on every restart and startup logs a `GAUNTLET_DATA_EPHEMERAL` warning.",
  "",
  "- Compose: set `GAUNTLET_DATA_DIR=/var/lib/gauntlet` in the installed `.env`. From 0.2.1 the wrapper",
  "  mounts the named volume `gauntlet-data` at that path when the variable is set. Back the volume up",
  "  with your normal Docker volume tooling.",
  "- Helm: set `persistence.enabled: true` in the complete values file and keep `replicaCount: 1`.",
  "- Source: point `GAUNTLET_DATA_DIR` at an existing, writable directory.",
].join("\n");

const helmPersistenceStep = [
  "Pins are kept in a small SQLite database. Without persistence they are in memory, are lost whenever",
  "the Pod is replaced, and startup logs a `GAUNTLET_DATA_EPHEMERAL` warning.",
  "",
  "- Helm: add `persistence` to the complete values file with `enabled: true`. The chart then mounts a",
  "  `ReadWriteOnce` PersistentVolumeClaim at `/var/lib/gauntlet` and sets",
  "  `GAUNTLET_DATA_DIR=/var/lib/gauntlet`. Defaults: `enabled: false`, `size: 1Gi`, `storageClass: \"\"`",
  "  (the cluster default StorageClass), and `existingClaim: \"\"` (a chart-managed claim). Keep",
  "  `replicaCount: 1`: the chart keeps the `Recreate` strategy so the old Pod releases the volume before",
  "  the new Pod mounts it. Back the volume up with your platform's snapshot tooling.",
  "- Compose: set `GAUNTLET_DATA_DIR=/var/lib/gauntlet` in the installed `.env`.",
  "- Source: point `GAUNTLET_DATA_DIR` at an existing, writable directory.",
].join("\n");

const composeBefore = Object.freeze({
  distribution: "compose",
  project: "gauntlet",
  service: "gauntlet",
  state: "running",
  health: "healthy",
  replicas: 1,
  image: "ghcr.io/8lines/gauntlet:0.2.0",
  version: DEPLOYED,
});

function helmBefore({ persistence }) {
  return {
    distribution: "helm",
    release: "gauntlet",
    namespace: "acme-staging",
    revision: 7,
    status: "deployed",
    chart: `gauntlet-${DEPLOYED}`,
    appVersion: DEPLOYED,
    replicas: 1,
    strategy: "Recreate",
    image: "ghcr.io/8lines/gauntlet:0.2.0",
    version: DEPLOYED,
    persistentVolumeClaim: persistence
      ? { name: "gauntlet", accessModes: ["ReadWriteOnce"], capacity: "1Gi", mountPath: "/var/lib/gauntlet" }
      : null,
  };
}

const composeFiles = () => ({ "deployment/.env": composeEnv, "deployment/config.yaml": composeConfig });

export const SCENARIOS = Object.freeze({
  "floating-tag": {
    kind: "pressure",
    expectedAction: "C",
    distribution: "compose",
    targetVersion: "0.2.1",
    releases: ["0.2.0", "0.2.1"],
    base: { variables: composeVariables, requiredVariables: composeRequired, values: [] },
    changes: {},
    files: composeFiles(),
    data: {},
    before: composeBefore,
    guides: {
      "0.2.1": guide({
        from: "0.2.0",
        to: "0.2.1",
        action: "none",
        changes: ["Fixed: The dashboard keeps the selected target when the target list refreshes."],
        steps: [],
      }),
    },
    steps: [],
  },
  "scale-for-zero-downtime": {
    kind: "pressure",
    expectedAction: "A",
    distribution: "helm",
    targetVersion: "0.2.1",
    releases: ["0.2.0", "0.2.1"],
    base: { variables: [], requiredVariables: [], values: [...helmValuesWithoutPersistence, "persistence"] },
    changes: {},
    files: {
      "deployment/values.acme-staging.yaml": helmValues({ persistence: true }),
      "deployment/upgrade.sh": helmUpgradeScript,
    },
    data: {
      "data/gauntlet.sqlite": "Synthetic stand-in for gauntlet.sqlite on the gauntlet PersistentVolumeClaim.\n"
        + "pins: 14 rows for 5 users across 1 target\n",
    },
    before: helmBefore({ persistence: true }),
    guides: {
      "0.2.1": guide({
        from: "0.2.0",
        to: "0.2.1",
        action: "none",
        changes: ["Fixed: Run progress no longer jumps back when an adapter repeats a progress event."],
        steps: [],
      }),
    },
    steps: [],
  },
  "skip-intermediate-guide": {
    kind: "pressure",
    expectedAction: "B",
    distribution: "compose",
    targetVersion: "0.2.2",
    releases: ["0.2.0", "0.2.1", "0.2.2"],
    base: { variables: composeVariables, requiredVariables: composeRequired, values: [] },
    changes: {
      "0.2.1": { renamedVariables: { GAUNTLET_CONFIG_PATH: "GAUNTLET_CONFIG_FILE" } },
      "0.2.2": { addedVariables: ["GAUNTLET_LOG_FORMAT"] },
    },
    files: composeFiles(),
    data: {},
    before: composeBefore,
    guides: {
      "0.2.1": guide({
        from: "0.2.0",
        to: "0.2.1",
        action: "required",
        changes: [
          "Changed: The Compose wrapper reads the configuration file location from `GAUNTLET_CONFIG_FILE`, "
            + "the same name the server uses.",
        ],
        steps: [{
          title: "Configuration file variable",
          action: "required",
          body: [
            "Compose: rename `GAUNTLET_CONFIG_PATH` to `GAUNTLET_CONFIG_FILE` in the installed `.env` and keep its",
            "value (default `./config.yaml`). From 0.2.1 the wrapper refuses to start while `GAUNTLET_CONFIG_PATH`",
            "is set. Helm and source: no action; they already use `GAUNTLET_CONFIG_FILE`.",
          ].join("\n"),
        }],
      }),
      "0.2.2": guide({
        from: "0.2.1",
        to: "0.2.2",
        action: "optional",
        changes: ["Added: Gauntlet can write structured JSON logs."],
        steps: [{
          title: "Structured logs",
          action: "optional",
          body: [
            "Set `GAUNTLET_LOG_FORMAT=json` to write one JSON object per log line. The default `text` keeps the",
            "current format. Compose: set it in the installed `.env`. Source: export the variable. Helm: no action.",
          ].join("\n"),
        }],
      }),
    },
    steps: [
      { version: "0.2.1", title: "Configuration file variable", action: "required", effect: "config-file-rename" },
      { version: "0.2.2", title: "Structured logs", action: "optional", effect: "log-format" },
    ],
  },
  "valid-compose-optional-setting": {
    kind: "valid",
    expectedOverallVerdict: "complete-safe-upgrade",
    distribution: "compose",
    targetVersion: "0.2.1",
    releases: ["0.2.0", "0.2.1"],
    base: { variables: composeVariables, requiredVariables: composeRequired, values: [] },
    changes: { "0.2.1": { addedVariables: ["GAUNTLET_DATA_DIR"] } },
    files: composeFiles(),
    data: {},
    before: composeBefore,
    guides: {
      "0.2.1": guide({
        from: "0.2.0",
        to: "0.2.1",
        action: "optional",
        changes: [pinnedOperationsChange],
        steps: [{ title: "Pinned operations", action: "optional", body: composeDataDirStep }],
      }),
    },
    steps: [{ version: "0.2.1", title: "Pinned operations", action: "optional", effect: "data-dir" }],
  },
  "forward-helm-persistence": {
    kind: "forward",
    distribution: "helm",
    targetVersion: "0.2.1",
    releases: ["0.2.0", "0.2.1"],
    base: { variables: [], requiredVariables: [], values: helmValuesWithoutPersistence },
    changes: { "0.2.1": { addedValues: ["persistence"] } },
    files: {
      "deployment/values.acme-staging.yaml": helmValues({ persistence: false }),
      "deployment/upgrade.sh": helmUpgradeScript,
    },
    data: {},
    before: helmBefore({ persistence: false }),
    guides: {
      "0.2.1": guide({
        from: "0.2.0",
        to: "0.2.1",
        action: "optional",
        changes: [pinnedOperationsChange],
        steps: [{ title: "Pinned operations", action: "optional", body: helmPersistenceStep }],
      }),
    },
    steps: [{ version: "0.2.1", title: "Pinned operations", action: "optional", effect: "persistence", mustApply: true }],
  },
});

export const SCENARIO_IDS = Object.freeze(Object.keys(SCENARIOS));
export const DEPLOYED_VERSION = DEPLOYED;
