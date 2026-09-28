import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api } from "../src/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("multipart upload lets fetch generate the boundary", async () => {
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("content-type"), false);
    assert.ok(init?.body instanceof FormData);
    return Response.json({
      file: {
        kind: "file",
        uploadId: "upload-1",
        name: "fixture.txt",
        mediaType: "text/plain",
        sizeBytes: 7,
        expiresAt: "2026-09-03T12:00:00Z",
      },
    });
  };

  const result = await api.uploadFile("portal", new File(["fixture"], "fixture.txt"));
  assert.equal(result.ok, true);
});

test("invalid non-JSON responses become a bounded unexpected-response Problem", async () => {
  globalThis.fetch = async () => new Response("<html>proxy failure secret</html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  });

  const result = await api.targets();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.problem.type, "urn:gauntlet:problem:unexpected-response");
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("session launch encodes every path identifier without a JSON content type", async () => {
  const launch = {
    url: "https://example.test/session",
    expiresAt: "2026-09-03T12:00:00Z",
    singleUse: true,
  } as const;
  globalThis.fetch = async (input, init) => {
    assert.equal(
      input,
      "/api/v1/targets/portal%2Fwest/runs/run%2F1/artifacts/artifact%2F1/launch",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("content-type"), false);
    return Response.json(launch);
  };

  const result = await api.launchArtifact("portal/west", "run/1", "artifact/1");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, launch);
});

test("JSON bodies receive the JSON content type", async () => {
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("content-type"), "application/json");
    return Response.json({
      id: "run-1",
      operationId: "operation-1",
      operationRevision: `sha256:${"a".repeat(64)}`,
      state: "queued",
      createdAt: "2026-09-03T12:00:00Z",
    });
  };

  const result = await api.createRun("portal", "operation-1", {
    operationRevision: `sha256:${"a".repeat(64)}`,
    input: {},
    context: { requestId: "dashboard-request-1" },
    dryRun: false,
  });
  assert.equal(result.ok, true);
});
