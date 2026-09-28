import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startExtendedFixtureAdapter } from "../../src/extended-fixture-adapter.js";
import { loadAdapterV1ExtendedScenario } from "../../src/extended-scenario.js";
import { runBoundedChild } from "../support/child-process.js";

const scenarioUrl = new URL("../../../scenarios/adapter-v1-extended.json", import.meta.url);
const runnerRoot = fileURLToPath(new URL("../../", import.meta.url));

test("the built extended CLI runs the shared scenario against independent enabled and disabled origins", async (t) => {
  const scenario = await loadAdapterV1ExtendedScenario(scenarioUrl);
  const enabled = await startExtendedFixtureAdapter({ scenario, enabled: true });
  const disabled = await startExtendedFixtureAdapter({ scenario, enabled: false });
  t.after(async () => await Promise.all([enabled.close(), disabled.close()]));

  const outcome = await runBoundedChild({
    command: process.execPath,
    arguments: [
      "dist/extended-cli.js",
      "--enabled-base-url",
      enabled.baseUrl,
      "--disabled-base-url",
      disabled.baseUrl,
      "--scenario",
      fileURLToPath(scenarioUrl),
    ],
    cwd: runnerRoot,
  });
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stdout, "");
  assert.equal(outcome.stderr, "");
});
