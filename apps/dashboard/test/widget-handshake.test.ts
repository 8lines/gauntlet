import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideConnect, parseWidgetConfig, type ConnectEventLike, type WidgetConfig } from "../src/widget/handshake.ts";

describe("parseWidgetConfig", () => {
  it("accepts the phase-2 shape", () => {
    const parsed = parseWidgetConfig({ targets: { portal: ["https://host.example"], billing: [] } });
    assert.deepEqual(parsed, { targets: { portal: ["https://host.example"], billing: [] } });
  });

  it("rejects a null value", () => {
    assert.equal(parseWidgetConfig(null), undefined);
  });

  it("rejects a document without a targets field", () => {
    assert.equal(parseWidgetConfig({}), undefined);
  });

  it("rejects a targets value that is not an object", () => {
    assert.equal(parseWidgetConfig({ targets: ["portal"] }), undefined);
  });

  it("rejects a target whose origin list contains a non-string", () => {
    assert.equal(parseWidgetConfig({ targets: { portal: ["https://host.example", 1] } }), undefined);
  });

  it("rejects a document that is not an object", () => {
    assert.equal(parseWidgetConfig("nope"), undefined);
  });
});

describe("decideConnect", () => {
  const parent = { name: "parent-window" };
  const otherSource = { name: "other-window" };
  const config: WidgetConfig = { targets: { portal: ["https://host.example"] } };

  function event(overrides: Partial<ConnectEventLike> = {}): ConnectEventLike {
    return {
      origin: "https://host.example",
      source: parent,
      data: { channel: 1, type: "gauntlet:connect", target: "portal" },
      ports: [{}],
      ...overrides,
    };
  }

  it("connects for a listed origin from the parent with exactly one port", () => {
    const port = {};
    const decision = decideConnect(event({ ports: [port] }), parent, config);
    assert.deepEqual(decision, { kind: "connect", target: "portal", port });
  });

  it("rejects an unlisted origin", () => {
    const decision = decideConnect(event({ origin: "https://evil.example" }), parent, config);
    assert.deepEqual(decision, { kind: "reject" });
  });

  it("rejects an unknown target", () => {
    const decision = decideConnect(event({ data: { channel: 1, type: "gauntlet:connect", target: "unknown" } }), parent, config);
    assert.deepEqual(decision, { kind: "reject" });
  });

  it('rejects a target named "toString" instead of falling through to Object.prototype', () => {
    const decision = decideConnect(event({ data: { channel: 1, type: "gauntlet:connect", target: "toString" } }), parent, config);
    assert.deepEqual(decision, { kind: "reject" });
  });

  it('rejects a target named "constructor" instead of falling through to Object.prototype', () => {
    const decision = decideConnect(event({ data: { channel: 1, type: "gauntlet:connect", target: "constructor" } }), parent, config);
    assert.deepEqual(decision, { kind: "reject" });
  });

  it("rejects zero ports", () => {
    const decision = decideConnect(event({ ports: [] }), parent, config);
    assert.deepEqual(decision, { kind: "reject" });
  });

  it("rejects two ports", () => {
    const decision = decideConnect(event({ ports: [{}, {}] }), parent, config);
    assert.deepEqual(decision, { kind: "reject" });
  });

  it("ignores a message from another source", () => {
    const decision = decideConnect(event({ source: otherSource }), parent, config);
    assert.deepEqual(decision, { kind: "ignore" });
  });

  it("ignores foreign data that does not parse as a gauntlet message", () => {
    const decision = decideConnect(event({ data: { unrelated: true } }), parent, config);
    assert.deepEqual(decision, { kind: "ignore" });
  });

  it('ignores a "gauntlet:ready" message', () => {
    const decision = decideConnect(event({ data: { channel: 1, type: "gauntlet:ready" } }), parent, config);
    assert.deepEqual(decision, { kind: "ignore" });
  });
});
