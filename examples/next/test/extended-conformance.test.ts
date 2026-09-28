import { test } from "node:test";
import {
  loadAdapterV1ExtendedScenario,
  runAdapterV1ExtendedConformance,
} from "@8lines/gauntlet-conformance-runner";
import { startNextFixture } from "./support/next-process.js";
import { startTrustedIngress } from "./support/trusted-ingress.js";

test("real Next fixture passes the shared extended scenario", { timeout: 45_000 }, async (t) => {
  const scenario = await loadAdapterV1ExtendedScenario(
    new URL("../../../conformance/scenarios/adapter-v1-extended.json", import.meta.url),
  );
  const enabledNext = await startNextFixture(true);
  t.after(async () => await enabledNext.close());
  const disabledNext = await startNextFixture(false);
  t.after(async () => await disabledNext.close());
  const enabled = await startTrustedIngress(enabledNext.url);
  t.after(async () => await enabled.close());
  const disabled = await startTrustedIngress(disabledNext.url);
  t.after(async () => await disabled.close());

  await runAdapterV1ExtendedConformance({
    enabledBaseUrl: enabled.url,
    disabledBaseUrl: disabled.url,
    scenario,
    pollIntervalMs: 1,
  });
});
