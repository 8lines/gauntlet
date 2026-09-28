import assert from "node:assert/strict";
import { test } from "node:test";
import { panelHandshake } from "../src/handshake.js";

const frame = {};
const origin = "https://gauntlet.internal";

test("ready and rejected are accepted only from the panel frame at the Gauntlet origin", () => {
  assert.equal(panelHandshake({ origin, source: frame, data: { channel: 1, type: "gauntlet:ready" } }, origin, frame), "ready");
  assert.equal(panelHandshake({ origin, source: frame, data: { channel: 1, type: "gauntlet:rejected" } }, origin, frame), "rejected");
  for (const event of [
    { origin: "https://evil.example", source: frame, data: { channel: 1, type: "gauntlet:ready" } },
    { origin, source: {}, data: { channel: 1, type: "gauntlet:ready" } },
    { origin, source: null, data: { channel: 1, type: "gauntlet:ready" } },
    { origin, source: frame, data: { channel: 1, type: "gauntlet:connect", target: "shop" } },
    { origin, source: frame, data: { channel: 2, type: "gauntlet:ready" } },
    { origin, source: frame, data: "gauntlet:ready" },
  ]) {
    assert.equal(panelHandshake(event, origin, frame), undefined, JSON.stringify(event.data));
  }
  assert.equal(panelHandshake({ origin, source: frame, data: { channel: 1, type: "gauntlet:ready" } }, origin, undefined), undefined);
});
