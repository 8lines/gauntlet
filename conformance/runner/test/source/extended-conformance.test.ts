import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runBoundedChild } from "../support/child-process.js";
import {
  executeExtendedConformanceCli,
} from "../../src/extended-cli.js";
import {
  startExtendedFixtureAdapter,
} from "../../src/extended-fixture-adapter.js";
import {
  runAdapterV1ExtendedConformance,
} from "../../src/extended-runner.js";
import {
  loadAdapterV1ExtendedScenario,
  validateAdapterV1ExtendedScenario,
} from "../../src/extended-scenario.js";

const scenarioUrl = new URL("../../../scenarios/adapter-v1-extended.json", import.meta.url);
const runnerRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceCli = fileURLToPath(new URL("../../src/extended-cli.ts", import.meta.url));

async function responseDocument(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function replaceJson(response: Response, document: unknown): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(document), { status: response.status, headers });
}

test("the committed extended scenario is exact, portable, and mutation-closed", async () => {
  const scenario = await loadAdapterV1ExtendedScenario(scenarioUrl);
  assert.equal(scenario.format, "tc-adapter-v1-extended@1");
  assert.equal(scenario.handlerFailure.operationId, "agency-applications.fail");
  assert.equal(scenario.pagination.query.limit, 1);
  assert.equal(scenario.customBinding.operationId, "agency-applications.finalize");

  for (const invalid of [
    { ...scenario, extra: true },
    { ...scenario, secretSentinels: [] },
    { ...scenario, pagination: { ...scenario.pagination, maximumPages: 1 } },
    { ...scenario, pagination: { ...scenario.pagination, query: { ...scenario.pagination.query, cursor: "preset" } } },
    { ...scenario, pagination: { ...scenario.pagination, query: { ...scenario.pagination.query, context: undefined } } },
    { ...scenario, customBinding: { ...scenario.customBinding, expectedArtifactId: "unsafe!id" } },
  ]) {
    assert.throws(() => validateAdapterV1ExtendedScenario(invalid));
  }
});

test("the native extended fixture passes every shared black-box branch and CLI entrypoint", async (t) => {
  const scenario = await loadAdapterV1ExtendedScenario(scenarioUrl);
  const enabled = await startExtendedFixtureAdapter({ scenario, enabled: true });
  const disabled = await startExtendedFixtureAdapter({ scenario, enabled: false });
  t.after(async () => await Promise.all([enabled.close(), disabled.close()]));

  let advertisedEnvironment: unknown;
  const definitions = new Map<string, Record<string, unknown>>();
  const createRequests: Array<{
    readonly operationId: string;
    readonly operationRevision: unknown;
    readonly confirmation: unknown;
  }> = [];
  const enabledOrigin = new URL(enabled.baseUrl).origin;
  const captureFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin === enabledOrigin && method === "POST" && init?.body !== undefined) {
      const match = /^\/_gauntlet\/v1\/operations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs$/.exec(
        url.pathname,
      );
      if (match !== null) {
        const document = JSON.parse(await new Response(init.body).text()) as Record<string, unknown>;
        createRequests.push({
          operationId: match[1]!,
          operationRevision: document.operationRevision,
          confirmation: document.confirmation,
        });
      }
    }
    const response = await fetch(input, init);
    if (response.status === 200 && method === "GET" && url.pathname.endsWith("/manifest")) {
      const manifest = await response.clone().json() as Record<string, unknown>;
      advertisedEnvironment = (manifest.application as Record<string, unknown>).environment;
    }
    if (response.status === 200 && method === "GET") {
      const match = /^\/_gauntlet\/v1\/operations\/([^/]+)$/.exec(url.pathname);
      if (match !== null) {
        definitions.set(match[1]!, await response.clone().json() as Record<string, unknown>);
      }
    }
    return response;
  };

  await runAdapterV1ExtendedConformance({
    enabledBaseUrl: enabled.baseUrl,
    disabledBaseUrl: disabled.baseUrl,
    scenario,
    fetch: captureFetch,
    pollIntervalMs: 1,
  });
  assert.deepEqual(advertisedEnvironment, { name: "conformance-fixture-test", kind: "test" });
  assert.equal(createRequests.length, 2);
  for (const request of createRequests) {
    const definition = definitions.get(request.operationId);
    assert.ok(definition);
    assert.equal(request.operationRevision, definition.revision);
    assert.deepEqual(request.confirmation, {
      operationId: definition.id,
      operationRevision: definition.revision,
      impact: (definition.execution as Record<string, unknown>).impact,
    });
  }
  const outcome = await executeExtendedConformanceCli(
    enabled.baseUrl,
    disabled.baseUrl,
    scenarioUrl,
    { pollIntervalMs: 1 },
  );
  assert.deepEqual(outcome, { exitCode: 0, stderr: "" });
  const processOutcome = await runBoundedChild({
    command: process.execPath,
    arguments: [
      "--import",
      "tsx",
      sourceCli,
      "--disabled-base-url",
      disabled.baseUrl,
      "--scenario",
      fileURLToPath(scenarioUrl),
      "--enabled-base-url",
      enabled.baseUrl,
    ],
    cwd: runnerRoot,
  });
  assert.equal(processOutcome.status, 0);
  assert.equal(processOutcome.stdout, "");
  assert.equal(processOutcome.stderr, "");

  assert.equal(disabled.requests.length, 15);
  assert.equal(disabled.requests.every(({ bodyBytes }) => bodyBytes === 0), true);
  assert.match(JSON.stringify([...enabled.requests, ...disabled.requests]), /^((?!731904).)*$/s);
});

test("the extended CLI rejects malformed grammar with one stable usage line", async () => {
  const outcome = await runBoundedChild({
    command: process.execPath,
    arguments: ["--import", "tsx", sourceCli],
    cwd: runnerRoot,
  });
  assert.equal(outcome.status, 2);
  assert.equal(outcome.stdout, "");
  assert.equal(outcome.stderr,
    "Usage: gauntlet-conformance-extended"
    + " --enabled-base-url ABSOLUTE_HTTP_ORIGIN"
    + " --disabled-base-url ABSOLUTE_HTTP_ORIGIN"
    + " --scenario PATH\n");
});

test("a sanitized handler failure may omit its optional correlation ID", async (t) => {
  const scenario = await loadAdapterV1ExtendedScenario(scenarioUrl);
  const enabled = await startExtendedFixtureAdapter({ scenario, enabled: true });
  const disabled = await startExtendedFixtureAdapter({ scenario, enabled: false });
  t.after(async () => await Promise.all([enabled.close(), disabled.close()]));
  const fetchWithoutCorrelation: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!String(input).includes("agency-applications.fail/runs") || response.status !== 201) {
      return response;
    }
    const run = await responseDocument(response);
    const problem = { ...(run.problem as Record<string, unknown>) };
    delete problem.correlationId;
    return replaceJson(response, { ...run, problem });
  };

  await runAdapterV1ExtendedConformance({
    enabledBaseUrl: enabled.baseUrl,
    disabledBaseUrl: disabled.baseUrl,
    scenario,
    fetch: fetchWithoutCorrelation,
    pollIntervalMs: 1,
  });
});

test("each extended branch independently detects a plausible adapter regression", async () => {
  const scenario = await loadAdapterV1ExtendedScenario(scenarioUrl);
  const mutations: ReadonlyArray<{
    readonly name: string;
    readonly disabledUsesEnabled?: boolean;
    mutate(input: RequestInfo | URL, init: RequestInit | undefined, response: Response): Promise<Response>;
  }> = [
    {
      name: "disabled precedence",
      disabledUsesEnabled: true,
      async mutate(_input, _init, response) { return response; },
    },
    {
      name: "handler failure detail",
      async mutate(input, _init, response) {
        if (String(input).includes("agency-applications.fail/runs") && response.status === 201) {
          const run = await responseDocument(response);
          run.problem = { ...(run.problem as Record<string, unknown>), detail: "private exception" };
          return replaceJson(response, run);
        }
        return response;
      },
    },
    {
      name: "handler failure extensions",
      async mutate(input, _init, response) {
        if (String(input).includes("agency-applications.fail/runs") && response.status === 201) {
          const run = await responseDocument(response);
          run.problem = {
            ...(run.problem as Record<string, unknown>),
            extensions: { "urn:example:diagnostics@1": { sql: "private query" } },
          };
          return replaceJson(response, run);
        }
        return response;
      },
    },
    {
      name: "cursor replay",
      async mutate(input, init, response) {
        if (String(input).endsWith("/data-sources/pending-applications/query") && init?.body !== undefined) {
          const request = JSON.parse(await new Response(init.body).text()) as Record<string, unknown>;
          if (request.cursor !== undefined && response.status === 200) {
            const page = await responseDocument(response);
            page.nextCursor = request.cursor;
            return replaceJson(response, page);
          }
        }
        return response;
      },
    },
    {
      name: "custom binding output",
      async mutate(input, _init, response) {
        if (String(input).includes("agency-applications.finalize/runs") && response.status === 201) {
          const run = await responseDocument(response);
          run.output = { finalized: false };
          return replaceJson(response, run);
        }
        return response;
      },
    },
  ];

  for (const regression of mutations) {
    const enabled = await startExtendedFixtureAdapter({ scenario, enabled: true });
    const disabled = regression.disabledUsesEnabled
      ? enabled
      : await startExtendedFixtureAdapter({ scenario, enabled: false });
    const fetchDouble: typeof fetch = async (input, init) =>
      await regression.mutate(input, init, await fetch(input, init));
    try {
      await assert.rejects(runAdapterV1ExtendedConformance({
        enabledBaseUrl: enabled.baseUrl,
        disabledBaseUrl: disabled.baseUrl,
        scenario,
        fetch: fetchDouble,
        pollIntervalMs: 1,
      }), undefined, regression.name);
    } finally {
      await enabled.close();
      if (disabled !== enabled) await disabled.close();
    }
  }
});
