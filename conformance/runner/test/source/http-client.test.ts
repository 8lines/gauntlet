import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdapterV1HttpClient,
  ConfigurationError,
  ConformanceFailure,
  serializeJsonRequest,
} from "../../src/http-client.js";
import { startHttpServer } from "../support/http-server.js";

const REVISION = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
  });
}

function problemResponse(
  status: number,
  type: string,
  extra: Record<string, unknown> = {},
  contentType = "application/problem+json; charset=utf-8",
): Response {
  return new Response(JSON.stringify({ type, title: "Expected problem", status, ...extra }), {
    status,
    headers: { "content-type": contentType },
  });
}

test("base origins, timeout bounds, response caps, and safe IDs fail before Fetch", async () => {
  for (const baseUrl of [
    " http://example.test",
    "http://example.test/extra",
    "http://user:pass@example.test",
    "http://example.test?query=1",
    "ftp://example.test",
  ]) {
    assert.throws(() => new AdapterV1HttpClient({ baseUrl }), ConfigurationError);
  }
  for (const requestTimeoutMs of [0, 2_147_483_648, 1.5]) {
    assert.throws(() => new AdapterV1HttpClient({ baseUrl: "http://example.test", requestTimeoutMs }), ConfigurationError);
  }
  for (const maxResponseBytes of [0, 4_194_305, 1.5]) {
    assert.throws(() => new AdapterV1HttpClient({ baseUrl: "http://example.test", maxResponseBytes }), ConfigurationError);
  }

  let calls = 0;
  const client = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    fetch: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(client.getOperation("unsafe!id"), ConfigurationError);
  await assert.rejects(client.getRun("unsafe!id"), ConfigurationError);
  assert.equal(calls, 0);
});

test("fixed calls preserve methods, routes, headers, conditional tags, and serialized request bytes", async () => {
  const calls: Array<{ url: string; init: RequestInit; bytes?: Uint8Array }> = [];
  const fetchDouble: typeof fetch = async (input, init) => {
    const bytes = init?.body === undefined ? undefined : new Uint8Array(await new Response(init.body).arrayBuffer());
    calls.push({ url: String(input), init: init ?? {}, ...(bytes === undefined ? {} : { bytes }) });
    const url = String(input);
    if (url.endsWith("/manifest") && new Headers(init?.headers).has("if-none-match")) {
      return new Response(null, { status: 304, headers: { etag: `"${REVISION}"` } });
    }
    if (url.endsWith("/manifest")) {
      return jsonResponse({ manifestRevision: REVISION }, { headers: { etag: `"${REVISION}"` } });
    }
    return jsonResponse({ ok: true });
  };
  const client = new AdapterV1HttpClient({ baseUrl: "https://adapter.example.test", fetch: fetchDouble });
  await client.getHealth((value) => value);
  await client.getManifest((value) => value as { readonly manifestRevision: string });
  await client.getManifest((value) => value, `"${REVISION}"`);
  const body = serializeJsonRequest("dataSourceQuery", { search: "Brown", limit: 2 });
  await client.queryDataSource("pending-applications", body, (value) => value);

  assert.deepEqual(calls.map(({ url, init }) => [init.method, url]), [
    ["GET", "https://adapter.example.test/_gauntlet/v1/health"],
    ["GET", "https://adapter.example.test/_gauntlet/v1/manifest"],
    ["GET", "https://adapter.example.test/_gauntlet/v1/manifest"],
    ["POST", "https://adapter.example.test/_gauntlet/v1/data-sources/pending-applications/query"],
  ]);
  assert.equal(new Headers(calls[0]!.init.headers).get("accept"), "application/json, application/problem+json");
  assert.equal(new Headers(calls[0]!.init.headers).has("content-type"), false);
  assert.equal(new Headers(calls[2]!.init.headers).get("if-none-match"), `"${REVISION}"`);
  assert.equal(new Headers(calls[3]!.init.headers).get("content-type"), "application/json");
  assert.deepEqual(calls[3]!.bytes, body.bytes);
});

test("manifest and operation 200 responses require exact strong revision ETags", async () => {
  for (const etag of [undefined, `W/"${REVISION}"`, '"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"', "malformed"]) {
    const client = new AdapterV1HttpClient({
      baseUrl: "http://example.test",
      fetch: async () => jsonResponse(
        { manifestRevision: REVISION },
        { headers: etag === undefined ? {} : { etag } },
      ),
    });
    await assert.rejects(client.getManifest((value) => value as { readonly manifestRevision: string }), ConformanceFailure);
  }

  const operationClient = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    fetch: async () => jsonResponse({ revision: REVISION }, { headers: { etag: `"${REVISION}"` } }),
  });
  const operation = await operationClient.getOperation(
    "safe-operation",
    (value) => value as { readonly revision: string },
  );
  assert.equal(operation.etag, `"${REVISION}"`);
});

test("conditional 304 is unsolicited-proof, bodyless, media-free, and tag-stable", async () => {
  const cases: Response[] = [
    new Response(null, { status: 304 }),
    new Response(null, { status: 304, headers: { "content-type": "application/json" } }),
    new Response(null, { status: 304, headers: { "content-length": "1" } }),
    new Response(null, { status: 304, headers: { "transfer-encoding": "chunked" } }),
    new Response(null, { status: 304, headers: { etag: '"different"' } }),
  ];
  const unsolicited = new AdapterV1HttpClient({ baseUrl: "http://example.test", fetch: async () => cases[0]! });
  await assert.rejects(unsolicited.getManifest((value) => value), ConformanceFailure);

  for (const response of cases.slice(1)) {
    const client = new AdapterV1HttpClient({ baseUrl: "http://example.test", fetch: async () => response });
    await assert.rejects(client.getManifest((value) => value, `"${REVISION}"`), ConformanceFailure);
  }

  const valid = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    fetch: async () => new Response(null, {
      status: 304,
      headers: { etag: `"${REVISION}"`, "content-length": "00" },
    }),
  });
  assert.equal((await valid.getManifest((value) => value, `"${REVISION}"`)).notModified, true);
});

test("success and error media, Problem status, type, and capability are exact", async () => {
  const wrongSuccessMedia = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/problem+json" } }),
  });
  await assert.rejects(wrongSuccessMedia.getHealth((value) => value), /GET .*expected 200\/application\/json, received 200\/application\/problem\+json/);

  for (const response of [
    problemResponse(404, "urn:gauntlet:problem:operation-not-found", {}, "application/json"),
    problemResponse(404, "urn:gauntlet:problem:operation-not-found", { status: 400 }),
    problemResponse(404, "urn:gauntlet:problem:run-not-found"),
  ]) {
    const client = new AdapterV1HttpClient({ baseUrl: "http://example.test", fetch: async () => response });
    await assert.rejects(
      client.expectOperationProblem("conformance-missing-operation", 404, "urn:gauntlet:problem:operation-not-found"),
      ConformanceFailure,
    );
  }

  const capabilityClient = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    fetch: async () => problemResponse(501, "urn:gauntlet:problem:unsupported-capability", {
      capability: "tc-run-sse@1",
    }),
  });
  await capabilityClient.expectEventsProblem(
    "conformance-missing-run",
    501,
    "urn:gauntlet:problem:unsupported-capability",
    "tc-run-sse@1",
  );
});

test("malformed JSON, UTF-8, lone surrogates, lengths, streams, and non-Responses fail safely", async () => {
  const responses: Array<Response | object> = [
    new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { status: 200, headers: { "content-type": "application/json" } }),
    new Response('{"value":"\\ud800"}', { status: 200, headers: { "content-type": "application/json" } }),
    new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "-1" } }),
    new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "1, 2" } }),
    new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "3" } }),
    {},
  ];
  for (const response of responses) {
    const client = new AdapterV1HttpClient({
      baseUrl: "http://example.test",
      maxResponseBytes: 2,
      fetch: (async () => response) as typeof fetch,
    });
    await assert.rejects(client.getHealth((value) => value), (error: unknown) => {
      assert.ok(error instanceof ConformanceFailure);
      assert.match(
        error.message,
        /^GET \/_gauntlet\/v1\/health: expected 200\/application\/json, received /,
      );
      return true;
    });
  }

  const streamed = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    maxResponseBytes: 2,
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.enqueue(new Uint8Array([0x20]));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(streamed.getHealth((value) => value), (error: unknown) => {
    assert.ok(error instanceof ConformanceFailure);
    assert.match(
      error.message,
      /^GET \/_gauntlet\/v1\/health: expected 200\/application\/json, received /,
    );
    return true;
  });

  const leadingZeroLength = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    fetch: async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "02" },
    }),
  });
  assert.deepEqual(await leadingZeroLength.getHealth((value) => value), {});

  const nonSettlingCancel = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    maxResponseBytes: 2,
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0x7b, 0x7d, 0x20]));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const cancellationOutcome = await Promise.race([
    nonSettlingCancel.getHealth((value) => value).then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  assert.equal(cancellationOutcome, "rejected");
});

test("request documents are canonical, schema-valid, and capped before Fetch", async () => {
  assert.throws(() => serializeJsonRequest("dataSourceQuery", { search: "\ud800" }), ConfigurationError);
  assert.throws(() => serializeJsonRequest("dataSourceQuery", { limit: 0 }), ConfigurationError);
  assert.throws(
    () => serializeJsonRequest("dataSourceQuery", { search: "x".repeat(4 * 1024 * 1024) }),
    ConfigurationError,
  );
  assert.doesNotThrow(() => serializeJsonRequest("dataSourceQuery", { search: "🚀" }));
});

test("redirects, stalled headers, stalled bodies, and non-Response doubles respect one deadline", async (t) => {
  let mode: "redirect" | "slow-headers" | "slow-body" = "redirect";
  const server = await startHttpServer((request, response) => {
    if (mode === "redirect") {
      response.writeHead(302, { location: request.url }).end();
      return;
    }
    if (mode === "slow-headers") {
      setTimeout(() => response.writeHead(200, { "content-type": "application/json" }).end("{}"), 200);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    setTimeout(() => response.end("}"), 200);
  });
  t.after(() => server.close());

  for (mode of ["redirect", "slow-headers", "slow-body"] as const) {
    const client = new AdapterV1HttpClient({ baseUrl: server.origin, requestTimeoutMs: 20 });
    await assert.rejects(client.getHealth((value) => value), ConformanceFailure);
  }
});

test("raw and JSON-escaped secret echoes fail with value-free diagnostics", async () => {
  const sentinel = "731904";
  const responses = [
    new Response("{}", { status: 200, headers: { "content-type": "application/json", "x-echo": sentinel } }),
    new Response(`{"echo":"${sentinel}"}`, { status: 200, headers: { "content-type": "application/json" } }),
    new Response('{"echo":"731\\u003904"}', { status: 200, headers: { "content-type": "application/json" } }),
  ];
  for (const response of responses) {
    const client = new AdapterV1HttpClient({
      baseUrl: "http://example.test",
      secretSentinels: [sentinel],
      fetch: async () => response,
    });
    await assert.rejects(client.getHealth((value) => value), (error: unknown) => {
      assert.match((error as Error).message, /protected secret/i);
      assert.doesNotMatch((error as Error).message, new RegExp(sentinel));
      return true;
    });
  }
});

test("the one unsafe path probe is literal and isolated from the safe route builder", async () => {
  let requested = "";
  const client = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    fetch: async (input) => {
      requested = String(input);
      return problemResponse(400, "urn:gauntlet:problem:invalid-path");
    },
  });
  await client.expectUnsafeOperationProblem();
  assert.equal(requested, "http://example.test/_gauntlet/v1/operations/unsafe!id");
});

test("disabled precedence permits trusted ingress to own only the encoded unsafe path", async () => {
  const requested: string[] = [];
  const client = new AdapterV1HttpClient({
    baseUrl: "http://example.test",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      requested.push(path);
      if (path.includes("unsafe%21id")) {
        return problemResponse(400, "urn:gauntlet:problem:invalid-path");
      }
      return problemResponse(503, "urn:gauntlet:problem:adapter-disabled");
    },
  });

  await client.expectAdapterDisabledPrecedence("agency-applications.fail");
  assert.deepEqual(requested, [
    "/_gauntlet/v1/health",
    "/_gauntlet/v1/manifest",
    "/_gauntlet/v1/operations/unsafe%21id/runs",
    "/_gauntlet/v1/uploads",
    "/_gauntlet/v1/operations/agency-applications.fail/runs",
  ]);
});
