import {
  assertNonProductionEnvironment,
  computeRevision,
  operationSemanticsAreValid,
  resolveSemanticsAreValid,
  type AdapterHealth,
  type AdapterDiagnostic,
  type AdapterManifest,
  type ApplicationMetadata,
  type CapabilityId,
  type CoreCapabilityId,
  type CreateRunRequest,
  type DataSourcePage,
  type DataSourceQuery,
  type DataSourceResolveRequest,
  type DataSourceResolveResponse,
  type JsonObject,
  type JsonValue,
  type OperationDefinition,
  type OperationSummary,
  type Problem,
  type ProfileId,
  type ProtocolId,
  type Run,
  type RunEvent,
  type SessionLaunchResponse,
  type UploadResponse,
  PAGE_PLACEMENTS_PROFILE,
} from "@8lines/gauntlet-protocol";
import { CapabilityRegistry } from "./capability-registry.js";
import { DataSourceRegistry } from "./data-source-registry.js";
import { OperationRegistry } from "./operation-registry.js";
import { cloneAndDeepFreeze } from "./operation-internals.js";
import {
  dataSourceNotFoundProblem,
  operationNotFoundProblem,
  validationFailedProblem,
} from "./problems.js";
import { RunManager, type RunProjectionExpectation } from "./run-manager.js";
import {
  ownCanonicalAdapterManifest,
  ownCanonicalDataSourcePage,
  ownCanonicalDataSourceResolveResponse,
  ownCanonicalRun,
  ownCanonicalRunEvent,
  ownCanonicalProblem,
  ownCanonicalSessionLaunchResponse,
  ownCanonicalUploadResponse,
  validateCanonicalDataSourceQuery,
  validateCanonicalDataSourceResolveRequest,
} from "./runtime-validation.js";
import type { SchemaValidator } from "./schema-validator.js";

export type CapabilityDispatch<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: Problem };
export type CapabilityAvailability = { readonly supported: true } | { readonly supported: false; readonly problem: Problem };

export class AdapterCatalogError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.title);
    this.name = "AdapterCatalogError";
    this.problem = cloneAndDeepFreeze(problem);
  }
}

export interface AdapterCatalog {
  health(): AdapterHealth;
  manifest(): AdapterManifest;
  operation(operationId: string): OperationDefinition | undefined;
  createRun(operationId: string, request: CreateRunRequest): ReturnType<RunManager["create"]>;
  run(runId: string): Promise<Run | undefined>;
  runProjectionIsValid?(run: Run, expected?: RunProjectionExpectation): Promise<boolean>;
  queryDataSource(dataSourceId: string, request: DataSourceQuery): Promise<DataSourcePage>;
  resolveDataSource(dataSourceId: string, request: DataSourceResolveRequest): Promise<DataSourceResolveResponse>;
  capabilityAvailability(capability: CoreCapabilityId): CapabilityAvailability;
  cancelRun(runId: ProtocolId): Promise<CapabilityDispatch<Run>>;
  runEvents(runId: ProtocolId, lastEventId?: string): Promise<CapabilityDispatch<AsyncIterable<RunEvent>>>;
  createUpload(file: Blob): Promise<CapabilityDispatch<UploadResponse>>;
  launchSession(runId: ProtocolId, artifactId: ProtocolId): Promise<CapabilityDispatch<SessionLaunchResponse>>;
}

export interface AdapterCatalogOptions {
  readonly application: ApplicationMetadata;
  readonly profiles: readonly ProfileId[];
  readonly capabilities: CapabilityRegistry;
  readonly operations: OperationRegistry;
  readonly dataSources: DataSourceRegistry;
  readonly runs: RunManager;
  readonly schemaValidator: SchemaValidator;
  readonly now?: () => string;
}

function unavailable(capability: CapabilityId): Problem {
  return Object.freeze({ type: "urn:gauntlet:problem:unsupported-capability" as const, title: "Unsupported capability", status: 501, detail: "The adapter does not advertise or implement this capability.", capability });
}
function operationUnavailable(): Problem {
  return Object.freeze({ type: "urn:gauntlet:problem:adapter-unavailable" as const, title: "Operation unavailable", status: 503, detail: "The operation requirements are not available in this adapter." });
}
function validatePage(value: DataSourcePage): DataSourcePage {
  return ownCanonicalDataSourcePage(value);
}
function validateResolve(request: DataSourceResolveRequest, value: DataSourceResolveResponse): DataSourceResolveResponse {
  const response = ownCanonicalDataSourceResolveResponse(value);
  if (!resolveSemanticsAreValid(request, response)) throw new TypeError("Invalid data source resolve response");
  return response;
}

export function createAdapterCatalog(options: AdapterCatalogOptions): AdapterCatalog {
  const ownedApplication = cloneAndDeepFreeze(options.application);
  const environment = assertNonProductionEnvironment(ownedApplication.environment);
  const application = cloneAndDeepFreeze({ ...ownedApplication, environment });
  const ownedProfiles = cloneAndDeepFreeze(options.profiles);
  const usesPlacements = options.operations.operations()
    .some(({ definition }) => definition.placements !== undefined);
  const profiles = Object.freeze([
    ...new Set([...ownedProfiles, ...(usesPlacements ? [PAGE_PLACEMENTS_PROFILE as ProfileId] : [])]),
  ].sort()) as readonly ProfileId[];
  const managedCancel = (options.runs as RunManager & {
    cancel?: RunManager["cancel"];
  }).cancel;
  const capabilities = cloneAndDeepFreeze([
    ...new Set<CapabilityId>([
      ...options.capabilities.ids(),
      ...(typeof managedCancel === "function" ? ["tc-run-cancellation@1" as const] : []),
    ]),
  ].sort());
  const capabilitySet = new Set(capabilities);
  const profileSet = new Set(profiles);
  const diagnostics: AdapterDiagnostic[] = [];
  const summaries: OperationSummary[] = [];
  const includedOperationIds = new Set<string>();
  for (const { definition } of options.operations.operations()) {
    const missingDataSource = definition.dataSources.some(({ id }) => options.dataSources.get(id) === undefined);
    if (!operationSemanticsAreValid(definition) || missingDataSource) {
      diagnostics.push(cloneAndDeepFreeze({
        severity: "error" as const,
        code: "invalid-operation-binding",
        message: "The operation binding is invalid and was omitted.",
        operationId: definition.id,
      }));
      continue;
    }
    const requirements = definition.requirements;
    const available = requirements?.profiles?.every((id) => profileSet.has(id)) !== false
      && requirements?.capabilities?.every((id) => capabilitySet.has(id)) !== false;
    summaries.push(cloneAndDeepFreeze({ id: definition.id, revision: definition.revision, label: definition.label, featureId: definition.featureId,
      availability: available ? { state: "available" as const } : { state: "unavailable" as const, problem: operationUnavailable() },
      ...(requirements === undefined ? {} : { requirements }),
      ...(definition.placements === undefined ? {} : { placements: definition.placements }), }));
    includedOperationIds.add(definition.id);
  }
  const base = {
    protocolVersion: "1.0" as const,
    schemaDialect: "https://json-schema.org/draft/2020-12/schema" as const,
    profiles,
    capabilities,
    application,
    features: options.operations.features(),
    operations: summaries,
    dataSources: options.dataSources.definitions(),
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  };
  const manifest = ownCanonicalAdapterManifest(cloneAndDeepFreeze({
    ...base,
    manifestRevision: computeRevision(base as unknown as JsonObject, "manifestRevision"),
  }) as AdapterManifest);
  const summaryIndex = new Map(manifest.operations.map((summary) => [summary.id, summary]));

  const preflight = (capability: CoreCapabilityId): CapabilityAvailability => {
    const supported = capabilitySet.has(capability);
    return supported ? { supported: true } : { supported: false, problem: unavailable(capability) };
  };
  const validateEnvelope = async (
    schema: JsonObject | undefined,
    value: JsonValue | undefined,
    instancePath: "/dependencies" | "/context",
  ): Promise<void> => {
    if (schema === undefined) return;
    if (value === undefined) {
      throw new AdapterCatalogError(validationFailedProblem([{
        instancePath,
        schemaPath: "#",
        keyword: "required",
        message: "value does not satisfy schema",
        params: {},
      }]));
    }
    const errors = cloneAndDeepFreeze(await options.schemaValidator.validate(
      schema,
      cloneAndDeepFreeze(value),
    ));
    if (errors.length > 0) throw new AdapterCatalogError(validationFailedProblem(errors));
  };

  const catalog: AdapterCatalog = {
    health: () => ({ status: "ok" as const, protocolVersion: "1.0" as const }),
    manifest: () => manifest,
    operation: (id) => {
      if (!includedOperationIds.has(id)) return undefined;
      const value = options.operations.get(id)?.definition;
      return value && operationSemanticsAreValid(value) ? value : undefined;
    },
    createRun: async (id, request) => {
      const summary = summaryIndex.get(id);
      if (summary === undefined) return { ok: false as const, problem: operationNotFoundProblem() };
      if (summary.availability.state === "unavailable") return { ok: false as const, problem: summary.availability.problem };
      return options.runs.create(id, request);
    },
    run: (id) => options.runs.get(id),
    runProjectionIsValid: (run, expected) => options.runs.runProjectionIsValid(run, expected),
    queryDataSource: async (id, request) => {
      const source = options.dataSources.get(id);
      if (!source) throw new AdapterCatalogError(dataSourceNotFoundProblem());
      const validated = validateCanonicalDataSourceQuery(request);
      if (validated.value === undefined) {
        throw new AdapterCatalogError(validationFailedProblem(validated.errors));
      }
      const ownedRequest = validated.value;
      if ((!source.definition.capabilities.search && ownedRequest.search !== undefined)
        || (ownedRequest.limit !== undefined && ownedRequest.limit > source.definition.capabilities.maxLimit)) {
        throw new AdapterCatalogError(validationFailedProblem([]));
      }
      await validateEnvelope(source.definition.dependencySchema, ownedRequest.dependencies as JsonObject | undefined, "/dependencies");
      await validateEnvelope(source.definition.contextSchema, ownedRequest.context as JsonObject | undefined, "/context");
      return validatePage(await source.query(ownedRequest));
    },
    resolveDataSource: async (id, request) => {
      const source = options.dataSources.get(id);
      if (!source) throw new AdapterCatalogError(dataSourceNotFoundProblem());
      const validated = validateCanonicalDataSourceResolveRequest(request);
      if (validated.value === undefined) {
        throw new AdapterCatalogError(validationFailedProblem(validated.errors));
      }
      const ownedRequest = validated.value;
      await validateEnvelope(source.definition.dependencySchema, ownedRequest.dependencies as JsonObject | undefined, "/dependencies");
      await validateEnvelope(source.definition.contextSchema, ownedRequest.context as JsonObject | undefined, "/context");
      return validateResolve(ownedRequest, await source.resolve(ownedRequest));
    },
    capabilityAvailability: preflight,
    cancelRun: async (id) => {
      const endpoint = options.capabilities.cancellation();
      if (typeof managedCancel === "function") {
        const managed = await managedCancel.call(options.runs, id);
        if (managed !== null && typeof managed === "object" && Object.hasOwn(managed, "state")) {
          return { ok: true as const, value: ownCanonicalRun(managed as Run) };
        }
        const problem = ownCanonicalProblem(managed as Problem);
        if (problem.type !== "urn:gauntlet:problem:run-not-found") {
          return { ok: false as const, problem };
        }
        if (!endpoint) return { ok: false as const, problem };
      }
      if (!endpoint) return { ok: false as const, problem: unavailable("tc-run-cancellation@1") };
      return { ok: true as const, value: ownCanonicalRun(await endpoint.cancel(id)) };
    },
    runEvents: async (id, lastEventId) => {
      const endpoint = options.capabilities.events();
      if (!endpoint) return { ok: false as const, problem: unavailable("tc-run-sse@1") };
      const events = endpoint.events(id, lastEventId);
      return {
        ok: true as const,
        value: (async function* (): AsyncIterable<RunEvent> {
          for await (const event of events) yield ownCanonicalRunEvent(event);
        })(),
      };
    },
    createUpload: async (file) => {
      const endpoint = options.capabilities.uploads();
      return endpoint
        ? { ok: true as const, value: ownCanonicalUploadResponse(await endpoint.create(file)) }
        : { ok: false as const, problem: unavailable("tc-uploads@1") };
    },
    launchSession: async (runId, artifactId) => {
      const endpoint = options.capabilities.sessionLaunch();
      return endpoint
        ? { ok: true as const, value: ownCanonicalSessionLaunchResponse(await endpoint.create(runId, artifactId)) }
        : { ok: false as const, problem: unavailable("tc-session-launch@1") };
    },
  };
  return Object.freeze(catalog);
}
