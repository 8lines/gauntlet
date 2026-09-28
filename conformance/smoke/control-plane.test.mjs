import assert from "node:assert/strict";
import { test } from "node:test";

const FETCH_TIMEOUT_MS = 5_000;

function configuredOrigin() {
  const value = process.env.GAUNTLET_URL;
  assert.ok(value !== undefined && value.length > 0, "GAUNTLET_URL is required for the smoke test");
  assert.equal(/[\u0000-\u0020\u007f]/.test(value), false, "GAUNTLET_URL must not contain whitespace or controls");
  assert.equal(/[\\?#@]/.test(value), false, "GAUNTLET_URL must contain only an origin");
  const scheme = /^https?:\/\//i.exec(value);
  assert.ok(scheme !== null, "GAUNTLET_URL must use HTTP(S)");
  const remainder = value.slice(scheme[0].length);
  const pathIndex = remainder.indexOf("/");
  const authority = pathIndex === -1 ? remainder : remainder.slice(0, pathIndex);
  const rawPath = pathIndex === -1 ? "" : remainder.slice(pathIndex);
  assert.ok(authority.length > 0 && (rawPath === "" || rawPath === "/"), "GAUNTLET_URL must contain only an origin");

  let url;
  try {
    url = new URL(value);
  } catch {
    assert.fail("GAUNTLET_URL must be an absolute HTTP(S) origin");
  }

  assert.ok(url.protocol === "http:" || url.protocol === "https:", "GAUNTLET_URL must use HTTP(S)");
  assert.equal(url.username, "", "GAUNTLET_URL must not contain credentials");
  assert.equal(url.password, "", "GAUNTLET_URL must not contain credentials");
  assert.equal(url.pathname, "/", "GAUNTLET_URL must not contain a path");
  assert.equal(url.search, "", "GAUNTLET_URL must not contain a query");
  assert.equal(url.hash, "", "GAUNTLET_URL must not contain a fragment");
  return url.origin;
}

function assertNoInternalTransport(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoInternalTransport);
    return;
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      assert.equal(value.includes("fake-adapter-a:8081"), false, "internal adapter origins must not be exposed");
      assert.equal(value.includes("fake-adapter-b:8081"), false, "internal adapter origins must not be exposed");
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    assert.notEqual(key, "adapterUrl", "adapterUrl must remain server-side");
    assert.notEqual(key, "publicUrl", "publicUrl must remain server-side");
    assertNoInternalTransport(nested);
  }
}

async function discoverTargets(origin) {
  let response;
  try {
    response = await fetch(`${origin}/api/v1/targets`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`Gauntlet is unavailable at ${origin}`, { cause });
  }

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/i);
  const body = await response.json();
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
  assert.deepEqual(Object.keys(body), ["targets"]);
  assert.ok(Array.isArray(body.targets));
  assert.equal(body.targets.length, 2);
  assert.deepEqual(body.targets.map(({ id }) => id), ["fixture-a", "fixture-b"]);
  assert.deepEqual(body.targets.map(({ state }) => state), ["online", "online"]);
  assert.deepEqual(
    body.targets.map(({ expectedEnvironment }) => expectedEnvironment),
    [
      { name: "compose-smoke", kind: "test" },
      { name: "compose-smoke", kind: "test" },
    ],
  );
  for (const target of body.targets) {
    assert.ok(target !== null && typeof target === "object" && !Array.isArray(target));
    assert.equal(target.manifest?.application?.environment?.name, "compose-smoke");
    assert.equal(target.manifest?.application?.environment?.kind, "test");
  }
  assertNoInternalTransport(body);
  return body.targets;
}

test("GAUNTLET_URL accepts only literal origin syntax", () => {
  const original = process.env.GAUNTLET_URL;
  try {
    for (const invalid of [
      " http://127.0.0.1:8080",
      "http://127.0.0.1:8080/.",
      "http://127.0.0.1:8080?",
      "http://127.0.0.1:8080#",
      "http://127.0.0.1:8080\\",
    ]) {
      process.env.GAUNTLET_URL = invalid;
      assert.throws(configuredOrigin, undefined, invalid);
    }

    process.env.GAUNTLET_URL = "https://example.test:443/";
    assert.equal(configuredOrigin(), "https://example.test");
  } finally {
    if (original === undefined) {
      delete process.env.GAUNTLET_URL;
    } else {
      process.env.GAUNTLET_URL = original;
    }
  }
});

test("the product image serves health, dashboard assets and two isolated adapters", { timeout: 10_000 }, async () => {
  const origin = configuredOrigin();
  for (const route of ["/health", "/ready"]) {
    const response = await fetch(`${origin}${route}`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/i);
    assertNoInternalTransport(await response.json());
  }

  const index = await fetch(`${origin}/`, {
    headers: { accept: "text/html" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /^text\/html(?:;|$)/i);
  assert.match(index.headers.get("cache-control") ?? "", /no-cache/i);
  const html = await index.text();
  assertNoInternalTransport(html);
  const assets = [...html.matchAll(/\b(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)]
    .map((match) => match[1]);
  assert.ok(assets.some((path) => path.endsWith(".js")), "dashboard HTML must reference JavaScript");
  assert.ok(assets.some((path) => path.endsWith(".css")), "dashboard HTML must reference CSS");
  for (const asset of new Set(assets)) {
    assert.match(asset, /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/);
    const response = await fetch(`${origin}${asset}`, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get("cache-control") ?? "", /immutable/i);
  }

  const first = await discoverTargets(origin);
  const second = await discoverTargets(origin);
  assert.deepEqual(
    second.map(({ manifest }) => manifest?.manifestRevision),
    first.map(({ manifest }) => manifest?.manifestRevision),
  );
});
