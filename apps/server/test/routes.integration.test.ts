import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import {
  computeRevision,
  type AdapterManifest,
  type JsonObject,
  type Run,
} from "@8lines/gauntlet-protocol";
import { createApp } from "../src/app.js";
import { listenAddress } from "../src/main.js";
import { configureProblemResponses } from "../src/problem-response.js";
import {
  createFakeAdapter,
  createHappyManifest,
  createHappyOperation,
  createManifestWithEnvironment,
  createQueuedRun,
  fakeTarget,
  validCreateRunRequest,
} from "./support/fake-adapter.js";
import { serverEnvironment } from "./support/environment.js";

async function usingApp<T>(
  fake: ReturnType<typeof createFakeAdapter>,
  action: (app: Awaited<ReturnType<typeof createApp>>) => Promise<T>,
  options: Omit<Parameters<typeof createApp>[0], "environment" | "targets" | "fetch"> = {},
): Promise<T> {
  const app = await createApp({ environment: serverEnvironment, targets: [fakeTarget], fetch: fake.fetch, ...options });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

function isProblem(response: { headers: Record<string, string | string[] | undefined> }): boolean {
  return String(response.headers["content-type"]).startsWith("application/problem+json");
}

function routeCalls(fake: ReturnType<typeof createFakeAdapter>, fragment: string, method?: string): number {
  return fake.calls.filter(({ pathname, method: actual }) => pathname.includes(fragment) && (method === undefined || method === actual)).length;
}

async function multipartFile(
  contents: string,
  name: string,
  field = "file",
): Promise<{ readonly headers: { readonly "content-type": string }; readonly payload: Buffer }> {
  const form = new FormData();
  form.append(field, new Blob([contents], { type: "text/plain" }), name);
  const encoded = new Request("http://gauntlet.invalid", { method: "POST", body: form });
  const contentType = encoded.headers.get("content-type");
  assert.ok(contentType !== null);
  return {
    headers: { "content-type": contentType },
    payload: Buffer.from(await encoded.arrayBuffer()),
  };
}

async function rawHttpRequest(port: number, request: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.setTimeout(2_000, () => socket.destroy(new Error("raw HTTP request timed out")));
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("createApp is injectable, closable, and main defaults to the deployable listen address", async () => {
  assert.deepEqual(listenAddress({}), { host: "0.0.0.0", port: 8080 });
  const fake = createFakeAdapter();
  const app = await createApp({ environment: serverEnvironment, targets: [fakeTarget], fetch: fake.fetch });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});

test("readiness is local and never probes an unavailable target", async () => {
  const fake = createFakeAdapter({ responseFor: () => { throw new Error("target must not be contacted"); } });
  await usingApp(fake, async (app) => {
    const ready = await app.inject({ method: "GET", url: "/ready" });
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.deepEqual([ready.statusCode, ready.json()], [200, { status: "ready" }]);
    assert.deepEqual([health.statusCode, health.json()], [200, { status: "ok" }]);
    assert.equal(fake.calls.length, 0);
  });
});

test("SPA fallback accepts only HTML navigation outside every reserved namespace", async () => {
  const Fastify = (await import("fastify")).default;
  const app = Fastify({ logger: false });
  configureProblemResponses(app, { spaFallback: (_request, reply) => reply.code(200).send({ dashboard: true }) });
  try {
    const dashboard = await app.inject({ method: "GET", url: "/client/route", headers: { accept: "text/html" } });
    assert.deepEqual([dashboard.statusCode, dashboard.json()], [200, { dashboard: true }]);

    for (const url of [
      "/mcp", "/mcp/extra",
      "/api", "/api/extra",
      "/health", "/health/extra",
      "/ready", "/ready/extra",
      "/assets", "/assets/extra",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      assert.equal(response.statusCode, 404, url);
      assert.equal(response.json().type, "urn:gauntlet:problem:route-not-found", url);
    }

    const wildcard = await app.inject({ method: "GET", url: "/client/route", headers: { accept: "*/*" } });
    assert.equal(wildcard.statusCode, 404);
    assert.equal(wildcard.json().type, "urn:gauntlet:problem:route-not-found");
  } finally {
    await app.close();
  }
});

test("POST readiness is a 405 Problem with its GET allow-list", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const response = await app.inject({ method: "POST", url: "/ready" });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, "GET");
    assert.equal(response.json().type, "urn:gauntlet:problem:method-not-allowed");
  });
});

test("targets response has the public envelope and never exposes internal or public origins", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const response = await app.inject({ method: "GET", url: "/api/v1/targets" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(Object.keys(body), ["targets"]);
    assert.equal(body.targets[0].id, "acme");
    assert.equal(body.targets[0].state, "online");
    assert.equal("adapterUrl" in body.targets[0], false);
    assert.equal("publicUrl" in body.targets[0], false);
    assert.equal(response.body.includes("acme.internal"), false);
    assert.equal(response.body.includes("app.example.test"), false);
  });
});

test("raw target and run responses sanitize every nested adapter Problem", async () => {
  const sentinelUrl = "https://adapter.internal/nested-problem";
  const sentinelSecret = "nested-super-secret";
  const unsafeProblem = {
    type: "urn:gauntlet:problem:handler-failed" as const,
    title: sentinelSecret,
    status: 500,
    detail: sentinelUrl,
    instance: `${sentinelUrl}/instance`,
    errors: [{
      instancePath: sentinelUrl,
      schemaPath: `${sentinelUrl}#/${sentinelSecret}`,
      keyword: "handler",
      message: sentinelSecret,
      params: { secret: sentinelSecret },
    }],
  };
  const operation = createHappyOperation();
  const manifest = createHappyManifest(operation) as AdapterManifest & JsonObject;
  (manifest as unknown as { operations: Array<{ availability: unknown }> }).operations[0]!.availability = {
    state: "unavailable",
    problem: unsafeProblem,
  };
  (manifest as unknown as { manifestRevision: string }).manifestRevision = computeRevision(manifest, "manifestRevision");
  await usingApp(createFakeAdapter({ manifest, operation }), async (app) => {
    const response = await app.inject({ method: "GET", url: "/api/v1/targets" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes(sentinelUrl), false);
    assert.equal(response.body.includes(sentinelSecret), false);
  });

  const failed: Run = {
    ...createQueuedRun(operation),
    sequence: 1,
    state: "failed",
    updatedAt: "2026-08-29T12:00:01Z",
    completedAt: "2026-08-29T12:00:01Z",
    problem: unsafeProblem,
  };
  await usingApp(createFakeAdapter({ operation, createdRun: failed, polledRuns: [failed] }), async (app) => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(created.statusCode, 201);
    const polled = await app.inject({ method: "GET", url: `/api/v1/targets/acme/runs/${failed.id}` });
    assert.equal(polled.statusCode, 200);
    for (const response of [created, polled]) {
      assert.equal(response.body.includes(sentinelUrl), false);
      assert.equal(response.body.includes(sentinelSecret), false);
    }
  });
});

test("control plane proxies definition, active run creation, polling, data sources, and launch", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const running: Run = {
    ...queued,
    sequence: 1,
    state: "running",
    startedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
  };
  const fake = createFakeAdapter({ operation, createdRun: queued, polledRuns: [running] });
  await usingApp(fake, async (app) => {
    const definition = await app.inject({
      method: "GET",
      url: `/api/v1/targets/acme/operations/${operation.id}`,
    });
    assert.equal(definition.statusCode, 200);
    assert.equal(definition.json().revision, operation.revision);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(created.statusCode, 202);
    assert.equal(created.json().state, "queued");

    const polled = await app.inject({ method: "GET", url: "/api/v1/targets/acme/runs/run-1" });
    assert.equal(polled.statusCode, 200);
    assert.equal(polled.json().state, "running");

    const queried = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/data-sources/application-catalog/query",
      payload: { search: "portal", context: { requestId: "query-1" } },
    });
    assert.equal(queried.statusCode, 200);
    assert.equal(queried.json().items[0].value, "app-42");

    const resolved = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/data-sources/application-catalog/resolve",
      payload: { values: ["app-42", "missing-app"], context: { requestId: "resolve-1" } },
    });
    assert.equal(resolved.statusCode, 200);
    assert.equal(resolved.json().results[1].item, null);

    const launched = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/runs/run-1/artifacts/launch-1/launch",
    });
    assert.equal(launched.statusCode, 200);
    assert.equal(launched.json().singleUse, true);
  }, { clock: () => new Date("2026-08-29T12:00:00Z") });
});

test("environment mismatch blocks every valid proxy route before adapter dispatch", async () => {
  const manifest = createManifestWithEnvironment({ name: "other-dev", kind: "development" });
  const fake = createFakeAdapter({ manifest });
  await usingApp(fake, async (app) => {
    const routes = [
      { method: "GET", url: "/api/v1/targets/acme/operations/application-access-review" },
      {
        method: "POST",
        url: "/api/v1/targets/acme/operations/application-access-review/runs",
        payload: validCreateRunRequest,
      },
      { method: "GET", url: "/api/v1/targets/acme/runs/run-1" },
      { method: "POST", url: "/api/v1/targets/acme/runs/run-1/cancel" },
      { method: "GET", url: "/api/v1/targets/acme/runs/run-1/events" },
      {
        method: "POST",
        url: "/api/v1/targets/acme/uploads",
        ...await multipartFile("fixture", "fixture.txt"),
      },
      {
        method: "POST",
        url: "/api/v1/targets/acme/data-sources/application-catalog/query",
        payload: { search: "portal" },
      },
      {
        method: "POST",
        url: "/api/v1/targets/acme/data-sources/application-catalog/resolve",
        payload: { values: ["app-42"] },
      },
      {
        method: "POST",
        url: "/api/v1/targets/acme/runs/run-1/artifacts/launch-1/launch",
      },
    ] as const;

    for (const route of routes) {
      const response = await app.inject(route);
      assert.equal(response.statusCode, 503, `${route.method} ${route.url}`);
      assert.equal(response.json().type, "urn:gauntlet:problem:target-environment-mismatch", route.url);
    }
    assert.equal(fake.calls.every(({ pathname }) =>
      pathname === "/_gauntlet/v1/health"
      || pathname === "/_gauntlet/v1/manifest"), true);
  });
});

test("terminal run creation returns 201", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const terminal: Run = {
    ...queued,
    sequence: 2,
    state: "succeeded",
    updatedAt: "2026-08-29T12:00:02Z",
    completedAt: "2026-08-29T12:00:02Z",
  };
  const fake = createFakeAdapter({ operation, createdRun: terminal });
  await usingApp(fake, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().state, "succeeded");
  });
});

test("raw percent bytes and unsafe decoded IDs return 400 with zero target fetch", async () => {
  const paths = [
    "/api/v1/targets/j%65b/operations/application-access-review",
    "/api/v1/targets/acme/operations/application%2Daccess-review",
    "/api/v1/targets/acme/runs/run%2D1",
    "/api/v1/targets/j%65b/uploads",
    "/api/v1/targets/acme/runs/run%2D1/cancel",
    "/api/v1/targets/acme/runs/run%2D1/events",
    "/api/v1/targets/acme/data-sources/application%2Dcatalog/query",
    "/api/v1/targets/acme/runs/run-1/artifacts/launch%2D1/launch",
    "/api/v1/targets/acme%ZZ/operations/application-access-review",
    "/api/v1/targets/unsafe!/operations/application-access-review",
  ];
  for (const url of paths) {
    const fake = createFakeAdapter();
    await usingApp(fake, async (app) => {
      const response = await app.inject({ method: url.endsWith("query") || url.endsWith("launch") ? "POST" : "GET", url, payload: url.endsWith("query") ? {} : undefined });
      assert.equal(response.statusCode, 400, url);
      assert.equal(isProblem(response), true);
      assert.equal(response.json().type, "urn:gauntlet:problem:invalid-path");
      assert.equal(fake.calls.length, 0);
    });
  }
});

test("unknown target, operation, data source, run projection, and artifact return fixed 404 problems", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const cases = [
      ["GET", "/api/v1/targets/missing/operations/application-access-review"],
      ["GET", "/api/v1/targets/acme/operations/missing"],
      ["POST", "/api/v1/targets/acme/data-sources/missing/query"],
      ["GET", "/api/v1/targets/acme/runs/missing"],
      ["POST", "/api/v1/targets/acme/runs/missing/cancel"],
      ["GET", "/api/v1/targets/acme/runs/missing/events"],
      ["POST", "/api/v1/targets/acme/runs/missing/artifacts/launch-1/launch"],
    ] as const;
    for (const [method, url] of cases) {
      const response = await app.inject({ method, url, payload: method === "POST" && url.endsWith("query") ? {} : undefined });
      assert.equal(response.statusCode, 404, url);
      assert.equal(isProblem(response), true);
    }
    assert.equal(routeCalls(fake, "/operations/missing"), 0);
    assert.equal(routeCalls(fake, "/data-sources/missing"), 0);
    assert.equal(routeCalls(fake, "/runs/missing", "GET"), 0);
    assert.equal(routeCalls(fake, "/runs/missing/cancel", "POST"), 0);
    assert.equal(routeCalls(fake, "/runs/missing/events", "GET"), 0);
    assert.equal(routeCalls(fake, "/launch", "POST"), 0);
  });
});

test("malformed JSON, protocol-invalid bodies, and target-context mismatch have safe mappings", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const malformed = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${createHappyOperation().id}/runs`,
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().type, "urn:gauntlet:problem:invalid-json");
    assert.equal(malformed.body.includes("Unexpected"), false);

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${createHappyOperation().id}/runs`,
      payload: {},
    });
    assert.equal(invalid.statusCode, 422);

    const invalidResolve = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/data-sources/application-catalog/resolve",
      payload: {},
    });
    assert.equal(invalidResolve.statusCode, 422);

    const mismatched = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${createHappyOperation().id}/runs`,
      payload: {
        ...validCreateRunRequest,
        context: { ...validCreateRunRequest.context, target: { id: "other" } },
      },
    });
    assert.equal(mismatched.statusCode, 422);
    assert.equal(routeCalls(fake, "/runs", "POST"), 0);
  });
});

test("run confirmation is revision-bound at the control-plane route", async () => {
  const operation = createHappyOperation();
  const fake = createFakeAdapter({ operation });
  await usingApp(fake, async (app) => {
    const missing = structuredClone(validCreateRunRequest) as unknown as Record<string, unknown>;
    delete missing.confirmation;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: missing,
    });
    assert.equal(rejected.statusCode, 422);
    assert.deepEqual(rejected.json().errors, [{
      instancePath: "/confirmation",
      schemaPath: "#",
      keyword: "required",
      message: "Required value is missing",
      params: {},
    }]);
    assert.equal(routeCalls(fake, "/runs", "POST"), 0);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(accepted.statusCode, 202);
    const runCall = fake.calls.find(({ pathname, method }) => pathname.endsWith("/runs") && method === "POST");
    assert.deepEqual((runCall?.body as { confirmation?: unknown } | undefined)?.confirmation, validCreateRunRequest.confirmation);
    assert.equal((runCall?.body as { dryRun?: unknown } | undefined)?.dryRun, true);
  });
});

test("a POST without a supported JSON media type returns a fixed 415 Problem", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${createHappyOperation().id}/runs`,
      headers: { "content-type": "application/xml" },
      payload: "<request>https://private.internal/secret</request>",
    });
    assert.equal(response.statusCode, 415);
    assert.equal(response.json().type, "urn:gauntlet:problem:unsupported-media-type");
    assert.equal(response.body.includes("private.internal"), false);
    assert.equal(fake.calls.length, 0);
  });
});

test("empty JSON and mismatched Content-Length map to fixed safe 400 Problems", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const url = `/api/v1/targets/acme/operations/${createHappyOperation().id}/runs`;
    const empty = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().type, "urn:gauntlet:problem:invalid-json");
    assert.equal(empty.body.includes("Body cannot be empty"), false);

    for (const declaredLength of [1, 3]) {
      const mismatch = await app.inject({
        method: "POST",
        url,
        headers: {
          "content-type": "application/json",
          "content-length": String(declaredLength),
        },
        payload: "{}",
      });
      assert.equal(mismatch.statusCode, 400, `declared Content-Length ${declaredLength}`);
      assert.equal(mismatch.json().type, "urn:gauntlet:problem:invalid-request");
      assert.equal(mismatch.body.includes("Content-Length"), false);
    }
    assert.equal(fake.calls.length, 0);
  });
});

test("real HTTP parser failures return credential-free RFC 9457 documents", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address !== null && typeof address === "object");
    const url = `/api/v1/targets/acme/operations/${createHappyOperation().id}/runs`;

    const empty = await fetch(`http://127.0.0.1:${address.port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.headers.get("content-type")?.startsWith("application/problem+json"), true);
    assert.equal((await empty.json() as { type: string }).type, "urn:gauntlet:problem:invalid-json");

    for (const declaredLength of [1, 3]) {
      const response = await rawHttpRequest(address.port, [
        `POST ${url} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Content-Type: application/json",
        `Content-Length: ${declaredLength}`,
        "Connection: close",
        "",
        "{}",
      ].join("\r\n"));
      const [head, body = ""] = response.split("\r\n\r\n", 2);
      assert.match(head ?? "", /^HTTP\/1\.1 400 /);
      assert.match(head ?? "", /content-type: application\/problem\+json/i);
      assert.equal(JSON.parse(body).type, "urn:gauntlet:problem:invalid-request");
      assert.equal(body.includes("Content-Length"), false);
      assert.equal(body.includes(url), false);
    }
    assert.equal(fake.calls.length, 0);
  });
});

test("payload limit, route-not-found, and method-not-allowed are normalized Problems", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/data-sources/application-catalog/query",
      payload: { search: "x".repeat(1024) },
    });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(isProblem(tooLarge), true);

    const missing = await app.inject({ method: "GET", url: "/api/v1/no-such-route" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().type, "urn:gauntlet:problem:route-not-found");

    const method = await app.inject({ method: "DELETE", url: "/api/v1/targets" });
    assert.equal(method.statusCode, 405);
    assert.equal(method.json().type, "urn:gauntlet:problem:method-not-allowed");
  }, { bodyLimit: 128 });
});

test("unsafe dynamic IDs keep 400 precedence over unsupported methods", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const cases = [
      ["DELETE", "/api/v1/targets/unsafe!/operations/application-access-review", 400],
      ["DELETE", "/api/v1/targets/acme/operations/unsafe!", 400],
      ["PUT", "/api/v1/targets/acme/runs/unsafe!", 400],
      ["DELETE", "/api/v1/targets/unsafe!/uploads", 400],
      ["PUT", "/api/v1/targets/acme/runs/unsafe!/cancel", 400],
      ["POST", "/api/v1/targets/acme/runs/unsafe!/events", 400],
      ["PATCH", "/api/v1/targets/acme/runs/run-1/artifacts/unsafe!/launch", 400],
      ["DELETE", "/api/v1/targets/acme/operations/application-access-review", 405],
      ["GET", "/api/v1/targets/acme/uploads", 405],
      ["GET", "/api/v1/targets/acme/runs/run-1/cancel", 405],
      ["POST", "/api/v1/targets/acme/runs/run-1/events", 405],
    ] as const;

    for (const [method, url, status] of cases) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, status, `${method} ${url}`);
      assert.equal(
        response.json().type,
        status === 400
          ? "urn:gauntlet:problem:invalid-path"
          : "urn:gauntlet:problem:method-not-allowed",
      );
    }
    assert.equal(fake.calls.length, 0);
  });
});

test("adapter Problems retain safe status while invalid and unavailable responses become 502 and 503", async () => {
  const operation = createHappyOperation();
  const problemFake = createFakeAdapter({
    responseFor: (call) => call.method === "POST" && call.pathname.endsWith("/runs")
      ? Response.json({
          type: "urn:gauntlet:problem:validation-failed",
          title: "Adapter rejected https://private.internal/secret",
          status: 422,
          detail: "Exception at https://private.internal/secret with token",
          instance: "https://private.internal/problem/1",
        }, { status: 422, headers: { "content-type": "application/problem+json" } })
      : undefined,
  });
  await usingApp(problemFake, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().type, "urn:gauntlet:problem:validation-failed");
    assert.equal(response.json().title, "Request validation failed");
    assert.equal(response.body.includes("private.internal"), false);
    assert.equal("detail" in response.json(), false);
    assert.equal("instance" in response.json(), false);
  });

  const invalidFake = createFakeAdapter({
    responseFor: (call) => call.pathname.includes("/operations/") && call.method === "GET"
      ? new Response("sensitive raw upstream text", { status: 200, headers: { "content-type": "text/plain" } })
      : undefined,
  });
  await usingApp(invalidFake, async (app) => {
    const response = await app.inject({ method: "GET", url: `/api/v1/targets/acme/operations/${operation.id}` });
    assert.equal(response.statusCode, 502);
    assert.equal(response.body.includes("sensitive"), false);
  });

  const offlineFake = createFakeAdapter({ responseFor: () => { throw new Error("private network error"); } });
  await usingApp(offlineFake, async (app) => {
    const response = await app.inject({ method: "GET", url: `/api/v1/targets/acme/operations/${operation.id}` });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes("private network"), false);
  });
});

test("remote validation errors preserve only a safe field pointer across the public Problem boundary", async () => {
  const sentinelUrl = "https://adapter.internal/private-schema";
  const sentinelSecret = "validation-super-secret";
  const fake = createFakeAdapter({
    responseFor: (call) => call.method === "POST" && call.pathname.endsWith("/runs")
      ? Response.json({
          type: "urn:gauntlet:problem:validation-failed",
          title: "Rejected",
          status: 422,
          errors: [{
            instancePath: "/applicationId",
            schemaPath: `${sentinelUrl}#/${sentinelSecret}`,
            keyword: "required",
            message: sentinelSecret,
            params: { secret: sentinelSecret },
          }],
        }, { status: 422, headers: { "content-type": "application/problem+json" } })
      : undefined,
  });

  await usingApp(fake, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${createHappyOperation().id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.includes(sentinelUrl), false);
    assert.equal(response.body.includes(sentinelSecret), false);
    assert.deepEqual(response.json().errors, [{
      instancePath: "/applicationId",
      schemaPath: "#",
      keyword: "required",
      message: "Required value is missing",
      params: {},
    }]);
  });
});

test("target-state Problems are sanitized before entering the public snapshot", async () => {
  const fake = createFakeAdapter({
    responseFor: (call) => call.pathname.endsWith("/health")
      ? Response.json({
          type: "urn:gauntlet:problem:adapter-unavailable",
          title: "Failed at https://adapter.internal/private",
          status: 503,
          detail: "socket exception secret",
          instance: "https://adapter.internal/problem/1",
        }, { status: 503, headers: { "content-type": "application/problem+json" } })
      : undefined,
  });
  await usingApp(fake, async (app) => {
    const response = await app.inject({ method: "GET", url: "/api/v1/targets" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().targets[0].state, "offline");
    assert.equal(response.body.includes("adapter.internal"), false);
    assert.equal(response.body.includes("socket exception"), false);
  });
});

test("unknown requirements remain operation-local and never invoke the definition", async () => {
  const operation = createHappyOperation();
  const manifest = createHappyManifest(operation) as AdapterManifest & JsonObject;
  (manifest as unknown as { profiles: string[] }).profiles.push("urn:future-ui@1");
  (manifest as unknown as { operations: Array<{ requirements: unknown }> }).operations[0]!.requirements = {
    profiles: ["urn:future-ui@1"],
  };
  (manifest as unknown as { manifestRevision: string }).manifestRevision = computeRevision(manifest, "manifestRevision");
  const fake = createFakeAdapter({ manifest, operation });
  await usingApp(fake, async (app) => {
    const unsupported = await app.inject({ method: "GET", url: `/api/v1/targets/acme/operations/${operation.id}` });
    assert.equal(unsupported.statusCode, 501);
    assert.equal(routeCalls(fake, `/operations/${operation.id}`), 0);

    const targets = await app.inject({ method: "GET", url: "/api/v1/targets" });
    assert.equal(targets.statusCode, 200);
    assert.equal(targets.json().targets[0].state, "online");
  });
});

test("definition mismatch, stale revision, and undeclared data source stop the corresponding upstream action", async () => {
  const operation = createHappyOperation();
  const changed = structuredClone(operation);
  (changed as unknown as JsonObject & { label: string; revision: string }).label = "Changed";
  (changed as unknown as JsonObject & { revision: string }).revision = computeRevision(changed as unknown as JsonObject);
  const mismatchManifest = createHappyManifest(changed);
  (mismatchManifest as unknown as { operations: Array<{ label: string }> }).operations[0]!.label = operation.label;
  (mismatchManifest as unknown as JsonObject & { manifestRevision: string }).manifestRevision = computeRevision(mismatchManifest as unknown as JsonObject, "manifestRevision");
  const mismatchFake = createFakeAdapter({ manifest: mismatchManifest, operation: changed });
  await usingApp(mismatchFake, async (app) => {
    const response = await app.inject({ method: "GET", url: `/api/v1/targets/acme/operations/${operation.id}` });
    assert.equal(response.statusCode, 502);
  });

  const staleFake = createFakeAdapter();
  await usingApp(staleFake, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: { ...validCreateRunRequest, operationRevision: `sha256:${"a".repeat(64)}` },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(routeCalls(staleFake, "/runs", "POST"), 0);

    const dataSource = await app.inject({ method: "POST", url: "/api/v1/targets/acme/data-sources/not-declared/query", payload: {} });
    assert.equal(dataSource.statusCode, 404);
    assert.equal(routeCalls(staleFake, "/data-sources/not-declared"), 0);
  });
});

test("control capabilities proxy a bounded upload, resumable SSE, and monotonic cancellation", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const running: Run = {
    ...queued,
    sequence: 1,
    state: "running",
    startedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
  };
  const cancelled: Run = {
    ...running,
    sequence: 2,
    state: "cancelled",
    updatedAt: "2026-08-29T12:00:02Z",
    completedAt: "2026-08-29T12:00:02Z",
    problem: { type: "urn:gauntlet:problem:run-cancelled", title: "Run cancelled", status: 409 },
  };
  const fake = createFakeAdapter({
    operation,
    createdRun: queued,
    cancelledRun: cancelled,
    events: [{
      id: "event-1",
      sequence: running.sequence,
      occurredAt: running.updatedAt,
      type: "run.updated",
      run: running,
    }],
  });
  await usingApp(fake, async (app) => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/uploads",
      ...await multipartFile("fixture", "fixture.txt"),
    });
    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().file.uploadId, "upload-1");

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(created.statusCode, 202);

    const events = await app.inject({
      method: "GET",
      url: "/api/v1/targets/acme/runs/run-1/events",
      headers: { "last-event-id": "event-previous" },
    });
    assert.equal(events.statusCode, 200);
    assert.equal(String(events.headers["content-type"]).startsWith("text/event-stream"), true);
    assert.match(events.body, /^id: event-1\nevent: run\.updated\ndata: /);
    assert.equal(events.body.includes('"sequence":1'), true);

    const cancelledResponse = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/runs/run-1/cancel",
    });
    assert.equal(cancelledResponse.statusCode, 202);
    assert.equal(cancelledResponse.json().state, "cancelled");

    const eventCall = fake.calls.find(({ pathname }) => pathname.endsWith("/events"));
    assert.equal(eventCall?.headers.get("last-event-id"), "event-previous");
  });
});

test("invalid upload framing, event cursor, and body limits fail before capability dispatch", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const wrongField = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/uploads",
      ...await multipartFile("fixture", "fixture.txt", "wrong"),
    });
    assert.equal(wrongField.statusCode, 400);
    assert.equal(wrongField.json().type, "urn:gauntlet:problem:invalid-request");

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/uploads",
      headers: { "content-type": "multipart/form-data; boundary=broken" },
      payload: "private multipart failure text",
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().type, "urn:gauntlet:problem:invalid-request");

    const cursor = await app.inject({
      method: "GET",
      url: "/api/v1/targets/acme/runs/run-1/events",
      headers: { "last-event-id": "unsafe cursor" },
    });
    assert.equal(cursor.statusCode, 400);
    assert.equal(cursor.json().type, "urn:gauntlet:problem:invalid-path");
    assert.equal(fake.calls.length, 0);
  });

  const limited = createFakeAdapter();
  await usingApp(limited, async (app) => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/uploads",
      ...await multipartFile("x".repeat(256), "fixture.txt"),
    });
    assert.equal(upload.statusCode, 413);
    assert.equal(upload.json().type, "urn:gauntlet:problem:payload-too-large");
    assert.equal(limited.calls.length, 0);
  }, { maxUploadBytes: 128 });
});

test("upload capacity is independently bounded from the smaller JSON body limit", async () => {
  const contents = "x".repeat(1024 * 1024 + 1);
  const fake = createFakeAdapter({
    upload: {
      file: {
        kind: "file",
        uploadId: "upload-large",
        name: "large.txt",
        mediaType: "text/plain",
        sizeBytes: contents.length,
        expiresAt: "2026-08-29T13:00:00Z",
      },
    },
  });
  await usingApp(fake, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/uploads",
      ...await multipartFile(contents, "large.txt"),
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().file.sizeBytes, contents.length);
  }, { bodyLimit: 128 });
});

test("unsupported control-plane capabilities return 501 without invoking their adapter routes", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/targets/acme/uploads",
      ...await multipartFile("fixture", "fixture.txt"),
    });
    assert.equal(upload.statusCode, 501);
    assert.equal(upload.json().capability, "tc-uploads@1");
    assert.equal(routeCalls(fake, "/uploads", "POST"), 0);
  }, { supportedCapabilities: ["tc-session-launch@1"] });
});

test("SSE emits only validated monotonic events when the upstream stream later regresses", async () => {
  const operation = createHappyOperation();
  const queued = createQueuedRun(operation);
  const running: Run = {
    ...queued,
    sequence: 1,
    state: "running",
    startedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
  };
  const validEvent = {
    id: "event-1",
    sequence: 1,
    occurredAt: running.updatedAt,
    type: "run.updated" as const,
    run: running,
  };
  const regression = {
    id: "event-2",
    sequence: 0,
    occurredAt: queued.updatedAt,
    type: "run.updated" as const,
    run: queued,
  };
  const fake = createFakeAdapter({
    operation,
    createdRun: queued,
    responseFor: (call) => call.pathname.endsWith("/events")
      ? new Response([
          `id: event-1\nevent: run.updated\ndata: ${JSON.stringify(validEvent)}\n\n`,
          `id: event-2\nevent: run.updated\ndata: ${JSON.stringify(regression)}\n\n`,
        ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
      : undefined,
  });
  await usingApp(fake, async (app) => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${operation.id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(created.statusCode, 202);
    const events = await app.inject({
      method: "GET",
      url: "/api/v1/targets/acme/runs/run-1/events",
    });
    assert.equal(events.statusCode, 200);
    assert.equal(events.body.includes("id: event-1"), true);
    assert.equal(events.body.includes("id: event-2"), false);
  });
});

test("a client disconnect during the adapter SSE handshake cancels the late upstream stream", async () => {
  const handshakeStarted = deferred();
  let transportCancellations = 0;
  const upstreamBody = new ReadableStream<Uint8Array>({
    cancel() {
      transportCancellations += 1;
    },
  });
  const fake = createFakeAdapter({
    responseFor: async (call) => {
      if (!call.pathname.endsWith("/events")) return undefined;
      handshakeStarted.resolve();
      await new Promise((resolve) => setTimeout(resolve, 75));
      return new Response(upstreamBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  await usingApp(fake, async (app) => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/targets/acme/operations/${createHappyOperation().id}/runs`,
      payload: validCreateRunRequest,
    });
    assert.equal(created.statusCode, 202);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address !== null && typeof address === "object");
    const socket = connect({ host: "127.0.0.1", port: address.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write([
          "GET /api/v1/targets/acme/runs/run-1/events HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"));
        resolve();
      });
    });
    await handshakeStarted.promise;
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 175));
    const observed = transportCancellations;
    if (observed === 0 && !upstreamBody.locked) await upstreamBody.cancel();
    assert.equal(observed, 1);
  });
});

test("the public surface has no arbitrary adapter-fetch or command route", async () => {
  const fake = createFakeAdapter();
  await usingApp(fake, async (app) => {
    for (const url of [
      "/api/v1/targets/acme/fetch",
      "/api/v1/targets/acme/commands/arbitrary",
    ]) {
      const response = await app.inject({ method: "POST", url, payload: {} });
      assert.equal(response.statusCode, 404);
    }
    assert.equal(fake.calls.length, 0);
  });
});
