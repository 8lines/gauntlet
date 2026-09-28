import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveGauntletOrigin } from "../src/origin.js";

test("the Gauntlet origin comes from the first parseable loader script URL", () => {
  assert.deepEqual(deriveGauntletOrigin(["", "not a url", "https://gauntlet.internal/widget/loader.js"]), {
    ok: true,
    origin: "https://gauntlet.internal",
  });
});

test("a missing or opaque loader origin is an error", () => {
  const missing = deriveGauntletOrigin(["", "not a url"]);
  assert.equal(missing.ok, false);
  for (const src of ["file:///srv/widget/loader.js", "data:text/javascript,void 0"]) {
    const opaque = deriveGauntletOrigin([src]);
    assert.equal(opaque.ok, false, src);
    if (!opaque.ok) assert.match(opaque.reason, /opaque/);
  }
});
