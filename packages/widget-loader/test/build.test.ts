import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const dist = new URL("../dist/", import.meta.url);
const loader = new URL("loader.js", dist);

test("the loader builds to one dependency-free IIFE within budget", { skip: !existsSync(loader) && "run the build first" }, () => {
  assert.deepEqual(readdirSync(dist), ["loader.js"]);
  const source = readFileSync(loader, "utf8");
  assert.ok(Buffer.byteLength(source) <= 24 * 1024, `loader.js is ${Buffer.byteLength(source)} bytes`);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  assert.doesNotMatch(source, /sourceMappingURL/);
});
