import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute, routePath } from "../src/route.ts";

test("run URLs round-trip", () => {
  const route = { targetId: "shop staging", operationId: "customers.create", runId: "run_01J9" };
  assert.equal(routePath(route), "/t/shop%20staging/o/customers.create/r/run_01J9");
  assert.deepEqual(parseRoute(routePath(route)), route);
});

test("an operation URL has no run", () => {
  assert.deepEqual(parseRoute("/t/a/o/b"), { targetId: "a", operationId: "b" });
});

test("a run segment without an id is ignored", () => {
  assert.deepEqual(parseRoute("/t/a/o/b/r"), { targetId: "a", operationId: "b" });
});
