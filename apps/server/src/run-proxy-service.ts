import type {
  AdapterClient,
  AdapterRunEventStream,
  AdapterTarget,
  ClientResult,
} from "@8lines/gauntlet-dashboard-client";
import {
  canonicalRunIsValid,
  operationActionInputIsValid,
  operationRunIsValid,
  validateCreateRunRequest,
} from "@8lines/gauntlet-dashboard-client";
import {
  canonicalizeForRevision,
  runTransitionIsValid,
  type AdapterManifest,
  type CapabilityId,
  type CreateRunRequest,
  type JsonObject,
  type OperationDefinition,
  type OperationSummary,
  type Problem,
  type ProtocolRequirements,
  type Run,
  type RunEvent,
  type SessionLaunchResponse,
  type UploadResponse,
} from "@8lines/gauntlet-protocol";
import type {
  CompatibleTargetResult,
  ManifestService,
} from "./manifest-service.js";
import { ownFrozenJson } from "./ownership.js";
import { safeRunProjection } from "./safe-problem.js";
import type { TargetRegistry } from "./target-registry.js";
import type { GauntletStore } from "./gauntlet-store.js";

const INVALID_RESPONSE: Problem = Object.freeze({
  type: "urn:gauntlet:problem:adapter-invalid-response",
  title: "Invalid adapter response",
  status: 502,
});
const OPERATION_NOT_FOUND: Problem = Object.freeze({
  type: "urn:gauntlet:problem:operation-not-found",
  title: "Operation not found",
  status: 404,
});
const RUN_NOT_FOUND: Problem = Object.freeze({
  type: "urn:gauntlet:problem:run-not-found",
  title: "Run not found",
  status: 404,
});
const ARTIFACT_NOT_FOUND: Problem = Object.freeze({
  type: "urn:gauntlet:problem:artifact-not-found",
  title: "Artifact not found",
  status: 404,
});
const VALIDATION_FAILED: Problem = Object.freeze({
  type: "urn:gauntlet:problem:validation-failed",
  title: "Request validation failed",
  status: 422,
});
const STALE_REVISION: Problem = Object.freeze({
  type: "urn:gauntlet:problem:stale-operation-revision",
  title: "Stale operation revision",
  status: 409,
});
const LAUNCH_UNAVAILABLE: Problem = Object.freeze({
  type: "urn:gauntlet:problem:session-launch-unavailable",
  title: "Session launch unavailable",
  status: 409,
});
const MAX_SESSION_TTL_MS = 15 * 60_000;

export type ResolvedOperationResult =
  | {
      readonly ok: true;
      readonly target: AdapterTarget;
      readonly manifest: AdapterManifest;
      readonly summary: OperationSummary;
      readonly definition: OperationDefinition;
    }
  | { readonly ok: false; readonly problem: Problem };

export interface RunProxyService {
  resolveOperation(targetId: string, operationId: string): Promise<ResolvedOperationResult>;
  create(targetId: string, operationId: string, request: unknown): Promise<ClientResult<Run>>;
  get(targetId: string, runId: string): Promise<ClientResult<Run>>;
  createUpload(targetId: string, file: Blob, fileName?: string): Promise<ClientResult<UploadResponse>>;
  cancel(targetId: string, runId: string): Promise<ClientResult<Run>>;
  streamEvents(targetId: string, runId: string, lastEventId?: string): Promise<ClientResult<AdapterRunEventStream>>;
  createSessionLaunch(targetId: string, runId: string, artifactId: string): Promise<ClientResult<SessionLaunchResponse>>;
}

export interface RunProxyServiceOptions {
  readonly registry: TargetRegistry;
  readonly client: AdapterClient;
  readonly manifests: ManifestService;
  readonly store: GauntletStore;
  readonly clock?: () => Date;
}

function failure<T>(problem: Problem): ClientResult<T> {
  return { ok: false, problem };
}

function confirmationFailure(instancePath: string, keyword: "required" | "const"): Problem {
  return Object.freeze({
    ...VALIDATION_FAILED,
    errors: Object.freeze([Object.freeze({
      instancePath,
      schemaPath: "#",
      keyword,
      message: keyword === "required" ? "Required value is missing" : "Invalid value",
      params: Object.freeze({}),
    })]),
  });
}

function confirmationProblem(
  operationId: string,
  operation: OperationDefinition,
  request: CreateRunRequest,
): Problem | undefined {
  if (operation.execution.confirmationRequired !== true) return undefined;
  const confirmation = request.confirmation;
  if (confirmation === undefined) {
    return confirmationFailure("/confirmation", "required");
  }
  if (confirmation.operationId !== operationId) {
    return confirmationFailure("/confirmation/operationId", "const");
  }
  if (confirmation.operationRevision !== operation.revision) {
    return confirmationFailure("/confirmation/operationRevision", "const");
  }
  if (confirmation.impact !== operation.execution.impact) {
    return confirmationFailure("/confirmation/impact", "const");
  }
  return undefined;
}

function unsupportedCapability(capability: CapabilityId): Problem {
  return Object.freeze({
    type: "urn:gauntlet:problem:unsupported-capability",
    title: "Unsupported capability",
    status: 501,
    capability,
  });
}

class PublicEventStreamError extends Error {
  constructor() {
    super("Adapter event stream failed");
  }
}

function requirementsKey(requirements: ProtocolRequirements | undefined): string {
  return canonicalizeForRevision((requirements ?? {}) as JsonObject);
}

function declaredByManifest(definition: OperationDefinition, manifest: AdapterManifest): boolean {
  const profiles = new Set(manifest.profiles);
  const capabilities = new Set(manifest.capabilities);
  const dataSources = new Set(manifest.dataSources.map(({ id }) => id));
  return definition.requirements?.profiles?.every((profile) => profiles.has(profile)) !== false
    && definition.requirements?.capabilities?.every((capability) => capabilities.has(capability)) !== false
    && definition.dataSources.every(({ id }) => dataSources.has(id));
}

function definitionMatchesSummary(definition: OperationDefinition, summary: OperationSummary): boolean {
  return definition.id === summary.id
    && definition.revision === summary.revision
    && definition.label === summary.label
    && definition.featureId === summary.featureId
    && requirementsKey(definition.requirements) === requirementsKey(summary.requirements);
}

function safeAvailabilityProblem(summary: OperationSummary): Problem {
  if (summary.availability.state === "available") {
    return INVALID_RESPONSE;
  }
  const status = summary.availability.problem.status;
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? summary.availability.problem
    : INVALID_RESPONSE;
}

function projectionIsValid(previous: Run, incoming: Run): boolean {
  return runTransitionIsValid(previous, incoming);
}

export function createRunProxyService(options: RunProxyServiceOptions): RunProxyService {
  const clock = options.clock ?? (() => new Date());

  const readStoredRun = (
    targetId: string,
    runId: string,
  ):
    | { readonly state: "missing" }
    | { readonly state: "invalid" }
    | { readonly state: "valid"; readonly run: Run } => {
    try {
      const candidate = options.store.getRun(targetId, runId) as unknown;
      if (candidate === undefined) return { state: "missing" };
      const owned = safeRunProjection(ownFrozenJson(candidate) as Run);
      if (!canonicalRunIsValid(owned) || owned.id !== runId) return { state: "invalid" };
      return { state: "valid", run: owned };
    } catch {
      return { state: "invalid" };
    }
  };

  const saveProjection = async (
    target: AdapterTarget,
    incoming: Run,
    definition: OperationDefinition,
    manifest: AdapterManifest,
  ): Promise<ClientResult<Run>> => {
    const definitions = new Map<string, Promise<OperationDefinition | undefined>>([
      [definition.id, Promise.resolve(definition)],
    ]);
    const validationTime = clock();

    try {
      const ownedIncoming = safeRunProjection(ownFrozenJson(incoming));
      if (!operationRunIsValid(ownedIncoming, definition, manifest)
        || !await projectionActionsAreValid(
          target,
          ownedIncoming,
          definition,
          manifest,
          definitions,
          validationTime,
        )) {
        return failure(INVALID_RESPONSE);
      }
      const previousRead = readStoredRun(target.id, ownedIncoming.id);
      if (previousRead.state === "invalid") {
        return failure(INVALID_RESPONSE);
      }
      const previous = previousRead.state === "valid" ? previousRead.run : undefined;
      if (previous !== undefined
        && (!operationRunIsValid(previous, definition, manifest)
          || !await projectionActionsAreValid(
            target,
            previous,
            definition,
            manifest,
            definitions,
            validationTime,
          )
          || !projectionIsValid(previous, ownedIncoming))) {
        return failure(INVALID_RESPONSE);
      }
      if (previous !== undefined && previous.sequence === ownedIncoming.sequence) {
        return { ok: true, value: safeRunProjection(previous) };
      }
      options.store.saveRun(target.id, ownedIncoming);
      const storedRead = readStoredRun(target.id, ownedIncoming.id);
      if (storedRead.state !== "valid"
        || !operationRunIsValid(storedRead.run, definition, manifest)
        || !await projectionActionsAreValid(
          target,
          storedRead.run,
          definition,
          manifest,
          definitions,
          validationTime,
        )
        || !projectionIsValid(ownedIncoming, storedRead.run)) {
        return failure(INVALID_RESPONSE);
      }
      return { ok: true, value: storedRead.run };
    } catch {
      return failure(INVALID_RESPONSE);
    }
  };

  async function resolveCompatibleOperation(
    compatible: Extract<CompatibleTargetResult, { readonly ok: true }>,
    operationId: string,
  ): Promise<ResolvedOperationResult> {
    const summaries = compatible.manifest.operations.filter(({ id }) => id === operationId);
    if (summaries.length !== 1) {
      return { ok: false, problem: summaries.length === 0 ? OPERATION_NOT_FOUND : INVALID_RESPONSE };
    }
    const summary = summaries[0]!;
    if (summary.availability.state !== "available") {
      return { ok: false, problem: safeAvailabilityProblem(summary) };
    }
    const summarySupport = options.manifests.checkRequirements(summary.requirements);
    if (!summarySupport.ok) {
      return summarySupport;
    }

    const result = await options.client.getOperation(compatible.target, operationId);
    if (!result.ok) {
      return { ok: false, problem: result.problem };
    }
    const definition = result.value;
    if (!definitionMatchesSummary(definition, summary)
      || !declaredByManifest(definition, compatible.manifest)) {
      return { ok: false, problem: INVALID_RESPONSE };
    }
    const definitionSupport = options.manifests.checkRequirements(definition.requirements);
    if (!definitionSupport.ok) {
      return definitionSupport;
    }
    return {
      ok: true,
      target: compatible.target,
      manifest: compatible.manifest,
      summary,
      definition,
    };
  }

  const projectionActionsAreValid = async (
    target: AdapterTarget,
    run: Run,
    sourceDefinition: OperationDefinition,
    manifest: AdapterManifest,
    definitions = new Map<string, Promise<OperationDefinition | undefined>>([
      [sourceDefinition.id, Promise.resolve(sourceDefinition)],
    ]),
    validationTime = clock(),
  ): Promise<boolean> => {
    try {
      for (const action of run.actions) {
        if (action.kind !== "invoke-operation") continue;
        let pending = definitions.get(action.operationId);
        if (pending === undefined) {
          pending = resolveCompatibleOperation({ ok: true, target, manifest }, action.operationId)
            .then((resolved) => resolved.ok ? resolved.definition : undefined)
            .catch(() => undefined);
          definitions.set(action.operationId, pending);
        }
        const targetDefinition = await pending;
        if (targetDefinition === undefined
          || !operationActionInputIsValid(action.input, targetDefinition, validationTime)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const requireCapability = async (
    targetId: string,
    capability: CapabilityId,
  ): Promise<CompatibleTargetResult> => {
    const compatible = await options.manifests.requireCompatibleTarget(targetId);
    if (!compatible.ok) return compatible;
    const supported = options.manifests.checkRequirements({ capabilities: [capability] });
    if (!supported.ok) return supported;
    if (!compatible.manifest.capabilities.includes(capability)) {
      return { ok: false, problem: unsupportedCapability(capability) };
    }
    return compatible;
  };

  const resolveStoredOperation = async (
    compatible: Extract<CompatibleTargetResult, { readonly ok: true }>,
    runId: string,
  ): Promise<
    | { readonly ok: true; readonly run: Run; readonly resolved: Extract<ResolvedOperationResult, { readonly ok: true }> }
    | { readonly ok: false; readonly problem: Problem }
  > => {
    const currentRead = readStoredRun(compatible.target.id, runId);
    if (currentRead.state === "missing") return { ok: false, problem: RUN_NOT_FOUND };
    if (currentRead.state === "invalid") return { ok: false, problem: INVALID_RESPONSE };
    const resolved = await resolveCompatibleOperation(compatible, currentRead.run.operationId);
    if (!resolved.ok) return { ok: false, problem: resolved.problem };
    if (!operationRunIsValid(currentRead.run, resolved.definition, resolved.manifest)
      || !await projectionActionsAreValid(
        resolved.target,
        currentRead.run,
        resolved.definition,
        resolved.manifest,
      )) return { ok: false, problem: INVALID_RESPONSE };
    return { ok: true, run: currentRead.run, resolved };
  };

  const service: RunProxyService = {
    async resolveOperation(targetId: string, operationId: string): Promise<ResolvedOperationResult> {
      const compatible = await options.manifests.requireCompatibleTarget(targetId);
      if (!compatible.ok) {
        return compatible;
      }
      return await resolveCompatibleOperation(compatible, operationId);
    },

    async create(targetId: string, operationId: string, request: unknown): Promise<ClientResult<Run>> {
      const validation = validateCreateRunRequest(request);
      if (!validation.ok) {
        return failure(validation.problem);
      }
      const ownedRequest = validation.value;
      const resolved = await service.resolveOperation(targetId, operationId);
      if (!resolved.ok) {
        return failure(resolved.problem);
      }
      if (ownedRequest.operationRevision !== resolved.definition.revision) {
        return failure(STALE_REVISION);
      }
      const acknowledgementProblem = confirmationProblem(
        operationId,
        resolved.definition,
        ownedRequest,
      );
      if (acknowledgementProblem !== undefined) {
        return failure(acknowledgementProblem);
      }
      const contextTarget = ownedRequest.context?.target?.id;
      if (typeof contextTarget === "string" && contextTarget !== targetId) {
        return failure(VALIDATION_FAILED);
      }
      const result = await options.client.createRun(resolved.target, operationId, ownedRequest);
      if (!result.ok) {
        return result;
      }
      if (result.value.operationId !== operationId
        || result.value.operationRevision !== resolved.definition.revision) {
        return failure(INVALID_RESPONSE);
      }
      return await saveProjection(
        resolved.target,
        result.value,
        resolved.definition,
        resolved.manifest,
      );
    },

    async get(targetId: string, runId: string): Promise<ClientResult<Run>> {
      const compatible = await options.manifests.requireCompatibleTarget(targetId);
      if (!compatible.ok) {
        return failure(compatible.problem);
      }
      const currentRead = readStoredRun(targetId, runId);
      if (currentRead.state === "missing") {
        return failure(RUN_NOT_FOUND);
      }
      if (currentRead.state === "invalid") return failure(INVALID_RESPONSE);
      const current = currentRead.run;
      const resolved = await resolveCompatibleOperation(compatible, current.operationId);
      if (!resolved.ok) {
        return failure(resolved.problem);
      }
      if (!operationRunIsValid(current, resolved.definition, resolved.manifest)
        || !await projectionActionsAreValid(
          resolved.target,
          current,
          resolved.definition,
          resolved.manifest,
        )) {
        return failure(INVALID_RESPONSE);
      }
      const result = await options.client.getRun(compatible.target, runId);
      if (!result.ok) {
        return result;
      }
      return await saveProjection(
        resolved.target,
        result.value,
        resolved.definition,
        resolved.manifest,
      );
    },

    async createUpload(targetId: string, file: Blob, fileName?: string): Promise<ClientResult<UploadResponse>> {
      const compatible = await requireCapability(targetId, "tc-uploads@1");
      if (!compatible.ok) return failure(compatible.problem);
      const result = await options.client.createUpload(compatible.target, file, fileName);
      if (!result.ok) return result;
      try {
        return { ok: true, value: ownFrozenJson(result.value) as UploadResponse };
      } catch {
        return failure(INVALID_RESPONSE);
      }
    },

    async cancel(targetId: string, runId: string): Promise<ClientResult<Run>> {
      const compatible = await requireCapability(targetId, "tc-run-cancellation@1");
      if (!compatible.ok) return failure(compatible.problem);
      const current = await resolveStoredOperation(compatible, runId);
      if (!current.ok) return failure(current.problem);
      const result = await options.client.cancelRun(compatible.target, runId);
      if (!result.ok) return result;
      if (result.value.operationId !== current.resolved.definition.id
        || result.value.operationRevision !== current.resolved.definition.revision) {
        return failure(INVALID_RESPONSE);
      }
      return await saveProjection(
        current.resolved.target,
        result.value,
        current.resolved.definition,
        current.resolved.manifest,
      );
    },

    async streamEvents(targetId: string, runId: string, lastEventId?: string): Promise<ClientResult<AdapterRunEventStream>> {
      const compatible = await requireCapability(targetId, "tc-run-sse@1");
      if (!compatible.ok) return failure(compatible.problem);
      const current = await resolveStoredOperation(compatible, runId);
      if (!current.ok) return failure(current.problem);
      const upstream = await options.client.streamRunEvents(compatible.target, runId, lastEventId);
      if (!upstream.ok) return upstream;

      let started = false;
      let cancelled = false;
      const events = async function* (): AsyncGenerator<RunEvent> {
        if (started) throw new PublicEventStreamError();
        started = true;
        try {
          for await (const candidate of upstream.value) {
            if (cancelled) return;
            let event: RunEvent;
            try {
              event = ownFrozenJson(candidate) as RunEvent;
            } catch {
              throw new PublicEventStreamError();
            }
            if (event.run.id !== runId
              || event.sequence !== event.run.sequence
              || event.occurredAt !== event.run.updatedAt) {
              throw new PublicEventStreamError();
            }
            const saved = await saveProjection(
              current.resolved.target,
              event.run,
              current.resolved.definition,
              current.resolved.manifest,
            );
            if (!saved.ok) throw new PublicEventStreamError();
            yield ownFrozenJson({ ...event, run: saved.value }) as RunEvent;
          }
        } catch {
          if (!cancelled) throw new PublicEventStreamError();
        } finally {
          await upstream.value.cancel();
        }
      };
      const stream: AdapterRunEventStream = Object.freeze({
        [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
          return events();
        },
        async cancel(): Promise<void> {
          if (cancelled) return;
          cancelled = true;
          await upstream.value.cancel();
        },
      });
      return { ok: true, value: stream };
    },

    async createSessionLaunch(targetId: string, runId: string, artifactId: string): Promise<ClientResult<SessionLaunchResponse>> {
      const compatible = await requireCapability(targetId, "tc-session-launch@1");
      if (!compatible.ok) {
        return failure(compatible.problem);
      }
      const configured = options.registry.get(targetId);
      if (configured?.publicUrl === undefined) {
        return failure(LAUNCH_UNAVAILABLE);
      }
      const runRead = readStoredRun(targetId, runId);
      if (runRead.state === "missing") {
        return failure(RUN_NOT_FOUND);
      }
      if (runRead.state === "invalid") return failure(INVALID_RESPONSE);
      const run = runRead.run;
      const resolved = await resolveCompatibleOperation(compatible, run.operationId);
      if (!resolved.ok) return failure(resolved.problem);
      if (!operationRunIsValid(run, resolved.definition, resolved.manifest)
        || !await projectionActionsAreValid(
          resolved.target,
          run,
          resolved.definition,
          resolved.manifest,
        )) return failure(INVALID_RESPONSE);
      const matches = run.artifacts.filter(({ id }) => id === artifactId);
      if (matches.length !== 1 || matches[0]!.kind !== "browser-launch") {
        return failure(ARTIFACT_NOT_FOUND);
      }

      const result = await options.client.createSessionLaunch(compatible.target, runId, artifactId);
      if (!result.ok) {
        return result;
      }
      try {
        const url = new URL(result.value.url);
        const now = clock();
        const expiry = Date.parse(result.value.expiresAt);
        if ((url.protocol !== "http:" && url.protocol !== "https:")
          || url.username !== ""
          || url.password !== ""
          || url.origin !== configured.publicUrl
          || !(now instanceof Date)
          || !Number.isFinite(now.getTime())
          || !Number.isFinite(expiry)
          || expiry <= now.getTime()
          || expiry - now.getTime() > MAX_SESSION_TTL_MS) {
          return failure(INVALID_RESPONSE);
        }
        return { ok: true, value: ownFrozenJson(result.value) };
      } catch {
        return failure(INVALID_RESPONSE);
      }
    },
  };

  return Object.freeze(service);
}
