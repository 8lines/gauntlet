import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { widgetConfigDocument, widgetFramePolicy } from "../src/widget.js";
import { fakeTarget } from "./support/fake-adapter.js";
import { serverEnvironment } from "./support/environment.js";

const PANEL = "<!doctype html><html><body>widget panel fixture</body></html>";
const LOADER = "globalThis.gauntletLoaderFixture = true;";

const shop = {
  ...fakeTarget,
  id: "shop",
  widget: { origins: ["https://shop.dev.example", "http://localhost:5173"] },
};
const admin = {
  ...fakeTarget,
  id: "admin",
  widget: { origins: ["https://shop.dev.example"] },
};
const plain = { ...fakeTarget, id: "plain" };

async function writeFixture(root: string, path: string, contents: string): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
}

async function usingWidgetDirectory<T>(
  action: (dir: string) => Promise<T>,
  files: Readonly<Record<string, string>> = {
    "index.html": PANEL,
    "loader.js": LOADER,
    "assets/panel-abc12345.js": "globalThis.panel = true;",
    "assets/plain.js": "globalThis.plain = true;",
  },
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-widget-"));
  try {
    for (const [path, contents] of Object.entries(files)) await writeFixture(root, path, contents);
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function usingApp<T>(
  options: Partial<Parameters<typeof createApp>[0]>,
  action: (app: Awaited<ReturnType<typeof createApp>>) => Promise<T>,
): Promise<T> {
  const app = await createApp({ environment: serverEnvironment, targets: [shop, admin, plain], ...options });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

function assertNotFound(response: { statusCode: number; json(): unknown }, label: string): void {
  assert.equal(response.statusCode, 404, label);
  assert.equal((response.json() as { type: string }).type, "urn:gauntlet:problem:route-not-found", label);
}

test("config document lists targets with origins in configuration order", () => {
  assert.deepEqual(widgetConfigDocument([shop, admin, plain] as never), {
    targets: {
      shop: ["https://shop.dev.example", "http://localhost:5173"],
      admin: ["https://shop.dev.example"],
    },
  });
});

test("panel frame policy is the sorted de-duplicated origin union or 'none'", () => {
  assert.equal(
    widgetFramePolicy([shop, admin, plain] as never),
    "frame-ancestors http://localhost:5173 https://shop.dev.example",
  );
  assert.equal(widgetFramePolicy([plain] as never), "frame-ancestors 'none'");
});

test("an enabled widget serves loader, panel, config and assets with the specified headers", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      const loader = await app.inject({ method: "GET", url: "/widget/loader.js" });
      assert.equal(loader.statusCode, 200);
      assert.equal(loader.body, LOADER);
      assert.match(String(loader.headers["content-type"]), /^text\/javascript; charset=utf-8$/);
      assert.equal(loader.headers["cross-origin-resource-policy"], "cross-origin");
      assert.equal(loader.headers["cache-control"], "no-cache");
      assert.equal(loader.headers["x-content-type-options"], "nosniff");
      assert.match(String(loader.headers.etag), /^"[A-Za-z0-9_-]{16,}"$/);
      assert.equal(loader.headers["access-control-allow-origin"], undefined);

      const panel = await app.inject({ method: "GET", url: "/widget/", headers: { accept: "text/html" } });
      assert.equal(panel.statusCode, 200);
      assert.equal(panel.body, PANEL);
      assert.match(String(panel.headers["content-type"]), /^text\/html; charset=utf-8$/);
      assert.equal(
        panel.headers["content-security-policy"],
        "frame-ancestors http://localhost:5173 https://shop.dev.example",
      );
      assert.equal(panel.headers["cache-control"], "no-cache");
      assert.match(String(panel.headers.etag), /^"[A-Za-z0-9_-]{16,}"$/);

      const config = await app.inject({ method: "GET", url: "/widget/config.json" });
      assert.equal(config.statusCode, 200);
      assert.match(String(config.headers["content-type"]), /^application\/json; charset=utf-8$/);
      assert.equal(config.headers["cache-control"], "no-cache");
      assert.deepEqual(config.json(), {
        targets: {
          shop: ["https://shop.dev.example", "http://localhost:5173"],
          admin: ["https://shop.dev.example"],
        },
      });

      const hashed = await app.inject({ method: "GET", url: "/widget/assets/panel-abc12345.js" });
      assert.equal(hashed.statusCode, 200);
      assert.equal(hashed.headers["cache-control"], "public, max-age=31536000, immutable");
      const unhashed = await app.inject({ method: "GET", url: "/widget/assets/plain.js" });
      assert.equal(unhashed.statusCode, 200);
      assert.equal(unhashed.headers["cache-control"], "no-cache");
    });
  });
});

test("only an exact ETag match returns 304", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      for (const url of ["/widget/loader.js", "/widget/"]) {
        const first = await app.inject({ method: "GET", url });
        const etag = String(first.headers.etag);
        const cached = await app.inject({ method: "GET", url, headers: { "if-none-match": etag } });
        assert.equal(cached.statusCode, 304, url);
        assert.equal(cached.body, "", url);
        assert.equal(cached.headers.etag, etag, url);
        for (const stale of ["\"stale\"", "garbage", `W/${etag}`, ""]) {
          const fresh = await app.inject({ method: "GET", url, headers: { "if-none-match": stale } });
          assert.equal(fresh.statusCode, 200, `${url} ${stale}`);
          assert.equal(fresh.body, first.body, `${url} ${stale}`);
        }
      }
    });
  });
});

test("unknown widget paths and non-GET methods never reach the panel or the SPA", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      for (const request of [
        { method: "GET", url: "/widget", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/other", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/index.html", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/assets/missing.js" },
        { method: "POST", url: "/widget/loader.js" },
        { method: "POST", url: "/widget/config.json" },
      ] as const) {
        const response = await app.inject(request);
        assert.ok([404, 405].includes(response.statusCode), `${request.method} ${request.url}`);
        assert.match(String(response.headers["content-type"]), /^application\/problem\+json/);
        assert.equal(response.body.includes("widget panel fixture"), false);
      }
    });
  });
});

test("a disabled widget returns 404 for every widget path and never reads the directory", async () => {
  for (const options of [{}, { widget: { enabled: false } }, { widget: { enabled: false, dir: "/nonexistent" } }]) {
    await usingApp(options, async (app) => {
      for (const url of ["/widget", "/widget/", "/widget/loader.js", "/widget/config.json", "/widget/assets/x.js"]) {
        assertNotFound(await app.inject({ method: "GET", url, headers: { accept: "text/html" } }), url);
      }
    });
  }
});

test("an enabled widget requires a directory with regular index.html and loader.js", async () => {
  await usingWidgetDirectory(async (root) => {
    await mkdir(join(root, "only-index"));
    await writeFile(join(root, "only-index", "index.html"), PANEL);
    await mkdir(join(root, "loader-dir", "loader.js"), { recursive: true });
    await writeFile(join(root, "loader-dir", "index.html"), PANEL);
    for (const widget of [
      { enabled: true },
      { enabled: true, dir: join(root, "missing") },
      { enabled: true, dir: join(root, "only-index") },
      { enabled: true, dir: join(root, "loader-dir") },
    ]) {
      await assert.rejects(
        createApp({ environment: serverEnvironment, targets: [shop], widget }),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.equal(error.message, "Widget files are missing");
          assert.equal(error.message.includes(root), false);
          return true;
        },
      );
    }
  }, {});
});

test("an enabled widget without assets directory still serves loader and panel", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      assert.equal((await app.inject({ method: "GET", url: "/widget/loader.js" })).statusCode, 200);
      assertNotFound(await app.inject({ method: "GET", url: "/widget/assets/panel-abc12345.js" }), "no assets");
    });
  }, { "index.html": PANEL, "loader.js": LOADER });
});

test("html widget assets send a frame-ancestors 'none' content-security-policy", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      const html = await app.inject({ method: "GET", url: "/widget/assets/legal.html" });
      assert.equal(html.statusCode, 200);
      assert.equal(html.headers["content-security-policy"], "frame-ancestors 'none'");

      const script = await app.inject({ method: "GET", url: "/widget/assets/plain.js" });
      assert.equal(script.statusCode, 200);
      assert.equal(script.headers["content-security-policy"], undefined);
    });
  }, {
    "index.html": PANEL,
    "loader.js": LOADER,
    "assets/legal.html": "<!doctype html><title>legal</title>",
    "assets/plain.js": "globalThis.plain = true;",
  });
});

test("registerWidget rejects a non-boolean enabled flag", async () => {
  for (const widget of [{ enabled: "true" }, { enabled: 1 }, { enabled: null }, {}]) {
    await assert.rejects(
      createApp({ environment: serverEnvironment, targets: [shop], widget: widget as never }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, "Invalid widget options");
        return true;
      },
      JSON.stringify(widget),
    );
  }
});

test("a dashboard and an enabled widget register their own static plugins without colliding", async () => {
  const DASHBOARD_INDEX = "<!doctype html><html><body>dashboard fixture</body></html>";
  await usingWidgetDirectory(async (widgetDir) => {
    const dashboardDir = await mkdtemp(join(tmpdir(), "gauntlet-dashboard-"));
    try {
      await writeFixture(dashboardDir, "index.html", DASHBOARD_INDEX);
      await writeFixture(dashboardDir, "assets/app-abc12345.js", "globalThis.dashboard = true;");
      const app = await createApp({
        environment: serverEnvironment,
        targets: [shop, admin, plain],
        dashboardDir,
        widget: { enabled: true, dir: widgetDir },
      });
      try {
        const root = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
        assert.equal(root.statusCode, 200);
        assert.equal(root.body, DASHBOARD_INDEX);
        assert.equal(root.headers["content-security-policy"], "frame-ancestors 'none'");

        const dashboardAsset = await app.inject({ method: "GET", url: "/assets/app-abc12345.js" });
        assert.equal(dashboardAsset.statusCode, 200);

        const panel = await app.inject({ method: "GET", url: "/widget/", headers: { accept: "text/html" } });
        assert.equal(panel.statusCode, 200);
        assert.equal(panel.body, PANEL);
        assert.equal(
          panel.headers["content-security-policy"],
          "frame-ancestors http://localhost:5173 https://shop.dev.example",
        );

        const widgetAsset = await app.inject({ method: "GET", url: "/widget/assets/panel-abc12345.js" });
        assert.equal(widgetAsset.statusCode, 200);
        assert.equal(widgetAsset.headers["cache-control"], "public, max-age=31536000, immutable");

        const loader = await app.inject({ method: "GET", url: "/widget/loader.js" });
        assert.equal(loader.statusCode, 200);
      } finally {
        await app.close();
      }
    } finally {
      await rm(dashboardDir, { recursive: true, force: true });
    }
  });
});
