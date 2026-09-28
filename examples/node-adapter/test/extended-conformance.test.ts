import { test } from "node:test";
import {
  loadAdapterV1ExtendedScenario,
  runAdapterV1ExtendedConformance,
} from "@8lines/gauntlet-conformance-runner";
import { startServer } from "../src/server.js";

test("native fixture passes the shared extended scenario", { timeout: 30_000 }, async (t) => {
  const scenario = await loadAdapterV1ExtendedScenario(
    new URL("../../../conformance/scenarios/adapter-v1-extended.json", import.meta.url),
  );
  const enabled = await startServer(true);
  t.after(async () => await enabled.close());
  const disabled = await startServer(false);
  t.after(async () => await disabled.close());

  await runAdapterV1ExtendedConformance({
    enabledBaseUrl: enabled.url,
    disabledBaseUrl: disabled.url,
    scenario,
    pollIntervalMs: 1,
  });
});
