import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAdapterV1Scenario } from "../../src/index.js";

const committedScenarioUrl = new URL("../../../scenarios/adapter-v1.json", import.meta.url);

const expectedScenario = {
  operationId: "agency-applications.finalize",
  dataSourceId: "pending-applications",
  input: {
    applicationId: "11111111-1111-4111-8111-111111111111",
    confirmationCode: "731904",
  },
  invalidInput: {
    applicationId: "not-a-uuid",
    confirmationCode: "731904",
  },
  expectedValidationPointer: "/applicationId",
  dataSourceQuery: {
    search: "Brown",
    limit: 2,
    dependencies: { "/workflowState": "pending" },
    context: {
      requestId: "conformance-query-01",
      target: { id: "conformance-target", environment: "test" },
    },
  },
  dataSourceResolveRequest: {
    values: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
    dependencies: { "/workflowState": "pending" },
    context: {
      requestId: "conformance-resolve-01",
      target: { id: "conformance-target", environment: "test" },
    },
  },
  idempotencyKey: "conformance-finalize-01",
  expectedTerminalState: "succeeded",
  requiredProfiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
  requiredCapabilities: [],
  browserLaunch: {
    artifactId: "conformance-browser-session",
    expectedPublicOrigin: "https://portal.example.test",
  },
} as const;

async function withScenarioBytes(
  bytes: string | Uint8Array,
  exercise: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tc-scenario-"));
  const path = join(directory, "scenario.json");
  try {
    await writeFile(path, bytes);
    await exercise(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the committed P0 scenario preserves every frozen literal", async () => {
  assert.deepEqual(await loadAdapterV1Scenario(committedScenarioUrl), expectedScenario);
});

test("string paths resolve from the current working directory and file URLs are accepted", async () => {
  const path = join(process.cwd(), "../scenarios/adapter-v1.json");
  assert.deepEqual(await loadAdapterV1Scenario(path), expectedScenario);
  assert.deepEqual(await loadAdapterV1Scenario(committedScenarioUrl), expectedScenario);
});

test("network URLs are rejected without echoing their value", async () => {
  const secretUrl = new URL("https://example.test/private-token");
  await assert.rejects(loadAdapterV1Scenario(secretUrl), (error: unknown) => {
    assert.match(String(error), /scenario/i);
    assert.doesNotMatch(String(error), /private-token/);
    return true;
  });
});

test("missing, extra, malformed, duplicate, and unsafe scenario members are rejected", async () => {
  const mutations: unknown[] = [
    { ...expectedScenario, operationId: undefined },
    { ...expectedScenario, unexpected: true },
    { ...expectedScenario, operationId: "unsafe!id" },
    { ...expectedScenario, dataSourceId: "unsafe!id" },
    { ...expectedScenario, expectedValidationPointer: "/bad~pointer" },
    { ...expectedScenario, expectedTerminalState: "running" },
    { ...expectedScenario, idempotencyKey: "" },
    { ...expectedScenario, requiredProfiles: ["tc-schema-core@1", "tc-schema-core@1"] },
    { ...expectedScenario, requiredCapabilities: ["tc-run-sse@1", "tc-run-sse@1"] },
    { ...expectedScenario, requiredProfiles: ["tc-schema-core@0"] },
    { ...expectedScenario, requiredCapabilities: ["tc-run-sse"] },
    { ...expectedScenario, browserLaunch: { ...expectedScenario.browserLaunch, artifactId: "unsafe!id" } },
    { ...expectedScenario, browserLaunch: { ...expectedScenario.browserLaunch, expectedPublicOrigin: "https://u:p@example.test" } },
    { ...expectedScenario, browserLaunch: { ...expectedScenario.browserLaunch, expectedPublicOrigin: "https://example.test/path" } },
    { ...expectedScenario, invalidInput: { ...expectedScenario.invalidInput, confirmationCode: "changed" } },
    { ...expectedScenario, dataSourceQuery: { ...expectedScenario.dataSourceQuery, context: { requestId: "only" } } },
    { ...expectedScenario, dataSourceResolveRequest: { ...expectedScenario.dataSourceResolveRequest, dependencies: { workflowState: "pending" } } },
  ];

  for (const mutation of mutations) {
    await withScenarioBytes(JSON.stringify(mutation), async (path) => {
      await assert.rejects(loadAdapterV1Scenario(path), /scenario/i);
    });
  }
});

test("invalid UTF-8 and escaped lone-surrogate values and member names fail before validation", async () => {
  await withScenarioBytes(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), async (path) => {
    await assert.rejects(loadAdapterV1Scenario(path), /scenario/i);
  });

  for (const fragment of [
    '"operationId":"\\uD800"',
    '"operationId":"\\uDC00"',
    '"\\uD800":"value"',
  ]) {
    const text = fragment.startsWith('"operationId"')
      ? JSON.stringify(expectedScenario).replace(/"operationId":"[^"]+"/, fragment)
      : JSON.stringify({ ...expectedScenario }).replace(/^\{/, `{${fragment},`);
    await withScenarioBytes(text, async (path) => {
      await assert.rejects(loadAdapterV1Scenario(path), /scenario/i);
    });
  }
});

test("a valid supplementary Unicode scalar survives the canonical boundary", async () => {
  const value = { ...expectedScenario, idempotencyKey: "conformance-rocket-🚀" };
  await withScenarioBytes(JSON.stringify(value), async (path) => {
    assert.equal((await loadAdapterV1Scenario(path)).idempotencyKey, "conformance-rocket-🚀");
  });
});

test("the fixed four-MiB local file cap applies to both declared and streamed input", async () => {
  await withScenarioBytes(new Uint8Array(4 * 1024 * 1024 + 1), async (path) => {
    await assert.rejects(loadAdapterV1Scenario(path), /scenario/i);
  });
});
