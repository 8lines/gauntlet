import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  computeRevision,
  operationSemanticsAreValid,
  type JsonObject,
  type OperationDefinition,
} from "../src/index.js";
import {
  expandedPresetCaseId,
  loadSemanticVectors,
  materializePresetCase,
  type SemanticWorkload,
} from "./support/semantic-vector-loader.js";

const execFileAsync = promisify(execFile);

test("all shared ordinary preset suites preserve revisions and semantic outcomes", async () => {
  const loaded = await loadSemanticVectors();
  for (const suite of loaded.artifact.presetSuites) {
    for (const presetCase of suite.cases) {
      const id = expandedPresetCaseId(suite, presetCase);
      const operation = materializePresetCase(loaded, suite, presetCase) as unknown as OperationDefinition;
      assert.equal(computeRevision(operation as unknown as JsonObject), presetCase.expectedRevision, id);
      assert.equal(operationSemanticsAreValid(operation), presetCase.expected, id);
    }
  }
});

test("all shared generated workloads preserve outcomes and Node reference budgets", async () => {
  const loaded = await loadSemanticVectors();
  const script = fileURLToPath(new URL("./support/semantic-workload-runner.ts", import.meta.url));
  const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const protocolRoot = fileURLToPath(new URL("..", import.meta.url));
  const run = async (workload: SemanticWorkload) => {
    const { stdout } = await execFileAsync(process.execPath, [
      ...workload.nodeReferenceBudget.execArgv,
      "--import",
      loader,
      script,
      workload.id,
    ], {
      cwd: protocolRoot,
      timeout: workload.nodeReferenceBudget.timeoutMs,
    });
    const metrics = JSON.parse(stdout) as {
      status: string;
      id: string;
      actual: boolean;
      canonicalBytes: number;
      maxRssKiB: number;
    };
    assert.deepEqual(Object.keys(metrics), [
      "status", "id", "actual", "canonicalBytes", "maxRssKiB",
    ]);
    assert.equal(metrics.status, "ok", workload.id);
    assert.equal(metrics.id, workload.id);
    assert.equal(metrics.actual, workload.expected, workload.id);
    assert.equal(metrics.canonicalBytes, workload.canonicalBytes, workload.id);
    assert.ok(Number.isSafeInteger(metrics.maxRssKiB) && metrics.maxRssKiB > 0, workload.id);
    return metrics;
  };

  const metrics = new Map<string, Awaited<ReturnType<typeof run>>>();
  for (const workload of loaded.artifact.workloads) {
    metrics.set(workload.id, await run(workload));
  }

  const secret = loaded.artifact.workloads.find(({ id }) => id === "preset.workload.wide.secret");
  assert.ok(secret);
  const secretMetrics = metrics.get(secret.id);
  const controlMetrics = metrics.get(secret.nodeReferenceBudget.controlId!);
  assert.ok(secretMetrics && controlMetrics);
  assert.ok(
    secretMetrics.maxRssKiB < secret.nodeReferenceBudget.maxRssKiBExclusive!,
    `secret child max RSS was ${secretMetrics.maxRssKiB} KiB`,
  );
  assert.ok(
    secretMetrics.maxRssKiB
      < controlMetrics.maxRssKiB + secret.nodeReferenceBudget.maxRssDeltaKiBExclusive!,
    `secret child used ${secretMetrics.maxRssKiB} KiB versus ${controlMetrics.maxRssKiB} KiB control`,
  );
});

test("the generic workload runner rejects missing, extra, and unknown IDs without diagnostics", async () => {
  const script = fileURLToPath(new URL("./support/semantic-workload-runner.ts", import.meta.url));
  const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const protocolRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const args of [
    [],
    ["preset.workload.deep.no-rule-empty", "extra"],
    ["preset.workload.unknown"],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, ["--import", loader, script, ...args], { cwd: protocolRoot }),
      (error: Error & { code?: number; stdout?: string; stderr?: string }) => {
        assert.equal(error.code, 2);
        assert.equal(error.stdout, "");
        assert.equal(error.stderr, "");
        return true;
      },
    );
  }
});
