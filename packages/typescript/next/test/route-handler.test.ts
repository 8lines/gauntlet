import assert from "node:assert/strict";
import test from "node:test";
import { createGauntletRouteHandler } from "../src/index.js";

const manifestFixture = {
  protocolVersion: "1.0",
  schemaDialect: "https://json-schema.org/draft/2020-12/schema",
  profiles: ["tc-schema-core@1"],
  capabilities: [],
  application: {
    id: "fixture",
    label: "Fixture",
    environment: { name: "fixture-test", kind: "test" },
  },
  features: [{ id: "applications", label: "Applications" }],
  operations: [{
    id: "applications.finalize",
    revision: "sha256:1748ac8e0bd5b33129ca93433cb60e0a6d7527471fdd4482032b31675b993fc3",
    label: "Finalize application",
    featureId: "applications",
    availability: { state: "available" },
  }],
  dataSources: [{
    id: "applications",
    label: "Applications",
    capabilities: {
      search: true,
      pagination: "cursor",
      resolve: true,
      defaultLimit: 10,
      maxLimit: 20,
    },
  }],
  manifestRevision: "sha256:0978b30e3feb38b0f038a9a6ce5aad0d7fc2ed6eba6c774d2a6d6417088524d7",
} as const;

test("bridge returns the adapter disabled response for a canonical normalized target", async () => {
  const route = createGauntletRouteHandler({ enabled: false, catalog: new Proxy({}, { get() { throw new Error("catalog read"); } }) as never });
  const response = await route(new Request("http://next/_gauntlet/v1/manifest?x=1"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).type, "urn:gauntlet:problem:adapter-disabled");
});

test("bridge synchronously applies the enabled adapter startup gate", () => {
  let calls = 0;
  const unsafeManifest = {
    ...manifestFixture,
    application: {
      ...manifestFixture.application,
      environment: { name: "live-eu", kind: "preview" },
    },
    manifestRevision: "sha256:7395a8db912b1ea4eabf6e67f3fb85d4f724e40c493c30a1bce80ad589b08426",
  } as never;

  assert.throws(
    () => createGauntletRouteHandler({
      enabled: true,
      catalog: {
        manifest() {
          calls += 1;
          return unsafeManifest;
        },
      } as never,
    }),
    (error: unknown) => {
      assert.equal(error instanceof TypeError, true);
      assert.equal((error as Error).message, "Operation produced a noncanonical value");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("bridge forwards the original Request and preserves conditional 304 semantics", async () => {
  let manifestCalls = 0;
  const catalog = {
    manifest() {
      manifestCalls += 1;
      return manifestFixture;
    },
  } as never;
  const route = createGauntletRouteHandler({ enabled: true, catalog });
  assert.equal(manifestCalls, 1);
  const initial = await route(new Request("http://next/_gauntlet/v1/manifest", {
    headers: { "x-fixture": "preserved" },
  }));
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("etag"), `"${manifestFixture.manifestRevision}"`);

  const repeat = await route(new Request("http://next/_gauntlet/v1/manifest", {
    headers: { "if-none-match": initial.headers.get("etag")! },
  }));
  assert.equal(repeat.status, 304);
  assert.equal(await repeat.text(), "");
  assert.equal(repeat.headers.get("content-type"), null);
  assert.equal(manifestCalls, 3);
});

test("the seven App Router method exports share typed dispatch and HEAD is bodyless", async () => {
  const route = createGauntletRouteHandler({
    enabled: true,
    catalog: {
      manifest: () => manifestFixture,
      health: () => ({ status: "ok", protocolVersion: "1.0" }),
    } as never,
  });
  const exports = {
    GET: route,
    POST: route,
    PUT: route,
    PATCH: route,
    DELETE: route,
    OPTIONS: route,
    HEAD: route,
  } as const;

  for (const [method, handler] of Object.entries(exports)) {
    const response = await handler(new Request("http://next/_gauntlet/v1/health", { method }));
    assert.equal(response.status, method === "GET" ? 200 : 405, method);
    assert.equal(
      response.headers.get("content-type"),
      method === "GET"
        ? "application/json; charset=utf-8"
        : "application/problem+json; charset=utf-8",
      method,
    );
    const body = await response.text();
    if (method === "HEAD") {
      assert.equal(body, "");
    } else if (method !== "GET") {
      assert.equal(JSON.parse(body).type, "urn:gauntlet:problem:method-not-allowed");
    }
  }
});
