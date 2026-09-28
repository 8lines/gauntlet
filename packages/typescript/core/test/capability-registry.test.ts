import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityRegistry } from "../src/index.js";

test("registry rejects a generic provider that claims a core capability", () => {
  const registry = new CapabilityRegistry();
  assert.throws(() => registry.registerProvider({ id: "tc-uploads@1" }), /core capability/i);
});

test("registry retains one future non-core provider", () => {
  const registry = new CapabilityRegistry();
  registry.registerProvider({ id: "urn:fixture:future@1" });
  assert.deepEqual(registry.ids(), ["urn:fixture:future@1"]);
});

test("each Core SPI is absent by default and rejects duplicate registration", () => {
  const registry = new CapabilityRegistry();
  assert.equal(registry.cancellation(), undefined);
  assert.equal(registry.events(), undefined);
  assert.equal(registry.uploads(), undefined);
  assert.equal(registry.sessionLaunch(), undefined);

  const cancellation = { cancel: () => ({}) as never };
  const events = { events: async function* () {} };
  const uploads = { create: () => ({}) as never };
  const session = { create: () => ({}) as never };
  registry.registerCancellation(cancellation);
  registry.registerEvents(events);
  registry.registerUploads(uploads);
  registry.registerSessionLaunch(session);

  assert.throws(() => registry.registerCancellation(cancellation), /duplicate/i);
  assert.throws(() => registry.registerEvents(events), /duplicate/i);
  assert.throws(() => registry.registerUploads(uploads), /duplicate/i);
  assert.throws(() => registry.registerSessionLaunch(session), /duplicate/i);
  assert.deepEqual(registry.ids(), [
    "tc-run-cancellation@1",
    "tc-run-sse@1",
    "tc-session-launch@1",
    "tc-uploads@1",
  ]);
});
