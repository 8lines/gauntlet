import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandProcessor, installGlobal, LOADER_MARK, type LoaderRuntime } from "../src/commands.js";

function harness() {
  const calls: string[] = [];
  const warnings: string[] = [];
  const runtime: LoaderRuntime = {
    start: (config) => calls.push(`start:${config.target}`),
    refresh: () => calls.push("refresh"),
    open: () => calls.push("open"),
    close: () => calls.push("close"),
    stop: () => calls.push("stop"),
  };
  const processor = createCommandProcessor(runtime, { warn: (message) => warnings.push(message) });
  return { calls, warnings, processor };
}

test("subjects set before boot are remembered and refresh only after boot", () => {
  const { calls, processor } = harness();
  processor.dispatch("setSubject", ["order", { orderId: "1" }]);
  assert.deepEqual(calls, []);
  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("setSubject", ["cart", { cartId: "c" }]);
  processor.dispatch("removeSubject", ["order"]);
  assert.deepEqual(calls, ["start:shop", "refresh", "refresh"]);
  assert.deepEqual([...processor.explicitSubjects()], [["cart", { cartId: "c" }]]);
});

test("boot twice, pre-boot open/close, invalid input and unknown commands warn without side effects", () => {
  const { calls, warnings, processor } = harness();
  processor.dispatch("open", []);
  processor.dispatch("close", []);
  processor.dispatch("boot", [{ target: "bad id" }]);
  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("setSubject", ["bad type", {}]);
  processor.dispatch("setSubject", ["order", { orderId: { nested: true } }]);
  processor.dispatch("launchMissiles", []);
  assert.deepEqual(calls, ["start:shop"]);
  assert.equal(warnings.length, 7);
  assert.ok(warnings.includes("Gauntlet widget: boot was already called; ignoring"));
});

test("boot warns once about ignored option keys", () => {
  const { warnings, processor } = harness();
  processor.dispatch("boot", [{ target: "shop", colour: "red" }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /colour/);
});

test("shutdown stops, forgets subjects and allows a new boot", () => {
  const { calls, processor } = harness();
  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("setSubject", ["order", { orderId: "1" }]);
  processor.dispatch("open", []);
  processor.dispatch("shutdown", []);
  assert.equal(processor.explicitSubjects().size, 0);
  processor.dispatch("boot", [{ target: "admin" }]);
  assert.deepEqual(calls, ["start:shop", "refresh", "open", "stop", "start:admin"]);
});

test("installGlobal replays the stub queue in order and refuses a second loader", () => {
  const { calls, processor } = harness();
  const host: { Gauntlet?: any } = {};
  const stub: any = function () { (stub.q ||= []).push(arguments); };
  host.Gauntlet = stub;
  host.Gauntlet("setSubject", "order", { orderId: "1" });
  host.Gauntlet("boot", { target: "shop" });
  assert.equal(installGlobal(host, processor), true);
  host.Gauntlet("open");
  assert.deepEqual(calls, ["start:shop", "open"]);
  assert.equal(host.Gauntlet[LOADER_MARK], true);

  const second = harness();
  assert.equal(installGlobal(host, second.processor), false);
  host.Gauntlet("close");
  assert.deepEqual(second.calls, []);
  assert.deepEqual(calls, ["start:shop", "open", "close"]);
});

test("setSubject rejects a 17th distinct subject type but still replaces existing ones", () => {
  const { calls, warnings, processor } = harness();
  for (let i = 0; i < 16; i++) processor.dispatch("setSubject", [`s${i}`, { id: i }]);
  assert.equal(processor.explicitSubjects().size, 16);
  processor.dispatch("setSubject", ["s16", { id: 16 }]);
  assert.equal(processor.explicitSubjects().size, 16);
  assert.equal(processor.explicitSubjects().has("s16"), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /16/);

  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("setSubject", ["s0", { id: "replaced" }]);
  assert.deepEqual(processor.explicitSubjects().get("s0"), { id: "replaced" });
  assert.equal(warnings.length, 1);
  assert.deepEqual(calls, ["start:shop", "refresh"]);
});
