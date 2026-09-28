import assert from "node:assert/strict";
import test from "node:test";
import { loadAdapterV1Scenario, runAdapterV1Conformance } from "@8lines/gauntlet-conformance-runner";
import { connect } from "node:net";
import { startNextFixture } from "./support/next-process.js";
import { startTrustedIngress } from "./support/trusted-ingress.js";

test("Next fixture uses a literal adapter mount and exports all seven methods", async () => {
  const hostRoute = await import("../app/host-health/route.js");
  assert.equal(hostRoute.GET().status, 200);
  const adapterRouteModule = "../app/%255Fgauntlet/v1/[...gauntlet]/route.js";
  const adapterRoute = await import(adapterRouteModule) as Record<string, unknown>;
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const) {
    assert.equal(typeof adapterRoute[method], "function", method);
  }
});

test("real Next process passes frozen P0 HTTP conformance", { timeout: 30_000 }, async () => {
  const next = await startNextFixture(true);
  try {
    const ingress = await startTrustedIngress(next.url);
    try {
      await runAdapterV1Conformance({ baseUrl: ingress.url, scenario: await loadAdapterV1Scenario(new URL("../../../conformance/scenarios/adapter-v1.json", import.meta.url)) });
      const host = await fetch(`${ingress.url}/host-health`, {
        headers: {
          "x-tc-actor": "forged",
          "x-tc-workload": "forged",
          "x-forwarded-for": "203.0.113.9",
        },
      });
      assert.equal(host.status, 200);
      const forwarded = ingress.forwardedHeaders();
      assert.ok(forwarded);
      assert.equal(forwarded.get("x-tc-actor"), null);
      assert.equal(forwarded.get("x-tc-workload"), null);
      assert.equal(forwarded.get("x-forwarded-for"), null);

      const ordinary = await fetch(`${ingress.url}/ordinary/v1/health`);
      assert.equal(ordinary.status, 404);
      assert.notEqual(
        ordinary.headers.get("content-type"),
        "application/problem+json; charset=utf-8",
      );
      assert.doesNotMatch(await ordinary.text(), /urn:gauntlet:problem:route-not-found/);
    }
    finally { await ingress.close(); }
  } finally {
    await next.close();
  }
});

async function raw(url: string, target: string): Promise<string> {
  const port = Number(new URL(url).port);
  return new Promise((resolve, reject) => { const socket = connect(port, "127.0.0.1"); let output = ""; socket.setTimeout(2_000, () => reject(new Error("timeout"))); socket.on("data", (data) => { output += data; }); socket.on("end", () => resolve(output)); socket.on("error", reject); socket.on("connect", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`)); });
}

test("trusted ingress owns literal raw whitespace as a fixed 400 in both enablement states", async () => {
  // The direct Next process never receives parser-rejected request lines; this is the ingress contract.
  for (const enabled of [true, false]) {
    const next = await startNextFixture(enabled);
    let ingress: Awaited<ReturnType<typeof startTrustedIngress>> | undefined;
    try {
      ingress = await startTrustedIngress(next.url);
      for (const target of ["/_gauntlet/v1/manifest bad", "/_gauntlet/v1/manifest\tbad"]) assert.match(await raw(ingress.url, target), /400 Bad Request[\s\S]*urn:gauntlet:problem:invalid-path/);
      const canonical = await fetch(`${ingress.url}/_gauntlet/v1/manifest`);
      assert.equal(canonical.status, enabled ? 200 : 503);
    } finally { if (ingress) await ingress.close(); await next.close(); }
  }
});
