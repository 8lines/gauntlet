import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseDocument } from "yaml";

import { createChartPackageProjection } from "./package-chart.mjs";
import * as support from "./test-support.mjs";

const NEXT_VERSION = "0.1.9";

function copyChartAtVersion(version) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-helm-version-independence-")));
  const chart = join(root, "deploy", "helm", "gauntlet");
  mkdirSync(dirname(chart), { recursive: true });
  cpSync(join(support.repositoryRoot, support.helmChart), chart, { recursive: true, verbatimSymlinks: true });
  for (const [file, edit] of [
    ["Chart.yaml", (document) => {
      document.set("version", version);
      document.set("appVersion", version);
    }],
    ["values.yaml", (document) => document.setIn(["image", "tag"], version)],
  ]) {
    const path = join(chart, file);
    const document = parseDocument(readFileSync(path, "utf8"));
    edit(document);
    writeFileSync(path, String(document));
  }
  return { root, chart };
}

test("Helm tests take the chart version from Chart.yaml instead of a literal", () => {
  assert.equal(typeof support.readChartVersion, "function");
  const { root, chart } = copyChartAtVersion(NEXT_VERSION);
  try {
    assert.equal(support.readChartVersion(chart), NEXT_VERSION);
    const projection = createChartPackageProjection({ sourceRepositoryRoot: root });
    try {
      assert.equal(projection.version, NEXT_VERSION);
      assert.equal(projection.version, support.readChartVersion(chart));
    } finally {
      projection.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the chart version reader rejects a chart whose version and appVersion disagree", () => {
  assert.equal(typeof support.readChartVersion, "function");
  const { root, chart } = copyChartAtVersion(NEXT_VERSION);
  try {
    const path = join(chart, "Chart.yaml");
    const document = parseDocument(readFileSync(path, "utf8"));
    document.set("appVersion", "0.1.10");
    writeFileSync(path, String(document));
    assert.throws(() => support.readChartVersion(chart), /version and appVersion must match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository chart version is the version every Helm test asserts", () => {
  assert.equal(typeof support.readChartVersion, "function");
  assert.equal(support.CHART_VERSION, support.readChartVersion());
  const values = parseDocument(readFileSync(join(support.repositoryRoot, support.helmChart, "values.yaml"), "utf8"));
  assert.equal(values.getIn(["image", "tag"]), support.CHART_VERSION);
});
