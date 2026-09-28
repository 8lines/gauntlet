import assert from "node:assert/strict";
import { get } from "node:http";
import test from "node:test";
import { loadAdapterV1Scenario, runAdapterV1Conformance } from "@8lines/gauntlet-conformance-runner";
import type { AdapterFetchHandler } from "@8lines/gauntlet-typescript-node";
import { startServer } from "../src/server.js";

test("native fixture keeps the host route outside the adapter", async () => {
  const server = await startServer(false);
  const response = await fetch(`${server.url}/host-health`);
  assert.equal(response.status, 200);
  await server.close();
});

test("native fixture passes the frozen P0 scenario", async () => {
  const server = await startServer(true);
  try { await runAdapterV1Conformance({ baseUrl: server.url, scenario: await loadAdapterV1Scenario(new URL("../../../conformance/scenarios/adapter-v1.json", import.meta.url)) }); }
  finally { await server.close(); }
});

test("native fixture streams Web responses and cancels the producer on disconnect", async () => {
  let cancelProducer: (() => void) | undefined;
  const producerCancelled = new Promise<void>((resolve) => { cancelProducer = resolve; });
  const handler: AdapterFetchHandler = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
    cancel() {
      cancelProducer?.();
    },
  }), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
  const server = await startServer(true, handler);
  let request: ReturnType<typeof get> | undefined;
  try {
    const firstChunk = new Promise<string>((resolve, reject) => {
      request = get(`${server.url}/_gauntlet/v1/runs/run-1/events`, (response) => {
        response.once("data", (chunk) => resolve(String(chunk)));
        response.once("error", reject);
      });
      request.once("error", reject);
    });
    assert.equal(await Promise.race([
      firstChunk,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]), "data: first\n\n");
    request?.destroy();
    assert.equal(await Promise.race([
      producerCancelled.then(() => "cancelled" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]), "cancelled");
  } finally {
    request?.destroy();
    await server.close();
  }
});
