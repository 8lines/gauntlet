import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveGauntletOrigin } from "../src/origin.js";

test("the Gauntlet origin comes from the first parseable loader script URL", () => {
  assert.deepEqual(deriveGauntletOrigin(["", "not a url", "https://gauntlet.internal/widget/loader.js"]), {
    ok: true,
    origin: "https://gauntlet.internal",
    baseUrl: "https://gauntlet.internal",
  });
});

test("the base URL keeps the base path Gauntlet is served under", () => {
  assert.deepEqual(deriveGauntletOrigin(["https://pp-test.example/tester/widget/loader.js"]), {
    ok: true,
    origin: "https://pp-test.example",
    baseUrl: "https://pp-test.example/tester",
  });
  assert.deepEqual(deriveGauntletOrigin(["http://127.0.0.1:8080/a/b/widget/loader.js?v=1#x"]), {
    ok: true,
    origin: "http://127.0.0.1:8080",
    baseUrl: "http://127.0.0.1:8080/a/b",
  });
});

test("a loader URL without the widget path or with a malformed prefix falls back to the origin", () => {
  for (const src of [
    "https://gauntlet.internal/static/gauntlet-loader.js",
    "https://gauntlet.internal//widget/loader.js",
    "https://gauntlet.internal/a/%2e%2e/widget/loader.js",
  ]) {
    const result = deriveGauntletOrigin([src]);
    assert.equal(result.ok, true, src);
    if (result.ok) assert.equal(result.baseUrl, "https://gauntlet.internal", src);
  }
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
