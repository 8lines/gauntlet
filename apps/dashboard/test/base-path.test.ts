import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api } from "../src/api.ts";
import { basePath, configureBasePath, readBasePath, withBasePath, withoutBasePath } from "../src/base-path.ts";
import { listPins, pin } from "../src/pins.ts";
import { parseRoute, routePath } from "../src/route.ts";
import { followUpPath } from "../src/run-actions.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  configureBasePath("");
});

function documentWith(content: string | null) {
  return {
    querySelector: (selector: string) => {
      assert.equal(selector, 'meta[name="gauntlet-base-path"]');
      return content === null ? null : { getAttribute: (name: string) => (name === "content" ? content : null) };
    },
  } as unknown as Pick<Document, "querySelector">;
}

test("the base path comes from the page's gauntlet-base-path meta element", () => {
  assert.equal(readBasePath(documentWith("/tester")), "/tester");
  assert.equal(readBasePath(documentWith("/a/b")), "/a/b");
  assert.equal(readBasePath(documentWith("")), "");
  assert.equal(readBasePath(documentWith(null)), "");
  assert.equal(readBasePath(undefined), "");
  for (const malformed of ["tester", "/tester/", "/", "https://evil.example", "//evil.example", "/x?y", "/%2e"]) {
    assert.equal(readBasePath(documentWith(malformed)), "", malformed);
  }
});

test("without a document the dashboard is served at the root", () => {
  assert.equal(basePath(), "");
  assert.equal(withBasePath("/api/v1/targets"), "/api/v1/targets");
  assert.equal(withoutBasePath("/t/a"), "/t/a");
});

test("paths gain and lose the configured base path", () => {
  configureBasePath("/tester");
  assert.equal(withBasePath("/api/v1/targets"), "/tester/api/v1/targets");
  assert.equal(withoutBasePath("/tester"), "/");
  assert.equal(withoutBasePath("/tester/t/a"), "/t/a");
  assert.equal(withoutBasePath("/testers/t/a"), "/testers/t/a");
  configureBasePath("not a path");
  assert.equal(basePath(), "");
});

async function requestedUrls(action: () => Promise<unknown>): Promise<string[]> {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({});
  };
  await action();
  return urls;
}

test("every API request is prefixed with the base path", async () => {
  configureBasePath("/tester");
  const urls = await requestedUrls(async () => {
    await api.session();
    await api.login({ password: "x", surface: "dashboard" });
    await api.logout();
    await api.targets();
    await api.operation("shop", "orders.refund");
    await api.createRun("shop", "orders.refund", { operationRevision: "sha256:x" as never, input: {}, context: {}, dryRun: false });
    await api.run("shop", "run-1");
    await api.queryDataSource("shop", "customers", { context: {} });
    await api.uploadFile("shop", new File(["x"], "x.txt"));
    await api.cancelRun("shop", "run-1");
    await api.launchArtifact("shop", "run-1", "session");
    await listPins("shop");
    await pin("shop", "orders.refund");
  });
  assert.equal(urls.length, 13);
  for (const url of urls) assert.match(url, /^\/tester\/api\/v1\//, url);
  assert.ok(urls.includes("/tester/api/v1/auth/session"));
  assert.ok(urls.includes("/tester/api/v1/targets/shop/uploads"));
  assert.ok(urls.includes("/tester/api/v1/targets/shop/runs/run-1/artifacts/session/launch"));
  assert.ok(urls.includes("/tester/api/v1/targets/shop/pins/orders.refund"));
});

test("at the root API requests keep their absolute paths", async () => {
  assert.deepEqual(await requestedUrls(() => api.targets()), ["/api/v1/targets"]);
});

test("client-side routes live below the base path", () => {
  configureBasePath("/tester");
  const route = { targetId: "shop", operationId: "orders.refund", runId: "run-1" };
  assert.equal(routePath({}), "/tester/");
  assert.equal(routePath({ targetId: "shop" }), "/tester/t/shop");
  assert.equal(routePath(route), "/tester/t/shop/o/orders.refund/r/run-1");
  assert.deepEqual(parseRoute(routePath(route)), route);
  assert.deepEqual(parseRoute("/tester"), {});
  assert.deepEqual(parseRoute("/tester/"), {});
  assert.equal(followUpPath({ kind: "invoke-operation", operationId: "orders.refund" } as never, "shop"), "/tester/t/shop/o/orders.refund");
});
