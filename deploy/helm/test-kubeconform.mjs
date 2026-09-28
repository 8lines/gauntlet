import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  schemaRoot,
  validateKubernetesManifests,
} from "./kubeconform-support.mjs";
import {
  helm,
  helmChart,
  stagingValues,
} from "./test-support.mjs";

const sourceCommit = "14355cdd490a43d21e05985668815a36a6f97da6";
const maintainedKubernetesVersions = ["1.35.0", "1.36.0", "1.37.0"];
const schemaNames = [
  "configmap-v1.json",
  "deployment-apps-v1.json",
  "ingress-networking-v1.json",
  "networkpolicy-networking-v1.json",
  "service-v1.json",
];
const expectedDigests = {
  LICENSE: "557176ee78f6a6e9c28ebc0f0037ab9acb887b3b5167e9494195109b05affc14",
  SOURCE: "cb301d2a0d0fb555198c21b9bfd92db357fc75493cd5e2a2cf0a5009bd2cfad5",
  "v1.35.0-standalone-strict/configmap-v1.json": "e0eaddebd677c08aa092b2da2264d86ac4fc34eed112b9fac2945b3f00c1e9b1",
  "v1.35.0-standalone-strict/deployment-apps-v1.json": "46dc7cc4bec2c9a62400491e2b8057635afbfa6838999c518f7bea5c621a989b",
  "v1.35.0-standalone-strict/ingress-networking-v1.json": "4e0f63ad84c2bf22565e489d1f4b885ddaa9f6bf7cff1ddd562553760afe4d79",
  "v1.35.0-standalone-strict/networkpolicy-networking-v1.json": "f6324cc464f62228b0418f438d167208e4f86c7e3677ba30f608e79a8b26ba79",
  "v1.35.0-standalone-strict/service-v1.json": "8bf019854daed511e7c174896a898173fa65d88ec5937c687a37303d4cc9351b",
  "v1.36.0-standalone-strict/configmap-v1.json": "e0eaddebd677c08aa092b2da2264d86ac4fc34eed112b9fac2945b3f00c1e9b1",
  "v1.36.0-standalone-strict/deployment-apps-v1.json": "3725782fb01e3f27d8be2da565e2d653d7b78bf6debe5440804cea993c87b8f9",
  "v1.36.0-standalone-strict/ingress-networking-v1.json": "4e0f63ad84c2bf22565e489d1f4b885ddaa9f6bf7cff1ddd562553760afe4d79",
  "v1.36.0-standalone-strict/networkpolicy-networking-v1.json": "f6324cc464f62228b0418f438d167208e4f86c7e3677ba30f608e79a8b26ba79",
  "v1.36.0-standalone-strict/service-v1.json": "8bf019854daed511e7c174896a898173fa65d88ec5937c687a37303d4cc9351b",
  "v1.37.0-standalone-strict/configmap-v1.json": "fed751af12c2873a7db2b4cd1294c2959497fda8520f1fc8e5d21adf967ad72e",
  "v1.37.0-standalone-strict/deployment-apps-v1.json": "0b64451c0b8c36ea06dfebf952718810ae24a07779fb0ed2a6b03f1cc8735a54",
  "v1.37.0-standalone-strict/ingress-networking-v1.json": "4e0f63ad84c2bf22565e489d1f4b885ddaa9f6bf7cff1ddd562553760afe4d79",
  "v1.37.0-standalone-strict/networkpolicy-networking-v1.json": "f6324cc464f62228b0418f438d167208e4f86c7e3677ba30f608e79a8b26ba79",
  "v1.37.0-standalone-strict/service-v1.json": "8bf019854daed511e7c174896a898173fa65d88ec5937c687a37303d4cc9351b",
};

async function regularFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    assert.equal(stat.isSymbolicLink(), false, `${relative(root, path)} must not be a symlink`);
    if (stat.isDirectory()) files.push(...await regularFiles(root, path));
    else {
      assert.equal(stat.isFile(), true, `${relative(root, path)} must be a regular file`);
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

function renderChartSet(valuesFiles, kubeVersion) {
  const args = [
    "template", "gauntlet", helmChart,
    "--namespace", "acme-staging",
    "--kube-version", kubeVersion,
  ];
  for (const valuesFile of valuesFiles) args.push("-f", valuesFile);
  return helm(args);
}

test("vendored schemas are the exact five-kind strict sets from the pinned source commit", async () => {
  const expectedFiles = ["LICENSE", "SHA256SUMS", "SOURCE"];
  for (const version of maintainedKubernetesVersions) {
    for (const schemaName of schemaNames) {
      expectedFiles.push(`v${version}-standalone-strict/${schemaName}`);
    }
  }
  assert.deepEqual(await regularFiles(schemaRoot), expectedFiles.sort());
  assert.equal(
    await readFile(join(schemaRoot, "SOURCE"), "utf8"),
    [
      "upstream=https://github.com/yannh/kubernetes-json-schema",
      `commit=${sourceCommit}`,
      "schema_sets=v1.35.0-standalone-strict,v1.36.0-standalone-strict,v1.37.0-standalone-strict",
      "",
    ].join("\n"),
  );

  for (const [path, expectedDigest] of Object.entries(expectedDigests)) {
    const body = await readFile(join(schemaRoot, path));
    assert.equal(createHash("sha256").update(body).digest("hex"), expectedDigest, path);
    if (path.endsWith(".json")) assert.doesNotThrow(() => JSON.parse(body.toString("utf8")), path);
  }
  const expectedSums = Object.entries(expectedDigests)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, digest]) => `${digest}  ${path}`)
    .join("\n") + "\n";
  assert.equal(await readFile(join(schemaRoot, "SHA256SUMS"), "utf8"), expectedSums);
});

test("all four chart render sets validate offline on every maintained Kubernetes line", () => {
  const renderSets = [
    { values: [stagingValues], kinds: ["ConfigMap", "Deployment", "Service"] },
    {
      values: [stagingValues, "deploy/helm/examples/private-alb-values.yaml"],
      kinds: ["ConfigMap", "Deployment", "Ingress", "Service"],
    },
    {
      values: [stagingValues, "deploy/helm/examples/tailscale-values.yaml"],
      kinds: ["ConfigMap", "Deployment", "Ingress", "Service"],
    },
    {
      values: [stagingValues, "deploy/helm/examples/acme-network-policy-values.yaml"],
      kinds: ["ConfigMap", "Deployment", "NetworkPolicy", "Service"],
    },
  ];

  for (const kubeVersion of maintainedKubernetesVersions) {
    for (const chartSet of renderSets) {
      const manifest = renderChartSet(chartSet.values, kubeVersion);
      const output = validateKubernetesManifests(manifest, { kubeVersion });
      assert.deepEqual(output.summary, {
        valid: chartSet.kinds.length,
        invalid: 0,
        errors: 0,
        skipped: 0,
      });
      assert.deepEqual(
        output.resources.map(({ kind }) => kind).sort(),
        [...chartSet.kinds].sort(),
      );
      assert.equal(output.resources.every(({ filename }) => filename === "stdin"), true);
      assert.equal(output.resources.every(({ name }) => name === "gauntlet"), true);
      assert.equal(output.resources.every(({ status }) => status === "statusValid"), true);
    }
  }
});

test("strict validation rejects a synthetic unknown Kubernetes field", () => {
  const manifest = stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "strict-probe", namespace: "acme-staging" },
    data: { safe: "value" },
    unknownReleaseField: true,
  });
  const result = validateKubernetesManifests(manifest, {
    kubeVersion: "1.35.0",
    expectedStatus: 1,
  });
  assert.deepEqual(result.summary, { valid: 0, invalid: 1, errors: 0, skipped: 0 });
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].status, "statusInvalid");
  assert.match(result.resources[0].msg, /additional properties/i);
});

test("a missing schema is an error and can never be silently ignored", () => {
  const manifest = stringify({
    apiVersion: "gauntlet.8lines.dev/v1",
    kind: "UnvendoredReleaseProbe",
    metadata: { name: "missing-schema" },
  });
  const result = validateKubernetesManifests(manifest, {
    kubeVersion: "1.35.0",
    expectedStatus: 1,
  });
  assert.deepEqual(result.summary, { valid: 0, invalid: 0, errors: 1, skipped: 0 });
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].status, "statusError");
  assert.match(result.resources[0].msg, /could not find schema/i);
});
