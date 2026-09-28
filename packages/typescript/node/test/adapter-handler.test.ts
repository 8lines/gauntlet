import assert from "node:assert/strict";
import test from "node:test";
import { computeRevision, type JsonObject } from "@8lines/gauntlet-protocol";
import { createAdapterFetchHandler } from "../src/index.js";
import { readJsonObject } from "../src/json.js";
import {
  boundary,
  createFixtureCatalog,
  fixtureManifest,
} from "./support/fixture-catalog.js";

test("only literal true enables the adapter and disabled dispatch never inspects a hostile catalog", async () => {
  for (const enabled of [undefined, false, "true", 1, null, {}] as const) {
    let catalogReads = 0;
    const catalog = new Proxy({}, {
      get() {
        catalogReads += 1;
        throw new Error("catalog read");
      },
      getOwnPropertyDescriptor() {
        catalogReads += 1;
        throw new Error("catalog descriptor read");
      },
      ownKeys() {
        catalogReads += 1;
        throw new Error("catalog key read");
      },
    }) as never;
    const handler = createAdapterFetchHandler({ enabled: enabled as never, catalog });
    for (const rawTarget of [
      "/_gauntlet/v1/manifest",
      "http://attacker.invalid/_gauntlet/v1/health",
      "/%5Fgauntlet/v1/health",
      "//_gauntlet//v1//health",
      "/ordinary/../_gauntlet/v1/health",
      "/_gauntlet/v1/operations/unsafe%ZZid",
    ]) {
      const response = await handler({
        kind: "raw",
        rawTarget,
        request: new Request("http://adapter/ordinary"),
      });
      assert.equal(response.status, 503, `${String(enabled)}: ${rawTarget}`);
      assert.equal(response.headers.get("content-type"), "application/problem+json; charset=utf-8");
      assert.equal((await response.json()).type, "urn:gauntlet:problem:adapter-disabled");
    }
    const nonAdapter = await handler({
      kind: "raw",
      rawTarget: "/ordinary/health",
      request: new Request("http://adapter/ordinary/health"),
    });
    assert.equal(nonAdapter.status, 404);
    assert.equal((await nonAdapter.json()).type, "urn:gauntlet:problem:route-not-found");
    assert.equal(catalogReads, 0);
  }
});

test("enabled adapter validates application environment exactly once during construction", () => {
  for (const environment of [
    { name: "portal-prod", kind: "test" },
    { name: "fixture-test", kind: "unsupported" },
  ]) {
    let calls = 0;
    const { manifestRevision: _manifestRevision, ...manifestDraft } = {
      ...fixtureManifest,
      application: { ...fixtureManifest.application, environment },
    };
    const invalidManifest = {
      ...manifestDraft,
      manifestRevision: computeRevision(
        manifestDraft as unknown as JsonObject,
        "manifestRevision",
      ),
    };
    const catalog = {
      manifest() {
        calls += 1;
        return invalidManifest;
      },
    } as never;

    assert.throws(
      () => createAdapterFetchHandler({ enabled: true, catalog }),
      (error: unknown) => {
        assert.equal(error instanceof TypeError, true);
        assert.equal((error as Error).message, "Operation produced a noncanonical value");
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("enabled adapter validates a safe manifest once at construction and again per manifest request", async () => {
  const fixture = createFixtureCatalog();
  const manifest = fixture.catalog.manifest();
  let calls = 0;
  fixture.catalog.manifest = () => {
    calls += 1;
    return manifest;
  };

  const handler = createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog });
  assert.equal(calls, 1);

  assert.equal((await handler(boundary("GET", "/_gauntlet/v1/health"))).status, 200);
  assert.equal(calls, 1);

  assert.equal((await handler(boundary("GET", "/_gauntlet/v1/manifest"))).status, 200);
  assert.equal(calls, 2);
});

test("raw target validation covers every lossy normalization boundary", async () => {
  const handler = createAdapterFetchHandler({ enabled: true, catalog: createFixtureCatalog().catalog });
  for (const target of [
    "/_gauntlet/v1/operations/a/../b",
    "/_gauntlet/v1/operations/a/./b",
    "/_gauntlet/v1/manifest/..",
    "/_gauntlet/v1/manifest/.",
    "/_gauntlet/v1//manifest",
    "/_gauntlet/v1/operations/a%2fb",
    "/_gauntlet/v1/operations/a\\b",
    "/_gauntlet/v1/manifest?query=1",
    "/_gauntlet/v1/manifest#fragment",
    "/_gauntlet/v1/manifest ",
    "/_gauntlet/v1/manifest/",
    "/_gauntlet/v1/manifest/extra",
    "/_gauntlet/v1/operations/bad$id",
  ]) {
    const response = await handler({
      kind: "raw",
      rawTarget: target,
      request: new Request("http://adapter/_gauntlet/v1/manifest"),
    });
    assert.equal(response.status, 400, target);
    assert.equal((await response.json()).type, "urn:gauntlet:problem:invalid-path");
  }
});

test("JSON reader rejects invalid UTF-8 and declared oversize before consuming the stream", async () => {
  const prefix = new TextEncoder().encode('{"value":"');
  const suffix = new TextEncoder().encode('"}');
  const bytes = new Uint8Array(prefix.length + 2 + suffix.length);
  bytes.set(prefix);
  bytes.set([0xc3, 0x28], prefix.length);
  bytes.set(suffix, prefix.length + 2);
  const invalidUtf8 = await readJsonObject(new Request("http://adapter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bytes,
  }));
  assert.equal(invalidUtf8.ok, false);
  if (!invalidUtf8.ok) assert.equal(invalidUtf8.problem.status, 400);

  let bodyReads = 0;
  const oversizedRequest = {
    headers: new Headers({
      "content-type": "application/json",
      "content-length": String(4 * 1024 * 1024 + 1),
    }),
  } as Record<string, unknown>;
  Object.defineProperty(oversizedRequest, "body", {
    get() {
      bodyReads += 1;
      throw new Error("body must not be read");
    },
  });
  const oversized = await readJsonObject(oversizedRequest as unknown as Request);
  assert.equal(oversized.ok, false);
  assert.equal(bodyReads, 0);
});

test("JSON reader distinguishes media, syntax, and object-envelope failures", async () => {
  const unsupported = await readJsonObject(new Request("http://adapter", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  }));
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.problem.status, 415);

  const syntax = await readJsonObject(boundary("POST", "/_gauntlet/v1/uploads", "{", {
    "content-type": "application/json",
  }).request);
  assert.equal(syntax.ok, false);
  if (!syntax.ok) assert.equal(syntax.problem.status, 400);

  for (const scalar of ["null", "[]", '"value"', "1", "true"]) {
    const result = await readJsonObject(new Request("http://adapter", {
      method: "POST",
      headers: { "content-type": "application/problem+json" },
      body: scalar,
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.status, 422);
  }
});
