import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBootOptions } from "../src/options.js";

test("valid options default the position and report ignored keys", () => {
  const result = parseBootOptions({ target: "shop", routes: [{ pattern: "/o/:id", subject: "order" }], colour: "red" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.target, "shop");
  assert.equal(result.config.position, "bottom-right");
  assert.equal(result.config.routes.length, 1);
  assert.deepEqual(result.ignoredKeys, ["colour"]);
  const left = parseBootOptions({ target: "shop", position: "bottom-left" });
  assert.equal(left.ok && left.config.position, "bottom-left");
});

test("invalid target, routes or position fail with a reason", () => {
  for (const value of [undefined, null, "shop", {}, { target: "bad id" }, { target: "shop", routes: "x" }, { target: "shop", position: "top" }]) {
    const result = parseBootOptions(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    if (!result.ok) assert.ok(result.reason.length > 0);
  }
});
