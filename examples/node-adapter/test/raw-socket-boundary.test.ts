import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { startServer } from "../src/server.js";

async function raw(
  url: string,
  target: string,
  method = "GET",
  headers: readonly string[] = ["Host: adapter", "Connection: close"],
): Promise<string> {
  const port = Number(new URL(url).port);
  return new Promise((resolve, reject) => { const socket = connect(port, "127.0.0.1"); let response = ""; socket.setTimeout(2_000, () => reject(new Error("socket timeout"))); socket.on("data", (data) => { response += data; }); socket.on("end", () => resolve(response)); socket.on("error", reject); socket.on("connect", () => socket.end(`${method} ${target} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`)); });
}
for (const target of ["/_gauntlet/v1/manifest bad", "/_gauntlet/v1/manifest\tbad"]) test(`native clientError classifies ${JSON.stringify(target)}`, async () => {
  const enabled = await startServer(true); try { assert.match(await raw(enabled.url, target), /400 Bad Request[\s\S]*urn:gauntlet:problem:invalid-path/); } finally { await enabled.close(); }
  const disabled = await startServer(false); try { assert.match(await raw(disabled.url, target), /503 Service Unavailable[\s\S]*urn:gauntlet:problem:adapter-disabled/); } finally { await disabled.close(); }
});

for (const requestCase of [
  { name: "TRACE", method: "TRACE", status: "405 Method Not Allowed" },
  { name: "TRACK", method: "TRACK", status: "400 Bad Request" },
  { name: "CONNECT", method: "CONNECT", status: "405 Method Not Allowed" },
  {
    name: "upgrade", method: "GET", status: "405 Method Not Allowed",
    headers: ["Host: adapter", "Connection: Upgrade", "Upgrade: synthetic"],
  },
  {
    name: "non-100 Expect", method: "GET", status: "417 Expectation Failed",
    headers: ["Host: adapter", "Expect: synthetic", "Connection: close"],
  },
]) {
  test(`native ${requestCase.name} path cannot bypass disabled precedence`, async () => {
    const disabled = await startServer(false);
    try {
      assert.match(await raw(disabled.url, "/_gauntlet/v1/manifest", requestCase.method, requestCase.headers),
        /503 Service Unavailable[\s\S]*urn:gauntlet:problem:adapter-disabled/);
    } finally {
      await disabled.close();
    }
    const enabled = await startServer(true);
    try {
      const response = await raw(enabled.url, "/_gauntlet/v1/manifest", requestCase.method, requestCase.headers);
      assert.match(response, new RegExp(`${requestCase.status}[\\s\\S]*urn:gauntlet:problem:`));
    } finally {
      await enabled.close();
    }
  });
}

for (const target of [
  "http://attacker.invalid/_gauntlet/v1/health",
  "http://attacker.invalid\\_gauntlet\\v1\\health",
  "http:////attacker.invalid/_gauntlet/v1/health",
]) {
  test(`native host rejects absolute-form adapter target ${JSON.stringify(target)} without bypassing disabled precedence`, async () => {
    const enabled = await startServer(true);
    try {
      assert.match(await raw(enabled.url, target), /400 Bad Request[\s\S]*urn:gauntlet:problem:invalid-path/);
    } finally {
      await enabled.close();
    }
    const disabled = await startServer(false);
    try {
      assert.match(await raw(disabled.url, target), /503 Service Unavailable[\s\S]*urn:gauntlet:problem:adapter-disabled/);
    } finally {
      await disabled.close();
    }
  });
}

test("native host owns recursively encoded adapter targets without bypassing disabled precedence", async () => {
  const target = "/%2525255Fgauntlet/v1/manifest";
  const enabled = await startServer(true);
  try {
    assert.match(await raw(enabled.url, target), /400 Bad Request[\s\S]*urn:gauntlet:problem:invalid-path/);
  } finally {
    await enabled.close();
  }
  const disabled = await startServer(false);
  try {
    assert.match(await raw(disabled.url, target), /503 Service Unavailable[\s\S]*urn:gauntlet:problem:adapter-disabled/);
  } finally {
    await disabled.close();
  }
});
