import {
  canonicalizeForRevision,
  validateRunSemantics,
  validateRunTransition,
  type AdapterManifest,
  type DataSourcePage,
  type InvocationContext,
  type JsonObject,
  type OperationDefinition,
  type Run,
} from "@8lines/gauntlet-protocol";
import {
  AdapterV1HttpClient,
  ConfigurationError,
  ConformanceFailure,
  serializeJsonRequest,
} from "./http-client.js";
import { redactKnownSecrets } from "./adapter-v1-runner.js";
import {
  assertEndpointDocument,
  compileDeclaredSchema,
  validateManifest,
  validateOperation,
} from "./schema-validator.js";
import {
  validateAdapterV1ExtendedScenario,
  type AdapterV1ExtendedScenario,
} from "./extended-scenario.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_INTEGER_OPTION = 2_147_483_647;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface AdapterV1ExtendedConformanceOptions {
  readonly enabledBaseUrl: string;
  readonly disabledBaseUrl: string;
  readonly scenario: AdapterV1ExtendedScenario;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxResponseBytes?: number;
}

interface ValidatedOptions extends Required<Pick<
  AdapterV1ExtendedConformanceOptions,
  | "enabledBaseUrl"
  | "disabledBaseUrl"
  | "scenario"
  | "requestTimeoutMs"
  | "pollTimeoutMs"
  | "pollIntervalMs"
  | "maxResponseBytes"
>> {
  readonly fetch?: typeof globalThis.fetch;
}

interface InvocationCase {
  readonly operationId: string;
  readonly input: JsonObject;
  readonly context: InvocationContext;
  readonly idempotencyKey: string;
}

function fail(message: string): never {
  throw new ConformanceFailure(message);
}

function positiveInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function validateOptions(options: AdapterV1ExtendedConformanceOptions): ValidatedOptions {
  let scenario: AdapterV1ExtendedScenario;
  try {
    scenario = validateAdapterV1ExtendedScenario(options.scenario);
  } catch {
    throw new ConfigurationError("Invalid adapter-v1 extended scenario");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!positiveInteger(requestTimeoutMs, MAX_INTEGER_OPTION)
    || !positiveInteger(pollTimeoutMs, MAX_INTEGER_OPTION)
    || !positiveInteger(pollIntervalMs, MAX_INTEGER_OPTION)
    || pollIntervalMs > pollTimeoutMs
    || !positiveInteger(maxResponseBytes, MAX_RESPONSE_BYTES)) {
    throw new ConfigurationError("Invalid extended conformance runner option");
  }
  return {
    enabledBaseUrl: options.enabledBaseUrl,
    disabledBaseUrl: options.disabledBaseUrl,
    scenario,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    requestTimeoutMs,
    pollTimeoutMs,
    pollIntervalMs,
    maxResponseBytes,
  };
}

function terminal(run: Run): boolean {
  return run.state !== "queued" && run.state !== "running";
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalizeForRevision(left as Parameters<typeof canonicalizeForRevision>[0])
    === canonicalizeForRevision(right as Parameters<typeof canonicalizeForRevision>[0]);
}

function operationContract(
  manifest: AdapterManifest,
  operation: OperationDefinition,
  expectedId: string,
): (value: unknown) => Run {
  const summaries = manifest.operations.filter(({ id }) => id === expectedId);
  if (summaries.length !== 1) fail("Extended operation summary is missing or duplicated");
  const summary = summaries[0]!;
  if (summary.availability.state !== "available"
    || operation.id !== summary.id
    || operation.revision !== summary.revision
    || operation.label !== summary.label
    || operation.featureId !== summary.featureId
    || !sameJson(operation.requirements ?? {}, summary.requirements ?? {})
    || !sameJson(operation.placements ?? [], summary.placements ?? [])) {
    fail("Extended operation does not match its available summary");
  }
  const output = compileDeclaredSchema(operation.output.schema, "output");
  return (value) => {
    const run = assertEndpointDocument<Run>("run", value);
    const violation = validateRunSemantics(run, {
      operationId: operation.id,
      operationRevision: operation.revision,
      operationIds: manifest.operations.map(({ id }) => id),
      outputIsValid: (candidate) => {
        try {
          output(candidate);
          return true;
        } catch {
          return false;
        }
      },
    });
    if (violation !== undefined) {
      fail(`Extended Run is invalid at ${violation.instancePath || "/"}`);
    }
    return run;
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function invoke(
  client: AdapterV1HttpClient,
  manifest: AdapterManifest,
  invocation: InvocationCase,
  options: ValidatedOptions,
): Promise<Run> {
  const operationResult = await client.getOperation(invocation.operationId, validateOperation);
  if (operationResult.notModified) fail("Extended operation returned an unsolicited 304");
  const operation = operationResult.document;
  const validateRun = operationContract(manifest, operation, invocation.operationId);
  compileDeclaredSchema(operation.inputSchema, "input")(invocation.input);
  if (operation.contextSchema !== undefined) {
    compileDeclaredSchema(operation.contextSchema, "context")(invocation.context);
  }
  const body = serializeJsonRequest("createRunRequest", {
    operationRevision: operation.revision,
    input: invocation.input,
    context: invocation.context,
    idempotencyKey: invocation.idempotencyKey,
    ...(operation.execution.confirmationRequired
      ? {
          confirmation: {
            operationId: operation.id,
            operationRevision: operation.revision,
            impact: operation.execution.impact,
          },
        }
      : {}),
  });
  const created = await client.createRun(invocation.operationId, body, validateRun);
  if ((created.status === 201 && !terminal(created.document))
    || (created.status === 202 && terminal(created.document))) {
    fail("Extended create status does not match the Run state");
  }

  let current = created.document;
  const deadline = performance.now() + options.pollTimeoutMs;
  while (!terminal(current)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) fail("Extended Run polling deadline expired");
    const next = await client.getRun(
      current.id,
      validateRun,
      Math.min(options.requestTimeoutMs, Math.max(1, Math.ceil(remaining))),
    );
    const violation = validateRunTransition(current, next);
    if (violation !== undefined) fail(`Extended Run transition is invalid at ${violation.instancePath || "/"}`);
    current = next;
    if (!terminal(current)) {
      if (deadline - performance.now() <= options.pollIntervalMs) fail("Extended Run polling deadline expired");
      await delay(options.pollIntervalMs);
    }
  }
  return current;
}

function assertSanitizedFailure(run: Run): void {
  if (run.state !== "failed"
    || run.problem.type !== "urn:gauntlet:problem:handler-failed"
    || run.problem.title !== "Operation failed"
    || run.problem.status !== 500) {
    fail("Handler failure was not normalized to the canonical failed Run");
  }
  const allowed = new Set(["type", "title", "status", "correlationId"]);
  if (Object.keys(run.problem).some((key) => !allowed.has(key))) {
    fail("Handler failure exposed non-canonical diagnostics");
  }
}

async function assertPagination(
  client: AdapterV1HttpClient,
  manifest: AdapterManifest,
  scenario: AdapterV1ExtendedScenario["pagination"],
): Promise<void> {
  const definitions = manifest.dataSources.filter(({ id }) => id === scenario.dataSourceId);
  if (definitions.length !== 1) fail("Extended data source is missing or duplicated");
  const definition = definitions[0]!;
  if (definition.capabilities.pagination !== "cursor"
    || definition.dependencySchema === undefined
    || definition.contextSchema === undefined) {
    fail("Extended data source does not declare cursor pagination schemas");
  }
  compileDeclaredSchema(definition.dependencySchema, "dependency")(scenario.query.dependencies);
  compileDeclaredSchema(definition.contextSchema, "context")(scenario.query.context);

  const values = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    if (pageCount >= scenario.maximumPages) fail("Cursor pagination exceeded its bounded page count");
    const query = cursor === undefined ? scenario.query : { ...scenario.query, cursor };
    const page = await client.queryDataSource(
      scenario.dataSourceId,
      serializeJsonRequest("dataSourceQuery", query),
      (value) => assertEndpointDocument<DataSourcePage>("dataSourcePage", value),
    );
    pageCount += 1;
    if (page.items.length === 0 || page.items.length > 1) fail("Cursor page violates the requested limit");
    for (const item of page.items) {
      if (values.has(item.value)) fail("Cursor pagination repeated a data-source item");
      values.add(item.value);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursor.length === 0 || cursors.has(cursor)) fail("Cursor pagination repeated a cursor");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);

  if (cursors.size === 0 || values.size < scenario.minimumDistinctItems) {
    fail("Cursor pagination did not traverse enough distinct items");
  }
}

async function execute(options: ValidatedOptions): Promise<void> {
  const commonClientOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    requestTimeoutMs: options.requestTimeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    secretSentinels: options.scenario.secretSentinels,
  };
  const disabled = new AdapterV1HttpClient({
    ...commonClientOptions,
    baseUrl: options.disabledBaseUrl,
  });
  await disabled.expectAdapterDisabledPrecedence(options.scenario.handlerFailure.operationId);

  const enabled = new AdapterV1HttpClient({
    ...commonClientOptions,
    baseUrl: options.enabledBaseUrl,
  });
  const manifestResult = await enabled.getManifest(validateManifest);
  if (manifestResult.notModified) fail("Extended manifest returned an unsolicited 304");
  const manifest = manifestResult.document;

  const failed = await invoke(enabled, manifest, options.scenario.handlerFailure, options);
  assertSanitizedFailure(failed);

  await assertPagination(enabled, manifest, options.scenario.pagination);

  const custom = await invoke(enabled, manifest, options.scenario.customBinding, options);
  if (custom.state !== "succeeded"
    || custom.output === undefined
    || !sameJson(custom.output, options.scenario.customBinding.expectedOutput)
    || custom.artifacts.filter(({ id }) => id === options.scenario.customBinding.expectedArtifactId).length !== 1) {
    fail("Custom binding did not execute through the normalized operation route");
  }
}

export async function runAdapterV1ExtendedConformance(
  options: AdapterV1ExtendedConformanceOptions,
): Promise<void> {
  const validated = validateOptions(options);
  try {
    await execute(validated);
  } catch (error) {
    const message = redactKnownSecrets(
      error instanceof Error ? error.message : "Extended adapter conformance failed",
      validated.scenario.secretSentinels,
    );
    if (error instanceof ConfigurationError) throw new ConfigurationError(message);
    throw new ConformanceFailure(message);
  }
}
