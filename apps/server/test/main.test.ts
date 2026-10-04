import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConfiguredApp, listenAddress } from "../src/main.js";

const fixture = async (name: string): Promise<Uint8Array> =>
  await readFile(new URL(`../../../config/fixtures/${name}`, import.meta.url));

/**
 * `config.valid.yaml` enables the widget, so booting it requires a real
 * `GAUNTLET_WIDGET_DIR`. Tests that only care about non-widget behavior use
 * this fixture directory rather than a bespoke document without `widget`.
 */
async function usingWidgetDir<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "gauntlet-main-widget-"));
  try {
    await writeFile(join(dir, "index.html"), "<!doctype html><title>panel</title>");
    await writeFile(join(dir, "loader.js"), "void 0;");
    return await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("configured composition validates configuration before exposing health and readiness", async () => {
  await usingWidgetDir(async (widgetDir) => {
    const app = await createConfiguredApp(
      { GAUNTLET_CONFIG_FILE: "/config.yaml", GAUNTLET_WIDGET_DIR: widgetDir },
      { readConfig: async () => await fixture("config.valid.yaml") },
    );
    try {
      assert.deepEqual((await app.inject({ method: "GET", url: "/health" })).json(), { status: "ok" });
      assert.deepEqual((await app.inject({ method: "GET", url: "/ready" })).json(), { status: "ready" });
    } finally {
      await app.close();
    }
  });
});

test("invalid configured composition never returns an HTTP app", async () => {
  await assert.rejects(
    createConfiguredApp(
      { GAUNTLET_CONFIG_FILE: "/config.yaml" },
      { readConfig: async () => Buffer.from("version: 1\ninstance: {}\ntargets: []\n") },
    ),
  );
});

test("configured composition mounts MCP only when explicitly enabled", async () => {
  await usingWidgetDir(async (widgetDir) => {
    const app = await createConfiguredApp(
      { GAUNTLET_CONFIG_FILE: "/config.yaml", GAUNTLET_MCP_ENABLED: "true", GAUNTLET_WIDGET_DIR: widgetDir },
      { readConfig: async () => await fixture("config.valid.yaml") },
    );
    try {
      assert.equal((await app.inject({ method: "GET", url: "/mcp" })).statusCode, 405);
      assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: { origin: "null" } })).statusCode, 403);
    } finally {
      await app.close();
    }
  });
});

test("configured composition serves the widget from GAUNTLET_WIDGET_DIR only when enabled", async () => {
  await usingWidgetDir(async (dir) => {
    const app = await createConfiguredApp(
      { GAUNTLET_CONFIG_FILE: "/config.yaml", GAUNTLET_WIDGET_DIR: dir },
      { readConfig: async () => await fixture("config.valid.yaml") },
    );
    try {
      const config = await app.inject({ method: "GET", url: "/widget/config.json" });
      assert.deepEqual(config.json(), { targets: { billing: ["https://dev.billing.example"] } });
    } finally {
      await app.close();
    }
    await assert.rejects(
      createConfiguredApp(
        { GAUNTLET_CONFIG_FILE: "/config.yaml" },
        { readConfig: async () => await fixture("config.valid.yaml") },
      ),
      /Widget files are missing/,
    );
  });
});

test("listen configuration defaults inherited values and refuses hostile own values", () => {
  const inherited = Object.create({ GAUNTLET_HOST: "127.0.0.1", GAUNTLET_PORT: "9090" }) as Record<string, string | undefined>;
  assert.deepEqual(listenAddress(inherited), { host: "0.0.0.0", port: 8080 });

  let accessed = false;
  const hostile = {} as Record<string, string | undefined>;
  Object.defineProperty(hostile, "GAUNTLET_HOST", {
    enumerable: true,
    get: () => {
      accessed = true;
      throw new Error("do not expose this value");
    },
  });
  assert.throws(() => listenAddress(hostile), /Invalid server environment configuration/);
  assert.equal(accessed, false);
});

test("configured composition refuses an own dashboard accessor without invoking it", async () => {
  let accessed = false;
  const environment = { GAUNTLET_CONFIG_FILE: "/config.yaml" } as Record<string, string | undefined>;
  Object.defineProperty(environment, "GAUNTLET_DASHBOARD_DIR", {
    enumerable: true,
    get: () => {
      accessed = true;
      return "/private/dashboard";
    },
  });

  await assert.rejects(
    createConfiguredApp(environment, { readConfig: async () => await fixture("config.valid.yaml") }),
    /Invalid server environment configuration/,
  );
  assert.equal(accessed, false);
});

test("configured composition refuses password authentication without a strong secret", async () => {
  const salt = Buffer.alloc(16, 1).toString("base64url");
  const document = {
    version: 1,
    instance: { name: "qa", environment: { name: "qa", kind: "qa" } },
    targets: [{ id: "shop", label: "Shop", adapterUrl: "http://shop:8080", expectedEnvironment: { name: "qa", kind: "qa" } }],
    auth: {
      mode: "password",
      publicUrl: "http://localhost:8080",
      password: { shared: { hash: `scrypt$16384$8$1$${salt}$${Buffer.alloc(32, 2).toString("base64url")}` } },
    },
  };
  const readConfig = async () => new TextEncoder().encode(JSON.stringify(document));
  await assert.rejects(createConfiguredApp({ GAUNTLET_CONFIG_FILE: "/c.json" }, { readConfig }), /GAUNTLET_AUTH_SECRET/);
  await assert.rejects(
    createConfiguredApp({ GAUNTLET_CONFIG_FILE: "/c.json", GAUNTLET_AUTH_SECRET: "ab".repeat(16) }, { readConfig }),
    /Invalid authentication secret/,
  );
  const app = await createConfiguredApp(
    { GAUNTLET_CONFIG_FILE: "/c.json", GAUNTLET_AUTH_SECRET: "ab".repeat(32) },
    { readConfig },
  );
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  } finally {
    await app.close();
  }
});
