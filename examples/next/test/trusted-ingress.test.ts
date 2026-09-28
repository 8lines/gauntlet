import assert from "node:assert/strict";
import { createServer, get, type RequestListener } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { startTrustedIngress } from "./support/trusted-ingress.js";

async function listeningServer(
  handler: RequestListener,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture bind failure");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function raw(url: string, target: string): Promise<string> {
  return rawPacket(
    url,
    Buffer.from(`GET ${target} HTTP/1.1\r\nHost: ignored.invalid\r\nConnection: close\r\n\r\n`, "latin1"),
  );
}

async function rawPacket(url: string, packet: Buffer): Promise<string> {
  const port = Number(new URL(url).port);
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let output = "";
    socket.setTimeout(2_000, () => reject(new Error("raw ingress timeout")));
    socket.on("data", (data) => { output += data; });
    socket.on("end", () => resolve(output));
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(packet);
    });
  });
}

test("trusted ingress rejects every adapter-equivalent lexical target but forwards host paths", async () => {
  const forwarded: string[] = [];
  const upstream = await listeningServer((request, response) => {
    forwarded.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("host");
  });
  const ingress = await startTrustedIngress(upstream.url);
  try {
    for (const target of [
      "/_g%61untlet/v1/manifest",
      "/%5Fgauntlet/v1/manifest",
      "/_gauntlet/%76%31/manifest",
      "/_gauntlet/v1/manifest/.",
      "/_gauntlet/v1/manifest/..",
      "/_gauntlet/./v1/manifest",
      "/ordinary/../_gauntlet/v1/manifest",
      "//_gauntlet/v1/manifest",
      "/\\_gauntlet\\v1\\manifest",
      "http://attacker.invalid/_gauntlet/v1/health",
      "http://attacker.invalid/_g%61untlet/v1/manifest",
    ]) {
      const result = await raw(ingress.url, target);
      assert.match(result, /400 Bad Request/, target);
      assert.match(result, /urn:gauntlet:problem:invalid-path/, target);
    }

    for (const [target, expectedPath] of [
      ["/_gauntlet/v1/health", "/_gauntlet/v1/health"],
      ["/ordinary/v1/health", "/ordinary/v1/health"],
      ["/_gauntletish/v1/manifest", "/_gauntletish/v1/manifest"],
      ["/assets/%2Ficon", "/assets/%2Ficon"],
      ["/ordinary?view=full", "/ordinary?view=full"],
    ]) {
      const result = await raw(ingress.url, target);
      assert.match(result, /200 OK/, target);
      assert.equal(forwarded.at(-1), expectedPath, target);
    }

    const nonAsciiPacket = Buffer.concat([
      Buffer.from("GET /", "ascii"),
      Buffer.from([0xdf]),
      Buffer.from(
        "gauntlet/v1/manifest bad HTTP/1.1\r\nHost: ignored.invalid\r\nConnection: close\r\n\r\n",
        "ascii",
      ),
    ]);
    const nonAscii = await rawPacket(ingress.url, nonAsciiPacket);
    assert.match(nonAscii, /400 Bad Request/);
    assert.doesNotMatch(nonAscii, /urn:gauntlet/);
  } finally {
    await ingress.close();
    await upstream.close();
  }
});

test("trusted ingress streams the first SSE chunk and propagates downstream cancellation", async () => {
  let closeUpstream: (() => void) | undefined;
  const upstreamClosed = new Promise<void>((resolve) => { closeUpstream = resolve; });
  const upstream = await listeningServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    response.write("data: first\n\n");
    response.on("close", () => closeUpstream?.());
  });
  const ingress = await startTrustedIngress(upstream.url);
  let request: ReturnType<typeof get> | undefined;
  try {
    const firstChunk = new Promise<string>((resolve, reject) => {
      request = get(`${ingress.url}/_gauntlet/v1/runs/run-1/events`, (response) => {
        response.once("data", (chunk) => resolve(String(chunk)));
        response.once("error", reject);
      });
      request.once("error", reject);
    });
    const first = await Promise.race([
      firstChunk,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.equal(first, "data: first\n\n");
    request?.destroy();
    const cancelled = await Promise.race([
      upstreamClosed.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.equal(cancelled, "closed");
  } finally {
    request?.destroy();
    await ingress.close();
    await upstream.close();
  }
});
