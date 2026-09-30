import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseDocument } from "yaml";

const helmDirectory = fileURLToPath(new URL("./", import.meta.url));
const repositoryRoot = realpathSync(new URL("../..", import.meta.url));
const helmReadme = join(helmDirectory, "README.md");
const legacyDirectory = join(repositoryRoot, "deploy", "kubernetes");
const legacyReadme = join(legacyDirectory, "README.md");
const rootReadme = join(repositoryRoot, "README.md");
const MAX_DOCUMENT_BYTES = 256 * 1024;
const REQUIRED_HEADINGS = [
  "## Safety boundary",
  "## Prerequisites",
  "## Complete environment values",
  "## Registry access and first installation",
  "## Private access",
  "## Configuration and rollout",
  "## Status, readiness, and logs",
  "## Upgrade and preview",
  "## Rollback",
  "## Uninstall and data loss",
  "## Ingress and NetworkPolicy limits",
  "## Migrating from the legacy manifests",
];

function readBoundedUtf8(path) {
  const bytes = readFileSync(path);
  assert.ok(bytes.length > 0 && bytes.length <= MAX_DOCUMENT_BYTES, path);
  assert.equal(bytes.includes(0x0d), false, `${path} must use LF line endings`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function namedFences(markdown) {
  const lines = markdown.split("\n");
  const blocks = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^<!-- gauntlet:([a-z0-9-]+) -->$/.exec(lines[index]);
    if (marker === null) continue;
    assert.equal(blocks.has(marker[1]), false, `duplicate fence marker ${marker[1]}`);
    const language = /^```(sh|yaml)$/.exec(lines[index + 1] ?? "");
    assert.notEqual(language, null, `marker ${marker[1]} must precede sh or yaml`);
    const body = [];
    let cursor = index + 2;
    for (; cursor < lines.length && lines[cursor] !== "```"; cursor += 1) body.push(lines[cursor]);
    assert.ok(cursor < lines.length, `fence ${marker[1]} must close`);
    assert.ok(body.length <= 80, `fence ${marker[1]} is unexpectedly large`);
    blocks.set(marker[1], { language: language[1], text: `${body.join("\n")}\n` });
    index = cursor;
  }
  return blocks;
}

function assertEveryFenceIsNamed(markdown, expectedCount) {
  const lines = markdown.split("\n");
  let open = false;
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!open) {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opener === null) continue;
      assert.match(line, /^```(?:sh|yaml)$/, `unsupported fence at line ${index + 1}`);
      assert.match(
        lines[index - 1] ?? "",
        /^<!-- gauntlet:[a-z0-9-]+ -->$/,
        `unmarked fence at line ${index + 1}`,
      );
      open = true;
      count += 1;
    } else if (/^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) {
      assert.equal(line, "```", `malformed closing fence at line ${index + 1}`);
      open = false;
    }
  }
  assert.equal(open, false, "all fences must close");
  assert.equal(count, expectedCount, "every fence must be classified once");
}

function assertSafeCommands(blocks) {
  for (const [name, block] of blocks) {
    if (block.language !== "sh") continue;
    for (const forbidden of [
      /--create-namespace\b/,
      /--reuse-values\b/,
      /--take-ownership\b/,
      /--password(?:=|\s)(?!-stdin)/,
      /(?:^|\s)(?:0\.0\.0\.0|::|\*)\s*:/,
      /\b(?:NodePort|LoadBalancer)\b/,
      /\blatest\b/,
      /\b(?:kubectl|helm)\b[^\n]*\b(?:edit|patch|replace|scale)\b/,
      /\bkubectl\b[^\n]*\brollout\s+restart\b/,
      /\bkubectl\b[^\n]*\bapply\b/,
      /\b(?:kubectl\s+kustomize|kustomize\s+build)\b/,
      /\bhelm\s+(?:upgrade|install)[^\n]*oci:\/\//,
    ]) assert.doesNotMatch(block.text, forbidden, `${name}: unsafe command`);
    if (/\bkubectl\b[^\n]*\bdelete\b/.test(block.text)) {
      assert.equal(name, "legacy-remove");
      assert.equal(
        block.text,
        "kubectl --namespace acme-staging delete deployment/gauntlet service/gauntlet configmap/gauntlet\n",
      );
    }
  }
}

test("the Helm runbook is bounded and covers the complete private lifecycle", () => {
  const markdown = readBoundedUtf8(helmReadme);
  const prose = markdown.replace(/\s+/g, " ");
  let lastHeading = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const position = markdown.indexOf(`${heading}\n`);
    assert.ok(position > lastHeading, heading);
    lastHeading = position;
  }
  for (const required of [
    "v0.1 has no authentication",
    "pre-existing namespace",
    "neither Helm nor the cluster needs registry credentials",
    "optional `imagePullSecrets` value",
    "authenticating reverse proxy",
    "one replica",
    "Recreate",
    "checksum/config",
    "process-local",
    "no PodDisruptionBudget",
    "Do not scale",
    "stable tags are versioned; only digests are immutable",
    "cannot prove the physical environment",
    "disabled independently in production",
    "/ready",
    "/health",
    "target reachability",
    "exact rollback revision",
    "CNI",
    "NetworkPolicies are additive",
    "not authentication",
    "Tailscale ACL",
    "Funnel",
    "ALB",
    "selector-only",
    "cannot safely admit ALB",
    "controller",
    "certificate",
  ]) assert.ok(prose.includes(required), required);

  assert.doesNotMatch(markdown, /ALLOW_PRODUCTION|--create-namespace|--reuse-values|--take-ownership/);
  const blocks = namedFences(markdown);
  assertEveryFenceIsNamed(markdown, blocks.size);
  assertSafeCommands(blocks);
});

test("the documented values and command blocks are complete and exact", () => {
  const markdown = readBoundedUtf8(helmReadme);
  const blocks = namedFences(markdown);
  assert.deepEqual([...blocks.keys()], [
    "environment-values",
    "pull-render-install",
    "private-access",
    "observe",
    "backup-preview",
    "upgrade",
    "rollback",
    "uninstall",
  ]);
  const valuesBlock = blocks.get("environment-values");
  assert.equal(valuesBlock.language, "yaml");
  const document = parseDocument(valuesBlock.text, { prettyErrors: false, strict: true, uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  assert.deepEqual(document.toJS({ maxAliasCount: 0 }), {
    replicaCount: 1,
    image: {
      repository: "ghcr.io/8lines/gauntlet",
      tag: "0.1.3",
      digest: "",
      pullPolicy: "IfNotPresent",
    },
    imagePullSecrets: [],
    config: {
      version: 1,
      instance: { name: "acme-staging", environment: { name: "staging", kind: "staging" } },
      targets: [{
        id: "organizations",
        label: "Organizations staging",
        adapterUrl: "http://organizations.acme-staging.svc.cluster.local:8080",
        expectedEnvironment: { name: "staging", kind: "staging" },
        tags: ["symfony"],
      }],
    },
    service: { type: "ClusterIP", port: 8080 },
    ingress: { enabled: false, className: "", annotations: {}, hosts: [], tls: [] },
    networkPolicy: {
      enabled: false,
      dns: {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
        podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
      },
      ingressPeers: [],
      egressRules: [],
    },
    resources: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { cpu: "500m", memory: "256Mi" },
    },
    podAnnotations: {},
    podLabels: {},
    nodeSelector: {},
    tolerations: [],
    affinity: {},
  });
  assert.match(blocks.get("pull-render-install").text, /helm pull oci:\/\/ghcr\.io\/8lines\/charts\/gauntlet --version 0\.1\.2/);
  assert.match(blocks.get("pull-render-install").text, /helm template gauntlet \.\/gauntlet-0\.1\.2\.tgz/);
  assert.match(blocks.get("pull-render-install").text, /helm upgrade --install gauntlet \.\/gauntlet-0\.1\.2\.tgz/);
  assert.match(blocks.get("pull-render-install").text, /--reset-values/);
  assert.match(blocks.get("private-access").text, /--address 127\.0\.0\.1/);
  assert.match(blocks.get("rollback").text, /helm rollback gauntlet 3 /);
});

test("every documented command executes only through fake Helm and kubectl", () => {
  const helmMarkdown = readBoundedUtf8(helmReadme);
  const legacyMarkdown = readBoundedUtf8(legacyReadme);
  const blocks = new Map([...namedFences(helmMarkdown), ...namedFences(legacyMarkdown)]);
  assertEveryFenceIsNamed(legacyMarkdown, namedFences(legacyMarkdown).size);
  assertSafeCommands(blocks);
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-helm-runbook-")));
  const bin = join(fixture, "bin");
  const receipt = join(fixture, "receipt");
  mkdirSync(bin);
  writeFileSync(receipt, "");
  const fake = `#!/bin/sh
set -eu
tool=$(basename "$0")
{
  printf '%s' "$tool"
  for argument in "$@"; do printf '\\037%s' "$argument"; done
  printf '\n'
} >> "$DOC_RECEIPT"
if [ "$tool" = helm ] && [ "\${1-}" = registry ] && [ "\${2-}" = login ]; then
  payload=
  IFS= read -r payload || true
  [ "$payload" = "$DOC_TOKEN" ] || exit 91
fi
if [ "$tool" = helm ] && [ "\${1-}" = pull ]; then
  : > "$DOC_ROOT/gauntlet-0.1.3.tgz"
fi
if [ "$tool" = helm ] && [ "\${1-}" = template ]; then
  printf '%s\n' 'apiVersion: v1' 'kind: ConfigMap' 'metadata:' '  name: rendered-preview'
fi
if [ "$tool" = helm ] && [ "\${1-}" = get ] && [ "\${2-}" = values ]; then
  printf '%s\n' 'replicaCount: 1'
fi
if [ "$tool" = kubectl ] && [ "\${3-}" = get ]; then
  printf '%s\n' 'fake cluster object'
fi
`;
  writeFileSync(join(bin, "helm"), fake, { mode: 0o700 });
  writeFileSync(join(bin, "kubectl"), fake, { mode: 0o700 });
  writeFileSync(join(fixture, "values.acme-staging.yaml"), blocks.get("environment-values").text);
  const environment = {
    PATH: `${bin}:/usr/bin:/bin`,
    DOC_RECEIPT: receipt,
    DOC_ROOT: fixture,
    DOC_TOKEN: "fake-registry-token-930412",
    GHCR_TOKEN: "fake-registry-token-930412",
    GHCR_USER: "fake-registry-user",
  };
  try {
    for (const block of blocks.values()) {
      if (block.language !== "sh") continue;
      const result = spawnSync("/bin/sh", ["-eu", "-c", block.text], {
        cwd: fixture,
        encoding: "utf8",
        env: environment,
        maxBuffer: 256 * 1024,
        stdio: "pipe",
        timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(readFileSync(join(fixture, "gauntlet-0.1.3.tgz")).length, 0);
    assert.match(readFileSync(join(fixture, "rendered.yaml"), "utf8"), /rendered-preview/);
    assert.match(readFileSync(join(fixture, "rendered.upgrade.yaml"), "utf8"), /rendered-preview/);
    assert.equal(readFileSync(receipt, "utf8").includes("fake-registry-token-930412"), false);
    const calls = readFileSync(receipt, "utf8").trim().split("\n").map((line) => line.split("\x1f"));
    assert.equal(calls.some((call) => call[0] === "helm" && call[1] === "registry"), false);
    const pull = calls.findIndex((call) => call[0] === "helm" && call[1] === "pull");
    const render = calls.findIndex((call) => call[0] === "helm" && call[1] === "template");
    const install = calls.findIndex((call) => call[0] === "helm" && call[1] === "upgrade" && call[2] === "--install");
    assert.ok(pull >= 0 && pull < render && render < install);
    assert.deepEqual(calls[pull].slice(1), [
      "pull", "oci://ghcr.io/8lines/charts/gauntlet", "--version", "0.1.3", "--destination", ".",
    ]);
    assert.equal(calls[install].includes("./gauntlet-0.1.3.tgz"), true);
    assert.equal(calls[install].includes("--reset-values"), true);
    assert.equal(calls.some((call) => call.includes("--create-namespace")), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("legacy Kubernetes files are retired and repository navigation points to Helm", () => {
  const legacy = readBoundedUtf8(legacyReadme);
  const legacyProse = legacy.replace(/\s+/g, " ");
  const root = readBoundedUtf8(rootReadme);
  const index = readBoundedUtf8(join(repositoryRoot, "docs", "README.md"));
  const development = readBoundedUtf8(join(repositoryRoot, "docs", "local-development.md"));
  assert.deepEqual(readdirSync(legacyDirectory).sort(), ["README.md"]);
  for (const required of [
    "supported OCI Helm chart",
    "preserve the current image",
    "preserve the current configuration",
    "schedule downtime",
    "does not adopt ownership",
    "does not delete the namespace",
    "does not migrate process-local state",
    "../helm/README.md",
  ]) assert.ok(legacyProse.includes(required), required);
  const legacyBlocks = namedFences(legacy);
  assert.deepEqual([...legacyBlocks.keys()], ["legacy-backup", "legacy-remove"]);
  assertSafeCommands(legacyBlocks);
  assert.doesNotMatch(legacy, /kubectl\s+(?:apply\s+-k|kustomize)|kustomize\s+build/);

  for (const required of [
    "deploy/compose",
    "deploy/helm",
    "(deploy/helm/README.md)",
    "(docs/README.md)",
    "(docs/architecture.md)",
  ]) assert.ok(root.includes(required), required);
  for (const required of [
    "(../deploy/compose/README.md)",
    "(../deploy/helm/README.md)",
    "(../deploy/kubernetes/README.md)",
    "(local-development.md)",
    "(reference/repository.md)",
  ]) assert.ok(index.includes(required), required);
  for (const required of [
    "Helm 4.0.4",
    "node --test deploy/helm/test-chart-package.mjs",
    "node --test deploy/helm/test-documentation.mjs",
  ]) assert.ok(development.includes(required), required);
  for (const retired of [
    "kubectl kustomize deploy/kubernetes",
    "supplied Kubernetes base",
    "Single-environment Kubernetes base",
  ]) assert.equal(`${root}\n${index}\n${development}`.includes(retired), false, retired);
});
