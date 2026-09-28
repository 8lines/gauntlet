import {
  computeRevision,
  type AdapterManifest,
  type CreateRunRequest,
  type DataSourceQuery,
  type DataSourceResolveRequest,
  type JsonObject,
  type OperationDefinition,
  type Run,
  type RunEvent,
} from "@8lines/gauntlet-protocol";
import type {
  AdapterCatalog,
  CapabilityAvailability,
  CapabilityDispatch,
} from "@8lines/gauntlet-typescript-core";

const revisionA = `sha256:${"a".repeat(64)}`;
const timestamp = "2026-08-29T12:00:00Z";

const operationDraft = {
  id: "applications.finalize",
  label: "Finalize application",
  featureId: "applications",
  order: 10,
  tags: ["applications"],
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
  },
  dataSources: [],
  presets: [],
  execution: {
    impact: "write",
    confirmationRequired: true,
    dryRunSupported: false,
    idempotency: "optional",
    cancellationSupported: true,
  },
  output: {
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    },
  },
} as const;

export const fixtureOperation = Object.freeze({
  ...operationDraft,
  revision: computeRevision(operationDraft as unknown as JsonObject),
}) as OperationDefinition;

export const queuedRun: Run = Object.freeze({
  id: "run-1",
  operationId: fixtureOperation.id,
  operationRevision: fixtureOperation.revision,
  sequence: 0,
  state: "queued",
  createdAt: timestamp,
  updatedAt: timestamp,
  artifacts: [],
  actions: [],
});

export const terminalRun: Run = Object.freeze({
  ...queuedRun,
  sequence: 2,
  state: "succeeded",
  startedAt: timestamp,
  completedAt: "2026-08-29T12:00:01Z",
  updatedAt: "2026-08-29T12:00:01Z",
  output: { finalized: true },
});

const baseManifest = {
  protocolVersion: "1.0",
  schemaDialect: "https://json-schema.org/draft/2020-12/schema",
  profiles: ["tc-schema-core@1"],
  capabilities: [],
  application: {
    id: "fixture",
    label: "Fixture",
    environment: { name: "fixture-test", kind: "test" },
  },
  features: [{ id: "applications", label: "Applications" }],
  operations: [{
    id: fixtureOperation.id,
    revision: fixtureOperation.revision,
    label: fixtureOperation.label,
    featureId: fixtureOperation.featureId,
    availability: { state: "available" },
  }],
  dataSources: [{
    id: "applications",
    label: "Applications",
    capabilities: {
      search: true,
      pagination: "cursor",
      resolve: true,
      defaultLimit: 10,
      maxLimit: 20,
    },
  }],
} as const;

export const fixtureManifest = Object.freeze({
  ...baseManifest,
  manifestRevision: computeRevision(baseManifest as unknown as JsonObject, "manifestRevision"),
}) as AdapterManifest;

export interface FixtureCatalogState {
  creates: number;
  queries: number;
  resolves: number;
  uploads: number;
  cancellations: number;
  launches: number;
}

export function createFixtureCatalog(options: {
  readonly capabilities?: readonly (
    | "tc-run-cancellation@1"
    | "tc-run-sse@1"
    | "tc-uploads@1"
    | "tc-session-launch@1"
  )[];
  readonly throwOnQuery?: boolean;
} = {}): { readonly catalog: AdapterCatalog; readonly state: FixtureCatalogState } {
  const installed = new Set(options.capabilities ?? []);
  const manifestBase = {
    ...baseManifest,
    capabilities: [...installed].sort(),
  };
  const manifest = Object.freeze({
    ...manifestBase,
    manifestRevision: computeRevision(manifestBase as unknown as JsonObject, "manifestRevision"),
  }) as AdapterManifest;
  const state: FixtureCatalogState = {
    creates: 0,
    queries: 0,
    resolves: 0,
    uploads: 0,
    cancellations: 0,
    launches: 0,
  };
  const availability = (capability: Parameters<AdapterCatalog["capabilityAvailability"]>[0]): CapabilityAvailability =>
    installed.has(capability)
      ? { supported: true }
      : {
          supported: false,
          problem: {
            type: "urn:gauntlet:problem:unsupported-capability",
            title: "Unsupported capability",
            status: 501,
            capability,
          },
        };
  const unsupported = <T>(capability: Parameters<AdapterCatalog["capabilityAvailability"]>[0]): CapabilityDispatch<T> => ({
    ok: false,
    problem: {
      type: "urn:gauntlet:problem:unsupported-capability",
      title: "Unsupported capability",
      status: 501,
      capability,
    },
  });
  const catalog: AdapterCatalog = {
    health: () => ({ status: "ok", protocolVersion: "1.0" }),
    manifest: () => manifest,
    operation: (operationId) => operationId === fixtureOperation.id ? fixtureOperation : undefined,
    createRun: async (_operationId: string, _request: CreateRunRequest) => {
      state.creates += 1;
      return { ok: true, run: state.creates === 1 ? queuedRun : terminalRun };
    },
    run: async (runId) => runId === queuedRun.id ? terminalRun : undefined,
    queryDataSource: async (_dataSourceId: string, _request: DataSourceQuery) => {
      state.queries += 1;
      if (options.throwOnQuery) throw new Error("private query failure");
      return { items: [{ value: "app-1", label: "Application 1" }] };
    },
    resolveDataSource: async (_dataSourceId: string, request: DataSourceResolveRequest) => {
      state.resolves += 1;
      return {
        results: request.values.map((value) => ({
          value,
          item: value === "app-1" ? { value, label: "Application 1" } : null,
        })),
      };
    },
    capabilityAvailability: availability,
    cancelRun: async () => {
      if (!installed.has("tc-run-cancellation@1")) return unsupported("tc-run-cancellation@1");
      state.cancellations += 1;
      return { ok: true, value: terminalRun };
    },
    runEvents: async () => {
      if (!installed.has("tc-run-sse@1")) return unsupported("tc-run-sse@1");
      const event: RunEvent = {
        id: "event-1",
        sequence: terminalRun.sequence,
        occurredAt: terminalRun.updatedAt,
        type: "run.updated",
        run: terminalRun,
      };
      return {
        ok: true,
        value: (async function* () {
          yield event;
        })(),
      };
    },
    createUpload: async () => {
      if (!installed.has("tc-uploads@1")) return unsupported("tc-uploads@1");
      state.uploads += 1;
      return {
        ok: true,
        value: {
          file: {
            kind: "file",
            uploadId: "upload-1",
            name: "fixture.txt",
            mediaType: "text/plain",
            sizeBytes: 7,
            expiresAt: "2026-08-29T13:00:00Z",
          },
        },
      };
    },
    launchSession: async () => {
      if (!installed.has("tc-session-launch@1")) return unsupported("tc-session-launch@1");
      state.launches += 1;
      return {
        ok: true,
        value: {
          url: "https://portal.example.test/session/one",
          expiresAt: "2026-08-29T12:15:00Z",
          singleUse: true,
        },
      };
    },
  };
  return { catalog, state };
}

export function boundary(
  method: string,
  rawTarget: string,
  body?: BodyInit,
  headers: HeadersInit = {},
) {
  return {
    kind: "raw" as const,
    rawTarget,
    request: new Request(`http://adapter${rawTarget.replace(/[\s]/g, "")}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  };
}
