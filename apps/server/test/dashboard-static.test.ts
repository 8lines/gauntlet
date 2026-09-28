import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { fakeTarget } from "./support/fake-adapter.js";
import { serverEnvironment } from "./support/environment.js";

const INDEX = "<!doctype html><html><body>dashboard fixture</body></html>";

async function writeFixture(root: string, path: string, contents: string): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
}

async function usingDashboardDirectory<T>(
  action: (dashboardDir: string) => Promise<T>,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-dashboard-"));
  try {
    await writeFixture(root, "index.html", INDEX);
    await writeFixture(root, "assets/app-abc12345.js", "globalThis.dashboard = true;");
    await writeFixture(root, "assets/app-abcdefg.js", "globalThis.shortHash = true;");
    await writeFixture(root, "assets/plain.js", "globalThis.plain = true;");
    await writeFixture(root, "assets/page-abcdefgh.html", "<!doctype html><title>asset</title>");
    await writeFixture(root, "outside-deadbeef.js", "globalThis.outside = true;");
    for (const [path, contents] of Object.entries(extraFiles)) {
      await writeFixture(root, path, contents);
    }
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function usingDashboardApp<T>(
  dashboardDir: string,
  action: (app: Awaited<ReturnType<typeof createApp>>) => Promise<T>,
): Promise<T> {
  const app = await createApp({
    environment: serverEnvironment,
    targets: [fakeTarget],
    dashboardDir,
  });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

function assertRouteNotFound(response: {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}, label: string): void {
  assert.equal(response.statusCode, 404, label);
  assert.match(String(response.headers["content-type"]), /^application\/problem\+json/, label);
  assert.deepEqual(response.json(), {
    type: "urn:gauntlet:problem:route-not-found",
    title: "Route not found",
    status: 404,
  }, label);
}

test("serves root, hashed assets, and extensionless browser routes", async () => {
  await usingDashboardDirectory(async (dashboardDir) => {
    await usingDashboardApp(dashboardDir, async (app) => {
      const root = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
      assert.equal(root.statusCode, 200);
      assert.equal(root.body, INDEX);
      assert.match(String(root.headers["content-type"]), /^text\/html/);
      assert.equal(root.headers["content-security-policy"], "frame-ancestors 'none'");

      const route = await app.inject({
        method: "GET",
        url: "/t/portal/o/change-date",
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      assert.equal(route.statusCode, 200);
      assert.equal(route.body, INDEX);
      assert.equal(route.headers["content-security-policy"], "frame-ancestors 'none'");

      const asset = await app.inject({ method: "GET", url: "/assets/app-abc12345.js" });
      assert.equal(asset.statusCode, 200);
      assert.equal(asset.body, "globalThis.dashboard = true;");
      assert.match(String(asset.headers["content-type"]), /^(?:text|application)\/javascript/);
    });
  });
});

test("hashed assets and problem documents do not carry the dashboard frame policy", async () => {
  await usingDashboardDirectory(async (dashboardDir) => {
    await usingDashboardApp(dashboardDir, async (app) => {
      const asset = await app.inject({ method: "GET", url: "/assets/app-abc12345.js" });
      assert.equal(asset.statusCode, 200);
      assert.equal(asset.headers["content-security-policy"], undefined);
      const api = await app.inject({ method: "GET", url: "/api/v1/targets" });
      assert.equal(api.headers["content-security-policy"], undefined);
      assert.equal(api.headers["access-control-allow-origin"], undefined);
    });
  });
});

test("applies immutable caching only to normalized Vite-hashed asset paths", async () => {
  await usingDashboardDirectory(async (dashboardDir) => {
    await usingDashboardApp(dashboardDir, async (app) => {
      const cases = [
        ["/", "no-cache"],
        ["/t/portal/o/change-date", "no-cache"],
        ["/assets/app-abc12345.js", "public, max-age=31536000, immutable"],
        ["/assets/app-abcdefg.js", "no-cache"],
        ["/assets/plain.js", "no-cache"],
        ["/assets/page-abcdefgh.html", "no-cache"],
        ["/outside-deadbeef.js", "no-cache"],
      ] as const;

      for (const [url, cacheControl] of cases) {
        const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
        assert.equal(response.statusCode, 200, url);
        assert.equal(response.headers["cache-control"], cacheControl, url);
      }
    });
  });
});

test("serves the SPA only for an explicit valid HTML media range", async () => {
  await usingDashboardDirectory(async (dashboardDir) => {
    await usingDashboardApp(dashboardDir, async (app) => {
      const accepted = [
        "text/html",
        "TEXT/HTML",
        "application/json, Text/Html ; charset=utf-8",
        "text/html; profile=\"https://example.test/a,b\"",
        "text/html; note=\"a;b\"",
        "text/html;q=0.001",
        "text/plain;q=0, text/html; Q=1.000",
      ];
      for (const accept of accepted) {
        const response = await app.inject({ method: "GET", url: "/client/route", headers: { accept } });
        assert.equal(response.statusCode, 200, accept);
        assert.equal(response.body, INDEX, accept);
      }

      const rejected: Array<string | undefined> = [
        undefined,
        "",
        "*/*",
        "application/xhtml+xml",
        "text/htmlish",
        "application/text/html",
        "text/html;q=0",
        "text/html;q=0.000",
        "text/html;q=1.001",
        "text/html;q=0.0001",
        "text/html;q=invalid",
        "text/html;q=0.5;q=1",
        "text/html;broken",
        "text/html, not a media range",
        "text/html; profile=\"unterminated",
      ];
      for (const accept of rejected) {
        const response = await app.inject({
          method: "GET",
          url: "/client/route",
          ...(accept === undefined ? {} : { headers: { accept } }),
        });
        assertRouteNotFound(response, accept ?? "missing Accept");
      }
    });
  });
});

test("reserved namespaces and unsupported methods never fall through to static files or the SPA", async () => {
  const sentinel = "must never be served";
  await usingDashboardDirectory(async (dashboardDir) => {
    await usingDashboardApp(dashboardDir, async (app) => {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.deepEqual([health.statusCode, health.json()], [200, { status: "ok" }]);
      const ready = await app.inject({ method: "GET", url: "/ready" });
      assert.deepEqual([ready.statusCode, ready.json()], [200, { status: "ready" }]);

      for (const request of [
        { method: "GET", url: "/mcp", headers: { accept: "text/html" } },
        { method: "GET", url: "/api", headers: { accept: "text/html" } },
        { method: "GET", url: "/api/sentinel", headers: { accept: "text/html" } },
        { method: "GET", url: "/health/sentinel", headers: { accept: "text/html" } },
        { method: "GET", url: "/ready/sentinel", headers: { accept: "text/html" } },
        { method: "GET", url: "/assets", headers: { accept: "text/html" } },
        { method: "GET", url: "/assets/missing.js", headers: { accept: "text/html" } },
        { method: "POST", url: "/t/portal/o/change-date", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/loader.js", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/config.json", headers: { accept: "*/*" } },
      ]) {
        const response = await app.inject(request);
        assertRouteNotFound(response, `${request.method} ${request.url}`);
        assert.equal(response.body.includes(sentinel), false, request.url);
      }
    });
  }, {
    mcp: sentinel,
    api: sentinel,
    health: sentinel,
    ready: sentinel,
    widget: sentinel,
  });

  await usingDashboardDirectory(async (dashboardDir) => {
    await usingDashboardApp(dashboardDir, async (app) => {
      for (const url of ["/mcp/sentinel", "/api/sentinel", "/health/sentinel", "/ready/sentinel", "/widget/sentinel"]) {
        const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
        assertRouteNotFound(response, url);
        assert.equal(response.body.includes(sentinel), false, url);
      }
    });
  }, {
    "mcp/sentinel": sentinel,
    "api/sentinel": sentinel,
    "health/sentinel": sentinel,
    "ready/sentinel": sentinel,
    "widget/sentinel": sentinel,
    "widget/index.html": sentinel,
    "widget/loader.js": sentinel,
  });
});

test("invalid raw percent paths remain 400 before SPA fallback", async () => {
  await usingDashboardDirectory(async (dashboardDir) => {
    await usingDashboardApp(dashboardDir, async (app) => {
      for (const url of ["/client/%ZZ", "/client/%2froute", "/assets/app-%61bc12345.js"]) {
        const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
        assert.equal(response.statusCode, 400, url);
        assert.equal(response.json().type, "urn:gauntlet:problem:invalid-path", url);
      }
    });
  });
});

test("an explicit dashboard directory must contain a regular index.html", async () => {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-invalid-dashboard-"));
  try {
    const empty = join(root, "empty");
    const indexDirectory = join(root, "index-directory");
    await mkdir(empty);
    await mkdir(join(indexDirectory, "index.html"), { recursive: true });

    for (const dashboardDir of [join(root, "missing"), empty, indexDirectory]) {
      await assert.rejects(
        createApp({ environment: serverEnvironment, targets: [fakeTarget], dashboardDir }),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.equal(error.message, "Dashboard index is missing");
          assert.equal(error.message.includes(root), false);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omitting the dashboard directory starts a headless server", async () => {
  const app = await createApp({ environment: serverEnvironment, targets: [fakeTarget] });
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.deepEqual([health.statusCode, health.json()], [200, { status: "ok" }]);
    const route = await app.inject({ method: "GET", url: "/client/route", headers: { accept: "text/html" } });
    assertRouteNotFound(route, "headless navigation");
  } finally {
    await app.close();
  }
});
