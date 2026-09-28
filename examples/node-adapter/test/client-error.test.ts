import assert from "node:assert/strict";
import test from "node:test";
import { handleClientError } from "../src/client-error.js";

function recordingSocket(): {
  readonly socket: Parameters<typeof handleClientError>[0];
  readonly writes: string[];
} {
  const writes: string[] = [];
  let writableEnded = false;
  const socket = {
    destroyed: false,
    get writableEnded() {
      return writableEnded;
    },
    end(value?: string) {
      writes.push(value ?? "");
      writableEnded = true;
      return this;
    },
  } as unknown as Parameters<typeof handleClientError>[0];
  return { socket, writes };
}

test("clientError classification compares exact bytes and writes at most once", () => {
  const nonAscii = recordingSocket();
  const hostilePacket = Buffer.concat([
    Buffer.from("GET /", "ascii"),
    Buffer.from([0xdf]),
    Buffer.from("gauntlet/v1/manifest bad HTTP/1.1\r\n", "ascii"),
  ]);
  handleClientError(nonAscii.socket, hostilePacket, true);
  assert.equal(nonAscii.writes.length, 1);
  assert.doesNotMatch(nonAscii.writes[0]!, /urn:gauntlet/);

  const repeated = recordingSocket();
  const adapterPacket = Buffer.from(
    "GET /_gauntlet/v1/manifest bad HTTP/1.1\r\n",
    "ascii",
  );
  handleClientError(repeated.socket, adapterPacket, true);
  handleClientError(repeated.socket, adapterPacket, true);
  assert.equal(repeated.writes.length, 1);
});

test("clientError recognizes the full bounded HTTP token and adapter-equivalent targets", () => {
  for (const requestLine of [
    "get /_gauntlet/v1/manifest bad HTTP/1.1",
    "CUSTOMMETHODEXTENSION /_gauntlet/v1/manifest bad HTTP/1.1",
    "M-SEARCH /_g%61untlet/v1/manifest bad HTTP/1.1",
    "GET http://attacker.invalid/_gauntlet/v1/manifest bad HTTP/1.1",
  ]) {
    const { socket, writes } = recordingSocket();
    handleClientError(socket, Buffer.from(`${requestLine}\r\n`, "ascii"), false);
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /503 Service Unavailable[\s\S]*urn:gauntlet:problem:adapter-disabled/);
  }
});
