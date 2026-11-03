import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { injectBasePath, isBasePath } from "../src/base-path.js";
import { basePathConfiguration, createConfiguredApp } from "../src/main.js";
import { passwordAuth, passwords } from "./support/auth.js";
import { serverEnvironment } from "./support/environment.js";
import { createFakeAdapter, fakeTarget } from "./support/fake-adapter.js";

type App = Awaited<ReturnType<typeof createApp>>;

const DASHBOARD_INDEX = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" />",
  "<base href=\"/\" /><meta name=\"gauntlet-base-path\" content=\"\" />",
  "<script type=\"module\" src=\"./assets/index-abc12345.js\"></script></head>",
  "<body>dashboard fixture</body></html>",
].join("");
const PANEL_INDEX = "<!doctype html><html><head><meta name=\"gauntlet-base-path\" content=\"\" /></head><body>panel fixture</body></html>";
const LOADER = "globalThis.gauntletLoaderFixture = true;";
const widgetTarget = { ...fakeTarget, widget: { origins: ["https://shop.dev.example"] } };

async function usingBuild<T>(action: (dirs: { dashboardDir: string; widgetDir: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-base-path-"));
  const files: Record<string, string> = {
    "dashboard/index.html": DASHBOARD_INDEX,
    "dashboard/assets/index-abc12345.js": "globalThis.dashboard = true;",
    "widget/index.html": PANEL_INDEX,
    "widget/loader.js": LOADER,
    "widget/assets/panel-abc12345.js": "globalThis.panel = true;",
  };
  try {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents, "utf8");
    }
    return await action({ dashboardDir: join(root, "dashboard"), widgetDir: join(root, "widget") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function usingApp<T>(options: Partial<CreateAppOptions>, action: (app: App) => Promise<T>): Promise<T> {
  const app = await createApp({
    environment: serverEnvironment,
    targets: [widgetTarget],
    fetch: createFakeAdapter().fetch,
    basePath: "/tester",
    ...options,
  });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

function assertRouteNotFound(response: { statusCode: number; json(): unknown }, label: string): void {
  assert.equal(response.statusCode, 404, label);
  assert.equal((response.json() as { type: string }).type, "urn:gauntlet:problem:route-not-found", label);
}

const html = { accept: "text/html" };

test("a base path is a canonical prefix of unreserved path segments", () => {
  for (const value of ["", "/tester", "/a/b", "/Gauntlet-1.2_x~y"]) assert.equal(isBasePath(value), true, value);
  for (const value of ["/", "tester", "/tester/", "//x", "/x?y", "/x#y", "/%74", "/.", "/..", "/a/./b", "/a b", 1]) {
    assert.equal(isBasePath(value), false, String(value));
  }
});

test("createApp rejects an invalid base path before listening", async () => {
  await assert.rejects(
    createApp({ environment: serverEnvironment, targets: [fakeTarget], basePath: "/tester/" }),
    /Invalid base path/,
  );
});

test("GAUNTLET_BASE_PATH overrides the configured basePath unless it is empty", () => {
  assert.equal(basePathConfiguration({}, "/configured"), "/configured");
  assert.equal(basePathConfiguration({ GAUNTLET_BASE_PATH: "" }, "/configured"), "/configured");
  assert.equal(basePathConfiguration({ GAUNTLET_BASE_PATH: "/tester" }, ""), "/tester");
  assert.equal(basePathConfiguration({ GAUNTLET_BASE_PATH: "/tester" }, "/configured"), "/tester");
  for (const value of ["tester", "/tester/", "/x?secret=1"]) {
    assert.throws(() => basePathConfiguration({ GAUNTLET_BASE_PATH: value }, ""), (error: unknown) => {
      assert.equal(String(error).includes(value), false);
      return true;
    });
  }
});

test("the configured app serves under GAUNTLET_BASE_PATH", async () => {
  const config = JSON.stringify({
    version: 1,
    instance: { name: "base-path-test", environment: serverEnvironment },
    targets: [{ ...fakeTarget, tags: [...fakeTarget.tags] }],
  });
  const app = await createConfiguredApp(
    { GAUNTLET_CONFIG_FILE: "/config.json", GAUNTLET_BASE_PATH: "/tester" },
    { readConfig: async () => new TextEncoder().encode(config) },
  );
  try {
    assert.equal((await app.inject({ method: "GET", url: "/tester/api/v1/auth/session" })).statusCode, 200);
    assertRouteNotFound(await app.inject({ method: "GET", url: "/api/v1/auth/session" }), "unprefixed");
  } finally {
    await app.close();
  }
});

test("the API, probes and dashboard are served under the base path only", async () => {
  await usingBuild(async ({ dashboardDir }) => {
    await usingApp({ dashboardDir }, async (app) => {
      const targets = await app.inject({ method: "GET", url: "/tester/api/v1/targets" });
      assert.equal(targets.statusCode, 200, targets.body);
      assert.equal((targets.json() as { targets: unknown[] }).targets.length, 1);

      for (const url of ["/health", "/tester/health"]) {
        const response = await app.inject({ method: "GET", url });
        assert.equal(response.statusCode, 200, url);
        assert.deepEqual(response.json(), { status: "ok" }, url);
      }
      for (const url of ["/ready", "/ready?probe=1", "/tester/ready"]) {
        const response = await app.inject({ method: "GET", url });
        assert.equal(response.statusCode, 200, url);
        assert.deepEqual(response.json(), { status: "ready" }, url);
      }

      for (const url of [
        "/api/v1/targets",
        "/api/v1/auth/session",
        "/",
        "/index.html",
        "/assets/index-abc12345.js",
        "/t/acme",
        "/widget/loader.js",
        "/mcp",
        "/testers/api/v1/targets",
        "/other/tester/api/v1/targets",
        "/health/x",
      ]) {
        assertRouteNotFound(await app.inject({ method: "GET", url, headers: html }), url);
      }
      assertRouteNotFound(await app.inject({ method: "POST", url: "/api/v1/targets/acme/operations/x/runs", payload: {} }), "POST outside");
    });
  });
});

test("the bare base path redirects to its trailing-slash form, keeping the query", async () => {
  await usingBuild(async ({ dashboardDir }) => {
    await usingApp({ dashboardDir }, async (app) => {
      const bare = await app.inject({ method: "GET", url: "/tester", headers: html });
      assert.equal(bare.statusCode, 308);
      assert.equal(bare.headers.location, "/tester/");
      const query = await app.inject({ method: "GET", url: "/tester?x=1" });
      assert.equal(query.statusCode, 308);
      assert.equal(query.headers.location, "/tester/?x=1");
    });
  });
});

test("the dashboard index carries the base path on the root, index and client-side routes", async () => {
  await usingBuild(async ({ dashboardDir }) => {
    await usingApp({ dashboardDir }, async (app) => {
      for (const url of ["/tester/", "/tester/index.html", "/tester/t/acme/o/change-date/r/run-1"]) {
        const response = await app.inject({ method: "GET", url, headers: html });
        assert.equal(response.statusCode, 200, url);
        assert.match(String(response.headers["content-type"]), /^text\/html/, url);
        assert.equal(response.headers["content-security-policy"], "frame-ancestors 'none'", url);
        assert.equal(response.headers["cache-control"], "no-cache", url);
        const body = response.body;
        assert.equal(body.match(/<base\b/g)?.length, 1, url);
        assert.equal(body.match(/gauntlet-base-path/g)?.length, 1, url);
        assert.match(body, /<head><base href="\/tester\/"><meta name="gauntlet-base-path" content="\/tester"><meta charset="utf-8" \/>/, url);
        assert.match(body, /src="\.\/assets\/index-abc12345\.js"/, url);
      }
      const asset = await app.inject({ method: "GET", url: "/tester/assets/index-abc12345.js" });
      assert.equal(asset.statusCode, 200);
      assert.equal(asset.body, "globalThis.dashboard = true;");
      assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");

      // API-shaped paths below the prefix keep their problem answers instead of the SPA.
      assertRouteNotFound(await app.inject({ method: "GET", url: "/tester/api/v1/unknown", headers: html }), "api");
      assertRouteNotFound(await app.inject({ method: "GET", url: "/tester/assets/missing.js", headers: html }), "asset");
    });
  });
});

test("without a base path the dashboard index is served unchanged", async () => {
  await usingBuild(async ({ dashboardDir }) => {
    await usingApp({ dashboardDir, basePath: "" }, async (app) => {
      for (const url of ["/", "/t/acme"]) {
        const response = await app.inject({ method: "GET", url, headers: html });
        assert.equal(response.statusCode, 200, url);
        assert.equal(response.body, DASHBOARD_INDEX, url);
      }
      assertRouteNotFound(await app.inject({ method: "GET", url: "/tester/api/v1/targets" }), "prefixed");
    });
  });
});

test("the widget loader, panel, assets and configuration are served under the base path", async () => {
  await usingBuild(async ({ widgetDir }) => {
    await usingApp({ widget: { enabled: true, dir: widgetDir } }, async (app) => {
      const loader = await app.inject({ method: "GET", url: "/tester/widget/loader.js" });
      assert.equal(loader.statusCode, 200);
      assert.equal(loader.body, LOADER);

      const panel = await app.inject({ method: "GET", url: "/tester/widget/" });
      assert.equal(panel.statusCode, 200);
      assert.equal(panel.headers["content-security-policy"], "frame-ancestors https://shop.dev.example");
      assert.match(panel.body, /<head><meta name="gauntlet-base-path" content="\/tester"><\/head>/);
      assert.doesNotMatch(panel.body, /<base\b/);
      const cached = await app.inject({
        method: "GET", url: "/tester/widget/", headers: { "if-none-match": String(panel.headers.etag) },
      });
      assert.equal(cached.statusCode, 304);

      const config = await app.inject({ method: "GET", url: "/tester/widget/config.json" });
      assert.deepEqual(config.json(), { targets: { acme: ["https://shop.dev.example"] } });
      assert.equal((await app.inject({ method: "GET", url: "/tester/widget/assets/panel-abc12345.js" })).statusCode, 200);

      for (const url of ["/widget/loader.js", "/widget/", "/widget/config.json", "/widget/assets/panel-abc12345.js"]) {
        assertRouteNotFound(await app.inject({ method: "GET", url }), url);
      }
    });
  });
});

function setCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  return Array.isArray(value) ? value.join("\n") : String(value ?? "");
}

test("password sessions are scoped to the base path and the guard sees prefixed API paths", async () => {
  await usingApp({ auth: passwordAuth({ publicUrl: "https://gauntlet.test" }) }, async (app) => {
    const unauthenticated = await app.inject({ method: "GET", url: "/tester/api/v1/targets" });
    assert.equal(unauthenticated.statusCode, 401);
    const session = await app.inject({ method: "GET", url: "/tester/api/v1/auth/session" });
    assert.equal(session.statusCode, 200);

    const dashboard = await app.inject({
      method: "POST", url: "/tester/api/v1/auth/login", payload: { password: passwords.shared, surface: "dashboard" },
    });
    assert.equal(dashboard.statusCode, 200, dashboard.body);
    assert.match(setCookie(dashboard), /; Path=\/tester; HttpOnly; SameSite=Lax; Secure$/);
    const widget = await app.inject({
      method: "POST", url: "/tester/api/v1/auth/login", payload: { password: passwords.shared, surface: "widget" },
    });
    assert.match(setCookie(widget), /; Path=\/tester; HttpOnly; Secure; SameSite=None; Partitioned$/);

    const cookie = setCookie(dashboard).split(";", 1)[0]!;
    const authenticated = await app.inject({ method: "GET", url: "/tester/api/v1/targets", headers: { cookie } });
    assert.equal(authenticated.statusCode, 200);

    const logout = await app.inject({
      method: "POST", url: "/tester/api/v1/auth/logout", headers: { cookie, origin: "https://gauntlet.test" },
    });
    assert.equal(logout.statusCode, 204);
    const cleared = setCookie(logout);
    assert.match(cleared, /Max-Age=0; Path=\/tester; HttpOnly; SameSite=Lax; Secure/);
    assert.match(cleared, /Max-Age=0; Path=\/tester; HttpOnly; Secure; SameSite=None; Partitioned/);
  });
});

test("without a base path the session cookie keeps Path=/", async () => {
  await usingApp({ basePath: "", auth: passwordAuth() }, async (app) => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/login", payload: { password: passwords.shared, surface: "dashboard" },
    });
    assert.match(setCookie(response), /; Path=\/; HttpOnly; SameSite=Lax$/);
  });
});

test("MCP is served at <basePath>/mcp", async (t: TestContext) => {
  const app = await createApp({
    environment: serverEnvironment, targets: [fakeTarget], fetch: createFakeAdapter().fetch,
    basePath: "/tester", mcp: { enabled: true },
  });
  t.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  assertRouteNotFound(await app.inject({ method: "POST", url: "/mcp", payload: {} }), "unprefixed MCP");
  const client = new Client({ name: "gauntlet-base-path-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/tester/mcp`)));
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "gauntlet_list_targets"));
});

test("base path injection replaces existing elements and finds a place without <head>", () => {
  assert.equal(
    injectBasePath("<!doctype html><html><head><base href=\"/\"><title>x</title></head></html>", "/a", { baseHref: true }),
    "<!doctype html><html><head><base href=\"/a/\"><meta name=\"gauntlet-base-path\" content=\"/a\"><title>x</title></head></html>",
  );
  assert.equal(
    injectBasePath("<!doctype html><html><body>x</body></html>", "/a", { baseHref: false }),
    "<!doctype html><html><meta name=\"gauntlet-base-path\" content=\"/a\"><body>x</body></html>",
  );
  assert.equal(injectBasePath("x", "/a", { baseHref: false }), "<meta name=\"gauntlet-base-path\" content=\"/a\">x");
  assert.equal(
    injectBasePath("<head>\n    <meta charset=\"utf-8\" />\n    <base href=\"/\" />\n    <meta name=\"gauntlet-base-path\" content=\"\" />\n    <title>x</title>\n</head>", "/a", { baseHref: true }),
    "<head><base href=\"/a/\"><meta name=\"gauntlet-base-path\" content=\"/a\">\n    <meta charset=\"utf-8\" />\n    <title>x</title>\n</head>",
  );
});
