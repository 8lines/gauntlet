import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPageContext,
  isPortableId,
  parseHandshakeMessage,
  parseHostMessage,
  parsePanelMessage,
  WIDGET_CHANNEL_VERSION,
} from "../src/index.js";

const context = { target: "shop", subjects: [{ type: "order", values: { orderId: "123", paid: false, total: 12.5 } }] };

test("channel version is 1", () => {
  assert.equal(WIDGET_CHANNEL_VERSION, 1);
});

test("portable IDs follow the protocol pattern", () => {
  for (const id of ["shop", "a", "A1._:-", "x".repeat(128)]) assert.equal(isPortableId(id), true, id);
  for (const id of ["", "-a", ".a", "x".repeat(129), "a b", "a/b", 1, null]) assert.equal(isPortableId(id), false, String(id));
});

test("every v1 message parses and extra keys are stripped", () => {
  assert.deepEqual(parseHandshakeMessage({ channel: 1, type: "gauntlet:ready", extra: 1 }),
    { kind: "message", message: { channel: 1, type: "gauntlet:ready" } });
  assert.deepEqual(parseHandshakeMessage({ channel: 1, type: "gauntlet:connect", target: "shop" }),
    { kind: "message", message: { channel: 1, type: "gauntlet:connect", target: "shop" } });
  assert.deepEqual(parseHandshakeMessage({ channel: 1, type: "gauntlet:rejected" }),
    { kind: "message", message: { channel: 1, type: "gauntlet:rejected" } });
  assert.deepEqual(parseHostMessage({ channel: 1, type: "gauntlet:context", context }),
    { kind: "message", message: { channel: 1, type: "gauntlet:context", context } });
  assert.deepEqual(parseHostMessage({ channel: 1, type: "gauntlet:open" }),
    { kind: "message", message: { channel: 1, type: "gauntlet:open" } });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:state", contextualCount: 2, globalCount: 0 }),
    { kind: "message", message: { channel: 1, type: "gauntlet:state", contextualCount: 2, globalCount: 0 } });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:close" }),
    { kind: "message", message: { channel: 1, type: "gauntlet:close" } });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:resize", expanded: true }),
    { kind: "message", message: { channel: 1, type: "gauntlet:resize", expanded: true } });
});

test("returned messages are copies, not the posted object", () => {
  const posted = { channel: 1, type: "gauntlet:context", context: structuredClone(context) };
  const result = parseHostMessage(posted);
  assert.equal(result.kind, "message");
  posted.context.subjects[0]!.values.orderId = "changed";
  assert.equal((result as { message: { context: typeof context } }).message.context.subjects[0]!.values.orderId, "123");
});

test("foreign and malformed data is invalid", () => {
  for (const data of [
    null, "gauntlet:ready", 1, [], { type: "gauntlet:ready" }, { channel: 2, type: "gauntlet:ready" },
    { channel: "1", type: "gauntlet:ready" }, { channel: 1, type: "ready" }, { channel: 1, type: 5 },
    { channel: 1, type: "gauntlet:connect" }, { channel: 1, type: "gauntlet:connect", target: "bad id" },
    Object.assign(Object.create({ channel: 1 }), { type: "gauntlet:ready" }),
    Object.defineProperty({ channel: 1 }, "type", { enumerable: true, get: () => "gauntlet:ready" }),
  ]) {
    assert.equal(parseHandshakeMessage(data).kind, "invalid", JSON.stringify(data));
  }
  for (const data of [
    { channel: 1, type: "gauntlet:state", contextualCount: -1, globalCount: 0 },
    { channel: 1, type: "gauntlet:state", contextualCount: 1.5, globalCount: 0 },
    { channel: 1, type: "gauntlet:state", contextualCount: 1 },
    { channel: 1, type: "gauntlet:state", contextualCount: 1e21, globalCount: 0 },
    { channel: 1, type: "gauntlet:state", contextualCount: 1, globalCount: Number.MAX_SAFE_INTEGER + 1 },
    { channel: 1, type: "gauntlet:resize", expanded: "yes" },
  ]) {
    assert.equal(parsePanelMessage(data).kind, "invalid", JSON.stringify(data));
  }
});

test("well-formed unknown and reserved types are unknown, per direction", () => {
  assert.deepEqual(parseHostMessage({ channel: 1, type: "gauntlet:fill-form" }), { kind: "unknown", type: "gauntlet:fill-form" });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:forms" }), { kind: "unknown", type: "gauntlet:forms" });
  assert.deepEqual(parseHostMessage({ channel: 1, type: "gauntlet:state", contextualCount: 1, globalCount: 1 }),
    { kind: "unknown", type: "gauntlet:state" });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:future-thing", anything: [1] }),
    { kind: "unknown", type: "gauntlet:future-thing" });
});

test("page context enforces IDs, scalar values, uniqueness and limits", () => {
  assert.equal(isPageContext(context), true);
  assert.equal(isPageContext({ target: "shop", subjects: [] }), true);
  const subject = (values: unknown, type: unknown = "order") => ({ target: "shop", subjects: [{ type, values }] });
  for (const bad of [
    { target: "bad id", subjects: [] },
    { target: "shop" },
    subject({ orderId: "1" }, "bad type"),
    subject({ "bad key": "1" }),
    subject({ orderId: null }),
    subject({ orderId: { nested: 1 } }),
    subject({ orderId: Number.NaN }),
    subject({ orderId: Number.POSITIVE_INFINITY }),
    subject({ orderId: "x".repeat(513) }),
    subject(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]))),
    { target: "shop", subjects: [{ type: "order", values: {} }, { type: "order", values: {} }] },
    { target: "shop", subjects: Array.from({ length: 17 }, (_, i) => ({ type: `t${i}`, values: {} })) },
  ]) {
    assert.equal(isPageContext(bad), false, JSON.stringify(bad));
  }
  assert.equal(isPageContext(subject({ orderId: "x".repeat(512) })), true);
});
