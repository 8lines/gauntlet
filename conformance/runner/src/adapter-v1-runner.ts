import {
  canonicalizeForRevision,
  validateRunTransition,
  validateRunSemantics,
  type AdapterManifest,
  type CapabilityId,
  type CreateRunRequest,
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
import {
  assertEndpointDocument,
  compileDeclaredSchema,
  validateManifest,
  validateOperation,
  validateResolve,
} from "./schema-validator.js";
import {
  validateAdapterV1Scenario,
  type AdapterV1Scenario,
} from "./scenario.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_TTL_MS = 15 * 60_000;
const UNSUPPORTED = "urn:gauntlet:problem:unsupported-capability";

export interface AdapterV1ConformanceOptions {
  readonly baseUrl: string;
  readonly scenario: AdapterV1Scenario;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxResponseBytes?: number;
  readonly clock?: () => number;
}

interface RunDocument extends Record<string, unknown> {
  readonly id: string;
  readonly operationId: string;
  readonly operationRevision: string;
  readonly sequence: number;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly progress?: Record<string, unknown>;
  readonly summary?: Record<string, unknown>;
  readonly output?: unknown;
  readonly artifacts: readonly Record<string, unknown>[];
  readonly actions: readonly Record<string, unknown>[];
}

interface ValidatedOptions {
  readonly baseUrl: string;
  readonly scenario: AdapterV1Scenario;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs: number;
  readonly pollTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly maxResponseBytes: number;
  readonly clock: () => number;
  readonly secret: string;
}

function fail(message: string): never {
  throw new ConformanceFailure(message);
}

function exactInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function validateOptions(options: AdapterV1ConformanceOptions): ValidatedOptions {
  let scenario: AdapterV1Scenario;
  try {
    scenario = validateAdapterV1Scenario(options.scenario);
    assertEndpointDocument("dataSourceQuery", scenario.dataSourceQuery);
    assertEndpointDocument("dataSourceResolveRequest", scenario.dataSourceResolveRequest);
  } catch {
    throw new ConfigurationError("Invalid adapter-v1 scenario");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const clock = options.clock ?? Date.now;
  if (!exactInteger(requestTimeoutMs, MAX_TIMEOUT_MS)
    || !exactInteger(pollTimeoutMs, MAX_TIMEOUT_MS)
    || !exactInteger(pollIntervalMs, MAX_TIMEOUT_MS)
    || pollIntervalMs > pollTimeoutMs
    || !exactInteger(maxResponseBytes, MAX_RESPONSE_BYTES)
    || typeof clock !== "function") {
    throw new ConfigurationError("Invalid conformance runner option");
  }
  const secret = scenario.input.confirmationCode;
  if (typeof secret !== "string"
    || secret.length === 0
    || scenario.invalidInput.confirmationCode !== secret) {
    throw new ConfigurationError("Invalid adapter-v1 scenario");
  }
  return {
    baseUrl: options.baseUrl,
    scenario,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    requestTimeoutMs,
    pollTimeoutMs,
    pollIntervalMs,
    maxResponseBytes,
    clock,
    secret,
  };
}

function normalizedSet(value: readonly string[] | undefined): string {
  return JSON.stringify([...(value ?? [])].sort());
}

function sameRequirements(
  requirements: { readonly profiles?: readonly string[]; readonly capabilities?: readonly string[] } | undefined,
  scenario: AdapterV1Scenario,
): boolean {
  return normalizedSet(requirements?.profiles) === normalizedSet(scenario.requiredProfiles)
    && normalizedSet(requirements?.capabilities) === normalizedSet(scenario.requiredCapabilities);
}

function exactlyOne<T>(values: readonly T[], predicate: (value: T) => boolean, message: string): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) return fail(message);
  return matches[0]!;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function validateCrossDocumentContract(
  manifest: AdapterManifest,
  operation: OperationDefinition,
  scenario: AdapterV1Scenario,
): {
  readonly dependency: (value: unknown) => void;
  readonly context: (value: unknown) => void;
  readonly operationContext?: (value: unknown) => void;
  readonly input: (value: unknown) => void;
  readonly output: (value: unknown) => void;
} {
  const summary = exactlyOne(
    manifest.operations,
    ({ id }) => id === scenario.operationId,
    "Selected operation summary is missing or duplicated",
  );
  if (summary.availability.state !== "available") fail("Selected operation is unavailable");
  const source = exactlyOne(
    manifest.dataSources,
    ({ id }) => id === scenario.dataSourceId,
    "Selected data source is missing or duplicated",
  );
  if (!sameRequirements(summary.requirements, scenario)
    || scenario.requiredProfiles.some((profile) => !manifest.profiles.includes(profile))
    || scenario.requiredCapabilities.some((capability) => !manifest.capabilities.includes(capability))) {
    fail("Scenario requirements do not match the manifest");
  }
  if (operation.id !== summary.id
    || operation.revision !== summary.revision
    || operation.label !== summary.label
    || operation.featureId !== summary.featureId
    || !sameRequirements(operation.requirements, scenario)
    || canonical(operation.placements ?? [])
      !== canonical(summary.placements ?? [])) {
    fail("Operation definition does not match its manifest summary");
  }
  const reference = exactlyOne(
    operation.dataSources,
    ({ id }) => id === scenario.dataSourceId,
    "Selected data source reference is missing or duplicated",
  );
  if (!reference.dependencyPointers.includes("/workflowState")
    || source.capabilities.search !== true
    || scenario.dataSourceQuery.limit === undefined
    || scenario.dataSourceQuery.limit > source.capabilities.maxLimit) {
    fail("Selected data source capabilities do not satisfy the scenario");
  }
  if (source.dependencySchema === undefined || source.contextSchema === undefined) {
    fail("Selected data source must declare dependency and context schemas");
  }
  const dependency = compileDeclaredSchema(source.dependencySchema, "dependency");
  const context = compileDeclaredSchema(source.contextSchema, "context");
  for (const request of [scenario.dataSourceQuery, scenario.dataSourceResolveRequest]) {
    dependency(request.dependencies);
    context(request.context);
  }

  const schemaRecord = operation.inputSchema as unknown as Record<string, unknown>;
  const properties = record(schemaRecord.properties);
  const applicationId = record(properties?.applicationId);
  const confirmationCode = record(properties?.confirmationCode);
  const required = schemaRecord.required;
  if (!Array.isArray(required)
    || !required.includes("applicationId")
    || !required.includes("confirmationCode")
    || schemaRecord.additionalProperties !== false
    || applicationId?.type !== "string"
    || applicationId.format !== "uuid"
    || confirmationCode?.type !== "string"
    || confirmationCode.pattern !== "^[0-9]{6}$"
    || operation.execution.idempotency !== "required"
    || !operation.inputHandling?.rules.some((rule) =>
      rule.kind === "secret"
      && rule.schemaPointer === "/properties/confirmationCode"
      && rule.retention === "none")) {
    fail("Operation definition does not expose the exact P0 input contract");
  }

  const input = compileDeclaredSchema(operation.inputSchema, "input");
  input(scenario.input);
  const operationContext = operation.contextSchema === undefined
    ? undefined
    : compileDeclaredSchema(operation.contextSchema, "context");
  let invalidPointer: string | undefined;
  try {
    input(scenario.invalidInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    invalidPointer = message.match(/rejected (\/\S*)$/)?.[1];
  }
  if (invalidPointer !== scenario.expectedValidationPointer) {
    fail("Invalid input does not fail at the expected validation pointer");
  }
  const output = compileDeclaredSchema(operation.output.schema, "output");
  return {
    dependency,
    context,
    ...(operationContext === undefined ? {} : { operationContext }),
    input,
    output,
  };
}

function terminal(state: string): boolean {
  return state !== "queued" && state !== "running";
}

function assertRunDocument(
  value: unknown,
  operation: OperationDefinition,
  manifest: AdapterManifest,
  outputValidator: (value: unknown) => void,
): RunDocument {
  const run = assertEndpointDocument<RunDocument>("run", value);
  const violation = validateRunSemantics(run as unknown as Run, {
    operationId: operation.id,
    operationRevision: operation.revision,
    operationIds: manifest.operations.map(({ id }) => id),
    outputIsValid: (output) => {
      try {
        outputValidator(output);
        return true;
      } catch {
        return false;
      }
    },
  });
  if (violation !== undefined) {
    fail(`Run semantics are invalid at ${violation.instancePath || "/"} (${violation.code})`);
  }
  if (run.state === "succeeded") {
    if (run.progress === undefined
      || run.summary === undefined
      || run.output === undefined
      || run.artifacts.length === 0
      || run.actions.length === 0) {
      fail("Succeeded Run is missing P0 terminal data");
    }
  }
  return run;
}

function canonical(value: unknown): string {
  return canonicalizeForRevision(value as Parameters<typeof canonicalizeForRevision>[0]);
}

function assertProgression(previous: RunDocument, next: RunDocument): void {
  const violation = validateRunTransition(
    previous as unknown as Run,
    next as unknown as Run,
  );
  if (violation !== undefined) {
    fail(`Run transition is invalid at ${violation.instancePath || "/"} (${violation.code})`);
  }
}

function staleRevision(revision: OperationDefinition["revision"]): OperationDefinition["revision"] {
  const last = revision.at(-1)!;
  return `${revision.slice(0, -1)}${last === "0" ? "1" : "0"}` as OperationDefinition["revision"];
}

function createRequest(
  operation: OperationDefinition,
  operationRevision: OperationDefinition["revision"],
  input: JsonObject,
  requestId: string,
  idempotencyKey: string,
  dryRun = false,
): CreateRunRequest {
  return {
    operationRevision,
    input,
    context: {
      requestId,
      target: { id: "conformance-target", environment: "test" },
    },
    dryRun,
    idempotencyKey,
    ...(operation.execution.confirmationRequired
      ? {
          confirmation: {
            operationId: operation.id,
            operationRevision,
            impact: operation.execution.impact,
          },
        }
      : {}),
  };
}

type ValidatedCreateEnvelope = JsonObject & { readonly context: JsonObject };

function serializeCreateAttempt(
  document: CreateRunRequest,
  operationContext: ((value: unknown) => void) | undefined,
) {
  return serializeJsonRequest<ValidatedCreateEnvelope>(
    "createRunRequest",
    document,
    (validated) => operationContext?.(validated.context),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sessionOrigin(value: unknown): string {
  if (typeof value !== "string") return fail("Session URL is invalid");
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
      return fail("Session URL is invalid");
    }
    return url.origin;
  } catch {
    return fail("Session URL is invalid");
  }
}

async function execute(options: ValidatedOptions): Promise<void> {
  const { scenario } = options;
  const client = new AdapterV1HttpClient({
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    requestTimeoutMs: options.requestTimeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    secretSentinels: [options.secret],
  });

  const health = await client.getHealth(
    (value) => assertEndpointDocument<Record<string, unknown>>("health", value),
  );
  const manifestResult = await client.getManifest(validateManifest);
  if (manifestResult.notModified) fail("Manifest returned an unsolicited 304");
  const manifest = manifestResult.document;
  if (health.protocolVersion !== manifest.protocolVersion) fail("Health and manifest protocol versions differ");
  const conditionalManifest = await client.getManifest(validateManifest, manifestResult.etag);
  if (!conditionalManifest.notModified) fail("Conditional manifest request was not 304");

  const operationResult = await client.getOperation(scenario.operationId, validateOperation);
  if (operationResult.notModified) fail("Operation returned an unsolicited 304");
  const operation = operationResult.document;
  const conditionalOperation = await client.getOperation(scenario.operationId, validateOperation, operationResult.etag);
  if (!conditionalOperation.notModified) fail("Conditional operation request was not 304");

  const dynamic = validateCrossDocumentContract(manifest, operation, scenario);

  const staleBody = serializeCreateAttempt(createRequest(
    operation,
    staleRevision(operation.revision),
    scenario.input,
    "conformance-stale-01",
    "conformance-finalize-01-stale",
  ), dynamic.operationContext);
  await client.expectCreateProblem(
    scenario.operationId,
    staleBody,
    409,
    "urn:gauntlet:problem:stale-operation-revision",
  );

  const invalidBody = serializeCreateAttempt(createRequest(
    operation,
    operation.revision,
    scenario.invalidInput,
    "conformance-invalid-01",
    "conformance-finalize-01-invalid",
  ), dynamic.operationContext);
  const invalidProblem = await client.expectCreateProblem(
    scenario.operationId,
    invalidBody,
    422,
    "urn:gauntlet:problem:validation-failed",
  );
  const validationErrors = invalidProblem.errors;
  if (!Array.isArray(validationErrors)
    || !validationErrors.some((error) => record(error)?.instancePath === scenario.expectedValidationPointer)) {
    fail("Validation Problem omitted the exact expected instance pointer");
  }

  const dryRunBody = serializeCreateAttempt(createRequest(
    operation,
    operation.revision,
    scenario.input,
    "conformance-dry-run-01",
    "conformance-finalize-01-dry-run",
    true,
  ), dynamic.operationContext);
  const dryRunProblem = await client.expectCreateProblem(
    scenario.operationId,
    dryRunBody,
    422,
    "urn:gauntlet:problem:validation-failed",
  );
  const dryRunErrors = dryRunProblem.errors;
  if (!Array.isArray(dryRunErrors)
    || !dryRunErrors.some((error) => record(error)?.instancePath === "/dryRun")) {
    fail("Dry-run rejection omitted the exact /dryRun instance pointer");
  }

  const freshBody = serializeCreateAttempt(createRequest(
    operation,
    operation.revision,
    scenario.input,
    "conformance-run-01",
    scenario.idempotencyKey,
  ), dynamic.operationContext);
  const created = await client.createRun(
    scenario.operationId,
    freshBody,
    (value) => assertRunDocument(value, operation, manifest, dynamic.output),
  );
  if ((created.status === 202 && terminal(created.document.state))
    || (created.status === 201 && !terminal(created.document.state))) {
    fail("Fresh create status and Run state are inconsistent");
  }

  const deadline = performance.now() + options.pollTimeoutMs;
  let current = created.document;
  do {
    const remainingTime = deadline - performance.now();
    if (remainingTime <= 0) fail("Run polling deadline expired");
    const remaining = Math.max(1, Math.ceil(remainingTime));
    let next: RunDocument;
    try {
      next = await client.getRun(
        current.id,
        (value) => assertRunDocument(value, operation, manifest, dynamic.output),
        Math.min(options.requestTimeoutMs, remaining),
      );
    } catch (error) {
      if (deadline - performance.now() <= 1) fail("Run polling deadline expired");
      throw error;
    }
    if (performance.now() > deadline) fail("Run polling deadline expired");
    assertProgression(current, next);
    current = next;
    if (!terminal(current.state)) {
      const sleepRemaining = deadline - performance.now();
      if (sleepRemaining <= options.pollIntervalMs) fail("Run polling deadline expired");
      await delay(options.pollIntervalMs);
      if (performance.now() >= deadline) fail("Run polling deadline expired");
    }
  } while (!terminal(current.state));

  if (current.state !== scenario.expectedTerminalState) fail("Run reached the wrong terminal state");
  const replay = await client.createRun(
    scenario.operationId,
    freshBody,
    (value) => assertRunDocument(value, operation, manifest, dynamic.output),
  );
  if (replay.status !== 201
    || replay.document.id !== current.id
    || canonical(replay.document) !== canonical(current)) {
    fail("Replay did not return the immutable terminal Run");
  }

  const queryBody = serializeJsonRequest("dataSourceQuery", scenario.dataSourceQuery);
  dynamic.dependency(scenario.dataSourceQuery.dependencies);
  dynamic.context(scenario.dataSourceQuery.context);
  await client.queryDataSource(
    scenario.dataSourceId,
    queryBody,
    (value) => assertEndpointDocument("dataSourcePage", value),
  );

  const resolveBody = serializeJsonRequest("dataSourceResolveRequest", scenario.dataSourceResolveRequest);
  dynamic.dependency(scenario.dataSourceResolveRequest.dependencies);
  dynamic.context(scenario.dataSourceResolveRequest.context);
  await client.resolveDataSource(
    scenario.dataSourceId,
    resolveBody,
    (value) => validateResolve(scenario.dataSourceResolveRequest, value),
  );

  await client.expectOperationProblem(
    "conformance-missing-operation",
    404,
    "urn:gauntlet:problem:operation-not-found",
  );
  await client.expectDataSourceProblem(
    "conformance-missing-data-source",
    queryBody,
    404,
    "urn:gauntlet:problem:data-source-not-found",
  );
  await client.expectRunProblem(
    "conformance-missing-run",
    404,
    "urn:gauntlet:problem:run-not-found",
  );
  await client.expectUnsafeOperationProblem();

  const capabilities = new Set(manifest.capabilities);
  if (!capabilities.has("tc-run-cancellation@1")) {
    await client.expectCancelProblem(current.id, 501, UNSUPPORTED, "tc-run-cancellation@1");
  }
  if (!capabilities.has("tc-run-sse@1")) {
    await client.expectEventsProblem(current.id, 501, UNSUPPORTED, "tc-run-sse@1");
  }
  if (!capabilities.has("tc-uploads@1")) {
    await client.expectUploadsProblem(501, UNSUPPORTED, "tc-uploads@1");
  }
  if (capabilities.has("tc-session-launch@1") && scenario.browserLaunch !== undefined) {
    const artifact = current.artifacts.find(({ id, kind }) =>
      id === scenario.browserLaunch?.artifactId && kind === "browser-launch");
    const action = current.actions.find(({ kind, artifactId }) =>
      kind === "browser-launch" && artifactId === scenario.browserLaunch?.artifactId);
    if (artifact === undefined || action === undefined) fail("Advertised session launch lacks its Run artifact/action");
    const session = await client.launchSession(
      current.id,
      scenario.browserLaunch.artifactId,
      (value) => assertEndpointDocument<Record<string, unknown>>("sessionLaunch", value),
    );
    if (session.singleUse !== true
      || sessionOrigin(session.url) !== scenario.browserLaunch.expectedPublicOrigin) {
      fail("Session launch response has the wrong origin or reuse policy");
    }
    const now = options.clock();
    const expiry = typeof session.expiresAt === "string"
      ? Date.parse(session.expiresAt)
      : Number.NaN;
    if (!Number.isFinite(now)
      || !Number.isFinite(expiry)
      || expiry <= now
      || expiry - now > MAX_SESSION_TTL_MS) {
      fail("Session launch must expire within the bounded future window");
    }
  } else if (!capabilities.has("tc-session-launch@1")) {
    await client.expectLaunchProblem(
      current.id,
      scenario.browserLaunch?.artifactId ?? "conformance-missing-artifact",
      501,
      UNSUPPORTED,
      "tc-session-launch@1",
    );
  }
}

export function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (redacted, secret) => secret.length === 0 ? redacted : redacted.replaceAll(secret, "[REDACTED]"),
    value,
  );
}

export async function runAdapterV1Conformance(options: AdapterV1ConformanceOptions): Promise<void> {
  const validated = validateOptions(options);
  try {
    await execute(validated);
  } catch (error) {
    const message = redactKnownSecrets(
      error instanceof Error ? error.message : "Adapter conformance failed",
      [validated.secret],
    );
    if (error instanceof ConfigurationError) throw new ConfigurationError(message);
    throw new ConformanceFailure(message);
  }
}
