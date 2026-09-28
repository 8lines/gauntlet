import assert from "node:assert/strict";
import test from "node:test";
import type {
  AdapterFetchHandler,
  AdapterFetchHandlerOptions,
  AdapterRequestBoundary,
} from "../src/index.js";

const compileTimeSurface: readonly [
  AdapterFetchHandler?,
  AdapterFetchHandlerOptions?,
  AdapterRequestBoundary?,
] = [];
void compileTimeSurface;

test("public Node package exports the Web handler and raw-target ownership classifier", async () => {
  const exported = Object.keys(await import("../src/index.js")).sort();
  assert.deepEqual(exported, ["createAdapterFetchHandler", "isAdapterTarget"]);
});
