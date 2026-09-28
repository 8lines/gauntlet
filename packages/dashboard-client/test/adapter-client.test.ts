import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CreateRunRequest,
  DataSourceQuery,
  DataSourceResolveRequest,
} from "@8lines/gauntlet-protocol";
import {
  createAdapterClient,
  type ClientFailureKind,
  validateCreateRunRequest,
} from "../src/index.js";
import {
  jsonResponse,
  problemResponse,
  target,
  validCreateRunRequest,
  validDataSourcePage,
  validDataSourceQuery,
  validHealth,
  validMinorForwardManifest,
  validOperation,
  validProblem,
  validResolveRequest,
  validResolveResponse,
  validRun,
  validRunEvent,
  validSessionLaunch,
  validUpload,
} from "./support/fixtures.js";

const invalidPathProblem = {
  type: "urn:gauntlet:problem:invalid-path",
  title: "Invalid adapter path",
  status: 400,
} as const;

const invalidResponseProblem = {
  type: "urn:gauntlet:problem:adapter-invalid-response",
  title: "Invalid adapter response",
  status: 502,
} as const;

const protocolMajorMismatchKind: ClientFailureKind = "protocol-major-mismatch";
const incompatibleProtocolProblem = {
  type: "urn:gauntlet:problem:adapter-protocol-incompatible",
  title: "Incompatible adapter protocol",
  status: 502,
} as const;

const requestValidationProblem = {
  type: "urn:gauntlet:problem:validation-failed",
  title: "Request validation failed",
  status: 422,
} as const;

const loneHighSurrogate = "\ud800";

function withInvalidScalar<T extends object>(value: T): T {
  return {
    ...structuredClone(value),
    extensions: { "urn:gauntlet:test:unicode": loneHighSurrogate },
  } as T;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("unsafe path IDs are rejected before fetch", async () => {
  let calls = 0;
  const client = createAdapterClient({
    fetch: async () => {
      calls += 1;
      return Response.json(validOperation);
    },
  });

  const result = await client.getOperation(target, "a/b ?c");

  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problem, invalidPathProblem);
  assert.equal(calls, 0);
});

test("validated IDs are appended verbatim as safe path segments", async () => {
  let requested = "";
  const client = createAdapterClient({
    fetch: async (input) => {
      requested = String(input);
      return jsonResponse(validOperation);
    },
  });

  const result = await client.getOperation(target, "review:1.0");

  assert.equal(result.ok, false, "the fixture identity intentionally differs from the requested ID");
  assert.equal(new URL(requested).pathname, "/_gauntlet/v1/operations/review:1.0");
  assert.equal(requested.includes("%3A"), false);
});

test("session launch uses the fixed run artifact route", async () => {
  let requested = "";
  const client = createAdapterClient({
    fetch: async (input) => {
      requested = String(input);
      return Response.json(validSessionLaunch, { status: 201 });
    },
  });
  const result = await client.createSessionLaunch(target, "run-1", "launch-1");
  assert.equal(result.ok, true);
  assert.equal(new URL(requested).pathname, "/_gauntlet/v1/runs/run-1/artifacts/launch-1/launch");
});

test("session launch accepts only the canonical 201 success status", async () => {
  for (const [status, expectedOk] of [[201, true], [200, false]] as const) {
    const client = createAdapterClient({
      fetch: async () => jsonResponse(validSessionLaunch, status),
    });

    const result = await client.createSessionLaunch(target, "run-1", "launch-1");

    assert.equal(result.ok, expectedOk, `status ${status}`);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("upload and cancellation use their fixed multipart and run routes", async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const responses = [jsonResponse(validUpload, 201), jsonResponse(validRun, 202)];
  const client = createAdapterClient({
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return responses.shift()!;
    },
  });

  const upload = await client.createUpload(
    target,
    new Blob([new Uint8Array(128)], { type: "text/plain" }),
    "fixture.txt",
  );
  const cancel = await client.cancelRun(target, validRun.id);

  assert.equal(upload.ok, true);
  assert.equal(cancel.ok, true);
  assert.deepEqual(requests.map(({ url, init }) => [new URL(url).pathname, init?.method]), [
    ["/_gauntlet/v1/uploads", "POST"],
    [`/_gauntlet/v1/runs/${validRun.id}/cancel`, "POST"],
  ]);
  const form = requests[0]?.init?.body;
  assert.equal(form instanceof FormData, true);
  if (form instanceof FormData) {
    const entries = [...form.entries()];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.[0], "file");
    assert.equal(entries[0]?.[1] instanceof Blob, true);
    assert.equal((entries[0]?.[1] as File).name, "fixture.txt");
  }
});

test("run SSE parses split frames, forwards Last-Event-ID, and cancels upstream", async () => {
  const running = {
    ...validRunEvent,
    id: "event-02",
    sequence: 1,
    occurredAt: "2026-08-29T12:00:01Z",
    run: {
      ...validRunEvent.run,
      sequence: 1,
      state: "running",
      startedAt: "2026-08-29T12:00:01Z",
      updatedAt: "2026-08-29T12:00:01Z",
    },
  } as const;
  const body = [validRunEvent, running]
    .map((event) => `id: ${event.id}\r\nevent: run.updated\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  const bytes = new TextEncoder().encode(body);
  let cancelled = 0;
  let observedHeader: string | null = null;
  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }
      controller.close();
    },
    cancel() {
      cancelled += 1;
    },
  });
  const client = createAdapterClient({
    fetch: async (_input, init) => {
      observedHeader = new Headers(init?.headers).get("last-event-id");
      return new Response(responseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  const result = await client.streamRunEvents(target, validRunEvent.run.id, "event-previous");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const events = [];
  for await (const event of result.value) events.push(event);
  assert.deepEqual(events, [validRunEvent, running]);
  assert.equal(observedHeader, "event-previous");
  await result.value.cancel();
  assert.equal(cancelled, 0, "a completely consumed stream needs no transport cancellation");
});

test("run SSE rejects a regressing snapshot and closes without exposing remote data", async () => {
  const first = {
    ...validRunEvent,
    id: "event-02",
    sequence: 1,
    occurredAt: "2026-08-29T12:00:01Z",
    run: {
      ...validRunEvent.run,
      sequence: 1,
      state: "running",
      startedAt: "2026-08-29T12:00:01Z",
      updatedAt: "2026-08-29T12:00:01Z",
    },
  } as const;
  const body = [first, validRunEvent]
    .map((event) => `id: ${event.id}\nevent: run.updated\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  let cancelled = 0;
  const client = createAdapterClient({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
      },
      cancel() {
        cancelled += 1;
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });

  const result = await client.streamRunEvents(target, validRunEvent.run.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const iterator = result.value[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: first });
  await assert.rejects(iterator.next(), (error: Error) => {
    assert.equal(error.message, "Adapter event stream failed");
    assert.equal(error.message.includes("remote"), false);
    return true;
  });
  assert.equal(cancelled, 1);
});

test("run SSE rejects a lone surrogate before envelope and transition semantics", async () => {
  const hostileEvent = {
    ...validRunEvent,
    run: {
      ...validRunEvent.run,
      output: { note: loneHighSurrogate },
    },
  };
  const client = createAdapterClient({
    fetch: async () => new Response(
      `id: ${hostileEvent.id}\nevent: run.updated\ndata: ${JSON.stringify(hostileEvent)}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ),
  });

  const result = await client.streamRunEvents(target, validRunEvent.run.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await assert.rejects(
    result.value[Symbol.asyncIterator]().next(),
    /event stream failed/i,
  );
});

test("run SSE rejects negative zero before envelope and transition semantics", async () => {
  const encoded = JSON.stringify(validRunEvent);
  const hostile = encoded.replace('"sequence":0', '"sequence":-0');
  assert.notEqual(hostile, encoded, "fixture must expose a zero sequence");
  const client = createAdapterClient({
    fetch: async () => new Response(
      `id: ${validRunEvent.id}\nevent: run.updated\ndata: ${hostile}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ),
  });

  const result = await client.streamRunEvents(target, validRunEvent.run.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await assert.rejects(
    result.value[Symbol.asyncIterator]().next(),
    /event stream failed/i,
  );
});

test("run SSE freezes yielded snapshots so caller mutation cannot rewrite transition history", async () => {
  const running = {
    ...validRunEvent,
    id: "event-02",
    sequence: 1,
    occurredAt: "2026-08-29T12:00:01Z",
    run: {
      ...validRunEvent.run,
      sequence: 1,
      state: "running",
      startedAt: "2026-08-29T12:00:01Z",
      updatedAt: "2026-08-29T12:00:01Z",
    },
  } as const;
  const body = [running, validRunEvent]
    .map((event) => `id: ${event.id}\nevent: run.updated\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const client = createAdapterClient({
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const result = await client.streamRunEvents(target, validRunEvent.run.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const iterator = result.value[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  if (first.done) return;
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.run), true);
  assert.equal(Object.isFrozen(first.value.run.artifacts), true);
  assert.throws(() => {
    (first.value.run as unknown as { sequence: number }).sequence = 0;
  }, TypeError);
  await assert.rejects(iterator.next(), /event stream failed/i);
});

test("cancelling SSE after a yield closes the generator and releases its reader lock", async () => {
  let transportCancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `id: ${validRunEvent.id}\nevent: run.updated\ndata: ${JSON.stringify(validRunEvent)}\n\n`,
      ));
    },
    cancel() {
      transportCancellations += 1;
    },
  });
  const client = createAdapterClient({
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const result = await client.streamRunEvents(target, validRunEvent.run.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const iterator = result.value[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  assert.equal(body.locked, true);
  await result.value.cancel();
  assert.equal(body.locked, false);
  assert.equal(transportCancellations, 1);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("invalid SSE cursors and oversized uploads fail before Fetch", async () => {
  let calls = 0;
  const client = createAdapterClient({
    maxUploadBytes: 3,
    fetch: async () => {
      calls += 1;
      return jsonResponse(validUpload, 201);
    },
  });
  const cursor = await client.streamRunEvents(target, validRun.id, "unsafe cursor\n");
  const upload = await client.createUpload(target, new Blob(["four"]), "four.txt");
  assert.equal(cursor.ok, false);
  assert.equal(upload.ok, false);
  if (!cursor.ok) assert.deepEqual(cursor.problem, invalidPathProblem);
  if (!upload.ok) assert.equal(upload.problem.status, 413);
  assert.equal(calls, 0);
});

test("control capability endpoints enforce exact success status, media type, and upload size", async () => {
  const file = new Blob([new Uint8Array(validUpload.file.sizeBytes)], { type: "text/plain" });
  const cases = [
    async () => await createAdapterClient({ fetch: async () => jsonResponse(validUpload, 200) })
      .createUpload(target, file, validUpload.file.name),
    async () => await createAdapterClient({ fetch: async () => jsonResponse(validRun, 200) })
      .cancelRun(target, validRun.id),
    async () => await createAdapterClient({
      fetch: async () => new Response("", { status: 201, headers: { "content-type": "text/event-stream" } }),
    }).streamRunEvents(target, validRun.id),
    async () => await createAdapterClient({
      fetch: async () => new Response(JSON.stringify(validUpload), {
        status: 201,
        headers: { "content-type": "text/plain" },
      }),
    }).createUpload(target, file, validUpload.file.name),
    async () => await createAdapterClient({
      fetch: async () => new Response(JSON.stringify(validRun), {
        status: 202,
        headers: { "content-type": "text/plain" },
      }),
    }).cancelRun(target, validRun.id),
    async () => await createAdapterClient({
      fetch: async () => new Response("", { headers: { "content-type": "application/json" } }),
    }).streamRunEvents(target, validRun.id),
    async () => await createAdapterClient({
      fetch: async () => jsonResponse({
        ...validUpload,
        file: { ...validUpload.file, sizeBytes: validUpload.file.sizeBytes + 1 },
      }, 201),
    }).createUpload(target, file, validUpload.file.name),
  ];

  for (const invoke of cases) {
    const result = await invoke();
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("optional endpoints accept only their own unsupported-capability Problem", async () => {
  const file = new Blob([new Uint8Array(validUpload.file.sizeBytes)]);
  const unsupported = (capability: `${string}@${number}`) => problemResponse({
    type: "urn:gauntlet:problem:unsupported-capability",
    title: "Unsupported capability",
    status: 501,
    capability,
  });
  const cases = [
    {
      expected: "tc-uploads@1" as const,
      invoke: async (capability: `${string}@${number}`) => await createAdapterClient({
        fetch: async () => unsupported(capability),
      }).createUpload(target, file, validUpload.file.name),
    },
    {
      expected: "tc-run-cancellation@1" as const,
      invoke: async (capability: `${string}@${number}`) => await createAdapterClient({
        fetch: async () => unsupported(capability),
      }).cancelRun(target, validRun.id),
    },
    {
      expected: "tc-run-sse@1" as const,
      invoke: async (capability: `${string}@${number}`) => await createAdapterClient({
        fetch: async () => unsupported(capability),
      }).streamRunEvents(target, validRun.id),
    },
    {
      expected: "tc-session-launch@1" as const,
      invoke: async (capability: `${string}@${number}`) => await createAdapterClient({
        fetch: async () => unsupported(capability),
      }).createSessionLaunch(target, validRun.id, "launch-1"),
    },
  ];

  for (const entry of cases) {
    const accepted = await entry.invoke(entry.expected);
    assert.equal(accepted.ok, false);
    if (!accepted.ok) {
      assert.equal(accepted.problem.status, 501);
      assert.equal(accepted.problem.capability, entry.expected);
    }
    const rejected = await entry.invoke("urn:wrong-capability@1");
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.deepEqual(rejected.problem, invalidResponseProblem);
  }
});

test("SSE bounds each frame and supports cancellation before the first pull", async () => {
  let oversizedCancelled = 0;
  const oversized = createAdapterClient({
    maxResponseBytes: 32,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `id: ${validRunEvent.id}\nevent: run.updated\ndata: ${JSON.stringify(validRunEvent)}\n\n`,
        ));
      },
      cancel() {
        oversizedCancelled += 1;
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const oversizedResult = await oversized.streamRunEvents(target, validRun.id);
  assert.equal(oversizedResult.ok, true);
  if (oversizedResult.ok) {
    await assert.rejects(oversizedResult.value[Symbol.asyncIterator]().next(), /event stream failed/i);
  }
  assert.equal(oversizedCancelled, 1);

  let earlyCancelled = 0;
  const earlyBody = new ReadableStream<Uint8Array>({
    cancel() {
      earlyCancelled += 1;
    },
  });
  const early = await createAdapterClient({
    fetch: async () => new Response(earlyBody, { headers: { "content-type": "text/event-stream" } }),
  }).streamRunEvents(target, validRun.id);
  assert.equal(early.ok, true);
  if (early.ok) await early.value.cancel();
  assert.equal(earlyBody.locked, false);
  assert.equal(earlyCancelled, 1);
});

test("SSE keeps the connection timeout for non-success bodies but clears it after a valid handshake", async () => {
  const failing = createAdapterClient({
    timeoutMs: 10,
    fetch: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("private timeout")));
      },
    }), { status: 503, headers: { "content-type": "application/problem+json" } }),
  });
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  const failure = await Promise.race([
    failing.streamRunEvents(target, validRun.id),
    new Promise<never>((_resolve, reject) => {
      safetyTimer = setTimeout(() => reject(new Error("client timeout was cleared early")), 250);
    }),
  ]).finally(() => {
    if (safetyTimer !== undefined) clearTimeout(safetyTimer);
  });
  assert.equal(failure.ok, false);
  if (!failure.ok) {
    assert.equal(failure.problem.type, "urn:gauntlet:problem:adapter-unavailable");
    assert.equal(failure.problem.title.includes("private"), false);
  }

  let successAborted = false;
  const successful = createAdapterClient({
    timeoutMs: 10,
    fetch: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          successAborted = true;
          controller.error(new Error("should remain connected"));
        });
        controller.enqueue(new TextEncoder().encode(
          `id: ${validRunEvent.id}\nevent: run.updated\ndata: ${JSON.stringify(validRunEvent)}\n\n`,
        ));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const success = await successful.streamRunEvents(target, validRun.id);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(successAborted, false);
  assert.equal(success.ok, true);
  if (success.ok) assert.equal((await success.value[Symbol.asyncIterator]().next()).done, false);
});

test("every endpoint uses its exact fixed method, route, and JSON request document", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const responses = [
    jsonResponse(validHealth),
    jsonResponse(validMinorForwardManifest),
    jsonResponse(validOperation),
    jsonResponse(validRun, 202),
    jsonResponse(validRun),
    jsonResponse(validDataSourcePage),
    jsonResponse(validResolveResponse),
    jsonResponse(validSessionLaunch, 201),
  ];
  const client = createAdapterClient({
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return responses.shift()!;
    },
  });

  await client.health(target);
  await client.getManifest(target);
  await client.getOperation(target, validOperation.id);
  await client.createRun(target, validOperation.id, validCreateRunRequest);
  await client.getRun(target, validRun.id);
  await client.queryDataSource(target, "application-catalog", validDataSourceQuery);
  await client.resolveDataSource(target, "application-catalog", validResolveRequest);
  await client.createSessionLaunch(target, validRun.id, "launch-1");

  assert.deepEqual(requests.map(({ url, init }) => [new URL(url).pathname, init?.method]), [
    ["/_gauntlet/v1/health", "GET"],
    ["/_gauntlet/v1/manifest", "GET"],
    [`/_gauntlet/v1/operations/${validOperation.id}`, "GET"],
    [`/_gauntlet/v1/operations/${validOperation.id}/runs`, "POST"],
    [`/_gauntlet/v1/runs/${validRun.id}`, "GET"],
    ["/_gauntlet/v1/data-sources/application-catalog/query", "POST"],
    ["/_gauntlet/v1/data-sources/application-catalog/resolve", "POST"],
    [`/_gauntlet/v1/runs/${validRun.id}/artifacts/launch-1/launch`, "POST"],
  ]);
  assert.deepEqual(requests.slice(3).filter(({ init }) => init?.body !== undefined).map(({ init }) => JSON.parse(String(init?.body))), [
    validCreateRunRequest,
    validDataSourceQuery,
    validResolveRequest,
  ]);
  for (const { init } of requests) {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
  }
});

test("invalid target IDs and ambiguous base URLs are rejected before fetch", async () => {
  let calls = 0;
  const client = createAdapterClient({ fetch: async () => { calls += 1; return jsonResponse(validHealth); } });
  const badTargets = [
    { id: "unsafe/id", adapterUrl: "http://adapter.internal" },
    { id: "fixture-adapter", adapterUrl: "/relative" },
    { id: "fixture-adapter", adapterUrl: "ftp://adapter.internal" },
    { id: "fixture-adapter", adapterUrl: "http://adapter.internal/prefix" },
    { id: "fixture-adapter", adapterUrl: "http://adapter.internal/?token=secret" },
    { id: "fixture-adapter", adapterUrl: "http://user:pass@adapter.internal" },
  ];

  for (const badTarget of badTargets) {
    const result = await client.health(badTarget);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidPathProblem);
  }
  assert.equal(calls, 0);
});

test("invalid request documents are rejected before fetch", async () => {
  let calls = 0;
  const client = createAdapterClient({ fetch: async () => { calls += 1; return jsonResponse(validRun, 201); } });
  const request = { ...validCreateRunRequest, unexpected: true } as unknown as CreateRunRequest;

  const result = await client.createRun(target, validOperation.id, request);

  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problem, requestValidationProblem);
  assert.equal(calls, 0);
});

test("every JSON request family rejects lone surrogates in values and member names before fetch", async () => {
  let calls = 0;
  const client = createAdapterClient({
    fetch: async () => {
      calls += 1;
      return jsonResponse(validRun, 202);
    },
  });
  const inputWithInvalidKey = structuredClone(validCreateRunRequest.input) as Record<string, unknown>;
  Object.defineProperty(inputWithInvalidKey, loneHighSurrogate, {
    value: true,
    enumerable: true,
  });

  const results = [
    await client.createRun(target, validOperation.id, {
      ...validCreateRunRequest,
      input: { ...validCreateRunRequest.input, note: loneHighSurrogate },
    }),
    await client.createRun(target, validOperation.id, {
      ...validCreateRunRequest,
      input: inputWithInvalidKey,
    }),
    await client.queryDataSource(target, "application-catalog", {
      ...validDataSourceQuery,
      search: loneHighSurrogate,
    }),
    await client.resolveDataSource(target, "application-catalog", {
      ...validResolveRequest,
      values: [loneHighSurrogate],
    }),
  ];

  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, requestValidationProblem);
  }
  assert.equal(calls, 0);
});

test("public create-run preflight returns a descriptor-safe owned document", () => {
  const source = structuredClone(validCreateRunRequest) as CreateRunRequest;
  const result = validateCreateRunRequest(source);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), validCreateRunRequest);
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.input), true);
    assert.equal(validateCreateRunRequest(result.value).ok, true);
    (source as { input: Record<string, unknown> }).input.changed = true;
    assert.equal("changed" in result.value.input, false);
  }

  let getterCalls = 0;
  const accessor = structuredClone(validCreateRunRequest) as Record<string, unknown>;
  Object.defineProperty(accessor, "operationRevision", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return validCreateRunRequest.operationRevision;
    },
  });
  for (const invalid of [
    { ...validCreateRunRequest, unexpected: true },
    { ...validCreateRunRequest, operationRevision: "not-a-sha256-revision" },
    accessor,
  ]) {
    assert.deepEqual(validateCreateRunRequest(invalid), {
      ok: false,
      problem: requestValidationProblem,
    });
  }
  assert.equal(getterCalls, 0);
});

test("every POST request document rejects a non-enumerable toJSON without invoking it or Fetch", async () => {
  let fetchCalls = 0;
  let toJsonCalls = 0;
  const client = createAdapterClient({
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(validRun, 202);
    },
  });
  const createRequest = structuredClone(validCreateRunRequest) as CreateRunRequest;
  const queryRequest = structuredClone(validDataSourceQuery) as DataSourceQuery;
  const resolveRequest = structuredClone(validResolveRequest) as DataSourceResolveRequest;
  for (const request of [createRequest, queryRequest, resolveRequest]) {
    Object.defineProperty(request, "toJSON", {
      value: () => {
        toJsonCalls += 1;
        return "not-a-request-document";
      },
    });
  }

  const results = [
    await client.createRun(target, validOperation.id, createRequest),
    await client.queryDataSource(target, "application-catalog", queryRequest),
    await client.resolveDataSource(target, "application-catalog", resolveRequest),
  ];

  assert.equal(results.every((result) => !result.ok), true);
  for (const result of results) {
    if (!result.ok) assert.deepEqual(result.problem, requestValidationProblem);
  }
  assert.equal(toJsonCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("POST request ownership rejects accessors, hidden/symbol keys, exotic values, cycles, sparse arrays, and nonfinite numbers", async () => {
  let fetchCalls = 0;
  let getterCalls = 0;
  const client = createAdapterClient({
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(validDataSourcePage);
    },
  });
  const accessor = structuredClone(validDataSourceQuery) as Record<string, unknown>;
  Object.defineProperty(accessor, "search", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "unsafe";
    },
  });
  const hidden = structuredClone(validDataSourceQuery) as Record<string, unknown>;
  Object.defineProperty(hidden, "hidden", { value: true });
  const symbol = structuredClone(validDataSourceQuery) as Record<string | symbol, unknown>;
  symbol[Symbol("hidden")] = true;
  const exotic = structuredClone(validDataSourceQuery) as Record<string, unknown>;
  exotic.dependencies = new Date();
  const cyclic = structuredClone(validDataSourceQuery) as Record<string, unknown>;
  cyclic.self = cyclic;
  const sparse = structuredClone(validDataSourceQuery) as Record<string, unknown>;
  sparse.dependencies = { "/items": new Array(1) };
  const nonfinite = structuredClone(validDataSourceQuery) as Record<string, unknown>;
  nonfinite.limit = Number.POSITIVE_INFINITY;

  for (const request of [accessor, hidden, symbol, exotic, cyclic, sparse, nonfinite]) {
    const result = await client.queryDataSource(
      target,
      "application-catalog",
      request as unknown as DataSourceQuery,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, requestValidationProblem);
  }
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("createRun response semantics use the serialized snapshot after deferred caller mutation", async () => {
  const snapshotRevision = validCreateRunRequest.operationRevision;
  const mutatedRevision = `sha256:${"a".repeat(64)}` as const;

  for (const responseRevision of [snapshotRevision, mutatedRevision]) {
    const started = deferred();
    const release = deferred();
    let sentRequest: CreateRunRequest | undefined;
    const request = structuredClone(validCreateRunRequest) as CreateRunRequest;
    const client = createAdapterClient({
      fetch: async (_input, init) => {
        sentRequest = JSON.parse(String(init?.body)) as CreateRunRequest;
        started.resolve();
        await release.promise;
        return jsonResponse({ ...validRun, operationRevision: responseRevision }, 202);
      },
    });

    const pending = client.createRun(target, validOperation.id, request);
    await started.promise;
    (request as { operationRevision: string }).operationRevision = mutatedRevision;
    release.resolve();
    const result = await pending;

    assert.equal(sentRequest?.operationRevision, snapshotRevision);
    assert.deepEqual(sentRequest?.confirmation, {
      operationId: validOperation.id,
      operationRevision: validOperation.revision,
      impact: validOperation.execution.impact,
    });
    assert.equal(result.ok, responseRevision === snapshotRevision);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("resolve response semantics use the serialized snapshot after deferred caller mutation", async () => {
  const snapshotValues = [...validResolveRequest.values];
  const mutatedValues = ["changed-1", "changed-2"];

  for (const responseValues of [snapshotValues, mutatedValues]) {
    const started = deferred();
    const release = deferred();
    let sentRequest: DataSourceResolveRequest | undefined;
    const request = structuredClone(validResolveRequest) as DataSourceResolveRequest;
    const client = createAdapterClient({
      fetch: async (_input, init) => {
        sentRequest = JSON.parse(String(init?.body)) as DataSourceResolveRequest;
        started.resolve();
        await release.promise;
        return jsonResponse({
          results: responseValues.map((value) => ({ value, item: null })),
        });
      },
    });

    const pending = client.resolveDataSource(target, "application-catalog", request);
    await started.promise;
    (request as { values: string[] }).values = mutatedValues;
    release.resolve();
    const result = await pending;

    assert.deepEqual(sentRequest?.values, snapshotValues);
    assert.equal(result.ok, responseValues === snapshotValues);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("invalid adapter JSON becomes a safe 502 problem", async () => {
  const client = createAdapterClient({ fetch: async () => new Response("not-json") });
  const result = await client.getManifest(target);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
});

test("every adapter JSON response family rejects a schema-shaped lone surrogate", async () => {
  const uploadFile = new Blob([new Uint8Array(validUpload.file.sizeBytes)]);
  const cases = [
    {
      name: "health",
      response: jsonResponse(withInvalidScalar(validHealth)),
      invoke: async (client: ReturnType<typeof createAdapterClient>) => await client.health(target),
    },
    {
      name: "manifest",
      response: jsonResponse(withInvalidScalar(validMinorForwardManifest)),
      invoke: async (client: ReturnType<typeof createAdapterClient>) => await client.getManifest(target),
    },
    {
      name: "operation",
      response: jsonResponse(withInvalidScalar(validOperation)),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.getOperation(target, validOperation.id),
    },
    {
      name: "create Run",
      response: jsonResponse(withInvalidScalar(validRun), 202),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.createRun(target, validOperation.id, validCreateRunRequest),
    },
    {
      name: "poll Run",
      response: jsonResponse(withInvalidScalar(validRun)),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.getRun(target, validRun.id),
    },
    {
      name: "query page",
      response: jsonResponse(withInvalidScalar(validDataSourcePage)),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.queryDataSource(target, "application-catalog", validDataSourceQuery),
    },
    {
      name: "resolve response",
      response: jsonResponse(withInvalidScalar(validResolveResponse)),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.resolveDataSource(target, "application-catalog", validResolveRequest),
    },
    {
      name: "upload",
      response: jsonResponse(withInvalidScalar(validUpload), 201),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.createUpload(target, uploadFile, validUpload.file.name),
    },
    {
      name: "cancel Run",
      response: jsonResponse(withInvalidScalar(validRun), 202),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.cancelRun(target, validRun.id),
    },
    {
      name: "session launch",
      response: jsonResponse(withInvalidScalar(validSessionLaunch), 201),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.createSessionLaunch(target, validRun.id, "launch-1"),
    },
    {
      name: "Problem",
      response: problemResponse(withInvalidScalar(validProblem)),
      invoke: async (client: ReturnType<typeof createAdapterClient>) =>
        await client.getRun(target, "run-missing"),
    },
  ];

  for (const current of cases) {
    const result = await current.invoke(createAdapterClient({ fetch: async () => current.response }));
    assert.equal(result.ok, false, current.name);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem, current.name);
  }
});

test("Run JSON rejects negative zero before schema and semantic validation", async () => {
  const encoded = JSON.stringify(validRun);
  const hostile = encoded.replace('"sequence":0', '"sequence":-0');
  assert.notEqual(hostile, encoded, "fixture must expose a zero sequence");
  const result = await createAdapterClient({
    fetch: async () => new Response(hostile, {
      headers: { "content-type": "application/json" },
    }),
  }).getRun(target, validRun.id);

  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
});

test("schema-valid Runs with broken intrinsic semantics become a safe 502", async () => {
  const inverted = { ...validRun, updatedAt: "2025-01-01T00:00:00Z" };
  const dangling = {
    ...validRun,
    actions: [{ kind: "browser-launch", label: "Missing", artifactId: "missing-artifact" }],
  };

  for (const response of [inverted, dangling]) {
    const client = createAdapterClient({ fetch: async () => jsonResponse(response) });
    const result = await client.getRun(target, validRun.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("health and manifest expose only the client-owned protocol-major mismatch discriminator", async () => {
  const cases = [
    {
      endpoint: "health",
      response: jsonResponse({ status: "ok", protocolVersion: "2.0", detail: "remote secret" }),
    },
    {
      endpoint: "health",
      response: jsonResponse({ status: "ok", protocolVersion: "900719925474099300000.7" }),
    },
    {
      endpoint: "manifest",
      response: jsonResponse(
        { ...validMinorForwardManifest, protocolVersion: "2.0", detail: "remote secret" },
        200,
        { etag: '"remote-etag-must-not-be-trusted"' },
      ),
    },
  ] as const;

  for (const { endpoint, response } of cases) {
    const client = createAdapterClient({ fetch: async () => response });
    const result = endpoint === "health"
      ? await client.health(target)
      : await client.getManifest(target, '"sha256:cached"');
    assert.deepEqual(result, {
      ok: false,
      problem: incompatibleProtocolProblem,
      failureKind: protocolMajorMismatchKind,
    }, endpoint);
  }
});

test("malformed negotiation and non-negotiation endpoints remain generic invalid responses", async () => {
  const calls = [
    async () => await createAdapterClient({ fetch: async () => jsonResponse({ status: "ok", protocolVersion: "garbage" }) })
      .health(target),
    async () => await createAdapterClient({ fetch: async () => jsonResponse({ status: "ok", protocolVersion: "01.0" }) })
      .health(target),
    async () => await createAdapterClient({ fetch: async () => jsonResponse({ status: "wrong", protocolVersion: "1.0" }) })
      .health(target),
    async () => await createAdapterClient({ fetch: async () => jsonResponse({ status: "ok" }) })
      .health(target),
    async () => await createAdapterClient({ fetch: async () => jsonResponse({ status: "ok", protocolVersion: "2.0" }, 201) })
      .health(target),
    async () => await createAdapterClient({
      fetch: async () => new Response(JSON.stringify({ status: "ok", protocolVersion: "2.0" }), {
        headers: { "content-type": "text/plain" },
      }),
    }).health(target),
    async () => await createAdapterClient({
      maxResponseBytes: 16,
      fetch: async () => jsonResponse({ status: "ok", protocolVersion: "2.0" }),
    }).health(target),
    async () => await createAdapterClient({
      fetch: async () => jsonResponse({ ...validMinorForwardManifest, unexpected: true }),
    }).getManifest(target),
    async () => await createAdapterClient({
      fetch: async () => jsonResponse({ ...validMinorForwardManifest, protocolVersion: "garbage" }),
    }).getManifest(target),
    async () => await createAdapterClient({
      fetch: async () => jsonResponse({ ...validMinorForwardManifest, protocolVersion: "2.0" }, 201),
    }).getManifest(target),
    async () => await createAdapterClient({
      fetch: async () => new Response(
        JSON.stringify({ ...validMinorForwardManifest, protocolVersion: "2.0" }),
        { headers: { "content-type": "text/plain" } },
      ),
    }).getManifest(target),
    async () => await createAdapterClient({
      maxResponseBytes: 16,
      fetch: async () => jsonResponse({ ...validMinorForwardManifest, protocolVersion: "2.0" }),
    }).getManifest(target),
    async () => await createAdapterClient({
      fetch: async () => jsonResponse({ ...validOperation, protocolVersion: "2.0" }),
    }).getOperation(target, validOperation.id),
  ];

  for (const call of calls) {
    const result = await call();
    assert.deepEqual(result, { ok: false, problem: invalidResponseProblem });
    assert.equal(Object.hasOwn(result, "failureKind"), false);
  }
});

test("a remote Problem cannot spoof the client-owned protocol mismatch discriminator", async () => {
  const spoofedProblem = {
    type: "urn:gauntlet:problem:adapter-protocol-incompatible",
    title: "Remote incompatible claim",
    status: 502,
    detail: "remote-controlled detail",
  } as const;
  for (const endpoint of ["health", "manifest"] as const) {
    const client = createAdapterClient({
      fetch: async () => jsonResponse(spoofedProblem, 502, {
        "content-type": "application/problem+json",
      }),
    });
    const result = endpoint === "health"
      ? await client.health(target)
      : await client.getManifest(target);
    assert.deepEqual(result, { ok: false, problem: spoofedProblem }, endpoint);
    assert.equal(Object.hasOwn(result, "failureKind"), false, endpoint);
  }
});

test("success responses require an endpoint status and JSON media type", async () => {
  const cases = [
    jsonResponse(validHealth, 201),
    new Response(JSON.stringify(validHealth), { status: 200, headers: { "content-type": "text/plain" } }),
  ];
  for (const response of cases) {
    const client = createAdapterClient({ fetch: async () => response });
    const result = await client.health(target);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("oversized responses are rejected from both declared and streamed sizes", async () => {
  const document = JSON.stringify(validHealth);
  const responses = [
    new Response(document, {
      headers: { "content-type": "application/json", "content-length": "9999" },
    }),
    new Response(document, { headers: { "content-type": "application/json" } }),
  ];
  for (const response of responses) {
    const client = createAdapterClient({ maxResponseBytes: 16, fetch: async () => response });
    const result = await client.health(target);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});

test("valid canonical adapter problems are returned and malformed problems are sanitized", async () => {
  const validClient = createAdapterClient({ fetch: async () => problemResponse(validProblem) });
  const validResult = await validClient.getRun(target, "run-missing");
  assert.equal(validResult.ok, false);
  if (!validResult.ok) assert.deepEqual(validResult.problem, validProblem);

  const malformedClient = createAdapterClient({
    fetch: async () => jsonResponse({ ...validProblem, status: 500, stack: "remote secret" }, 404, {
      "content-type": "application/problem+json",
    }),
  });
  const malformedResult = await malformedClient.getRun(target, "run-missing");
  assert.equal(malformedResult.ok, false);
  if (!malformedResult.ok) assert.deepEqual(malformedResult.problem, invalidResponseProblem);
});

test("transport and timeout failures map to a fixed problem without leaking errors", async () => {
  const unavailableProblem = {
    type: "urn:gauntlet:problem:adapter-unavailable",
    title: "Adapter unavailable",
    status: 503,
  } as const;
  const transportClient = createAdapterClient({
    fetch: async () => { throw new Error("socket failed with secret token"); },
  });
  const transportResult = await transportClient.health(target);
  assert.equal(transportResult.ok, false);
  if (!transportResult.ok) assert.deepEqual(transportResult.problem, unavailableProblem);

  const timeoutClient = createAdapterClient({
    timeoutMs: 5,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  const timeoutResult = await timeoutClient.health(target);
  assert.equal(timeoutResult.ok, false);
  if (!timeoutResult.ok) assert.deepEqual(timeoutResult.problem, unavailableProblem);
});

test("conditional manifest requests validate 304 and revision ETags", async () => {
  const requests: RequestInit[] = [];
  const responses = [
    new Response(null, { status: 304 }),
    jsonResponse(validMinorForwardManifest, 200, {
      etag: `"${validMinorForwardManifest.manifestRevision}"`,
    }),
  ];
  const client = createAdapterClient({
    fetch: async (_input, init) => {
      requests.push(init!);
      return responses.shift()!;
    },
  });

  const cached = await client.getManifest(target, '"sha256:cached"');
  assert.deepEqual(cached, { ok: true, value: { notModified: true } });
  assert.equal(new Headers(requests[0]?.headers).get("if-none-match"), '"sha256:cached"');

  const fresh = await client.getManifest(target);
  assert.equal(fresh.ok, true);
  if (fresh.ok) {
    assert.equal(fresh.value.notModified, false);
    if (!fresh.value.notModified) assert.deepEqual(fresh.value.manifest, validMinorForwardManifest);
    assert.equal(fresh.etag, `"${validMinorForwardManifest.manifestRevision}"`);
  }
});

test("unsolicited 304 and mismatched revision ETags are invalid responses", async () => {
  const responses = [
    new Response(null, { status: 304 }),
    jsonResponse(validMinorForwardManifest, 200, { etag: '"sha256:wrong"' }),
  ];
  for (const response of responses) {
    const client = createAdapterClient({ fetch: async () => response });
    const result = await client.getManifest(target);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.problem, invalidResponseProblem);
  }
});
