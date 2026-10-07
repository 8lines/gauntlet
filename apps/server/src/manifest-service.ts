import type {
  AdapterClient,
  AdapterTarget,
  ClientResult,
  ManifestFetchResult,
} from "@8lines/gauntlet-dashboard-client";
import type {
  AdapterManifest,
  CapabilityId,
  EnvironmentDescriptor,
  Problem,
  ProfileId,
  ProtocolRequirements,
  Rfc3339Timestamp,
  TargetState,
} from "@8lines/gauntlet-protocol";
import { ownFrozenJson } from "./ownership.js";
import { TARGET_NOT_FOUND_PROBLEM } from "./problem-response.js";
import { safeManifestProjection, safeProblem } from "./safe-problem.js";
import type { StaticTargetConfig } from "./static-target-provider.js";
import type { TargetRegistry } from "./target-registry.js";
import type { GauntletStore } from "./gauntlet-store.js";

const DEFAULT_PROFILES: readonly ProfileId[] = Object.freeze([
  "tc-schema-core@1",
  "tc-rich-forms@1",
  "tc-rich-results@1",
]);
const DEFAULT_CAPABILITIES: readonly CapabilityId[] = Object.freeze([
  "tc-uploads@1",
  "tc-run-cancellation@1",
  "tc-run-sse@1",
  "tc-session-launch@1",
]);

export interface TargetSnapshot {
  readonly id: string;
  readonly label: string;
  readonly expectedEnvironment: EnvironmentDescriptor;
  readonly tags: readonly string[];
  readonly state: TargetState;
  readonly manifest?: AdapterManifest;
  readonly problem?: Problem;
  readonly refreshedAt: Rfc3339Timestamp;
}

export type RequirementCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: Problem };

export type CompatibleTargetResult =
  | { readonly ok: true; readonly target: AdapterTarget; readonly manifest: AdapterManifest }
  | { readonly ok: false; readonly problem: Problem };

export interface ManifestService {
  refresh(id: string): Promise<TargetSnapshot>;
  snapshot(id: string): TargetSnapshot | undefined;
  listTargets(): Promise<readonly TargetSnapshot[]>;
  checkRequirements(requirements?: ProtocolRequirements): RequirementCheck;
  /** `fresh` skips the reuse of a recent online snapshot and asks the adapter again. */
  requireCompatibleTarget(id: string, options?: { readonly fresh?: boolean }): Promise<CompatibleTargetResult>;
}

export interface ManifestServiceOptions {
  readonly registry: TargetRegistry;
  readonly client: AdapterClient;
  readonly store: GauntletStore;
  readonly clock?: () => Date;
  /**
   * How long an online snapshot is reused by `listTargets` and `requireCompatibleTarget` before the
   * adapter is asked again (health and manifest). `refresh` always asks. 0 turns reuse off.
   */
  readonly maxAgeMs?: number;
  /** Monotonic milliseconds for `maxAgeMs`; `performance.now` by default. */
  readonly now?: () => number;
  readonly supportedProfiles?: readonly ProfileId[];
  readonly supportedCapabilities?: readonly CapabilityId[];
}

function problem(type: `urn:gauntlet:problem:${string}`, title: string, status: number): Problem {
  return Object.freeze({ type, title, status });
}

const INVALID_RESPONSE = problem("urn:gauntlet:problem:adapter-invalid-response", "Invalid adapter response", 502);
const INCOMPATIBLE = problem("urn:gauntlet:problem:adapter-protocol-incompatible", "Incompatible adapter protocol", 502);
const ENVIRONMENT_MISMATCH = problem(
  "urn:gauntlet:problem:target-environment-mismatch",
  "Target environment mismatch",
  503,
);

function unsupportedRequirement(capability: CapabilityId): Problem {
  return Object.freeze({
    type: "urn:gauntlet:problem:unsupported-capability",
    title: "Unsupported capability",
    status: 501,
    capability,
  });
}

function adapterTarget(target: StaticTargetConfig): AdapterTarget {
  return Object.freeze({ id: target.id, adapterUrl: target.adapterUrl });
}

function environmentsMatch(target: StaticTargetConfig, manifest: AdapterManifest): boolean {
  return target.expectedEnvironment.name === manifest.application.environment.name
    && target.expectedEnvironment.kind === manifest.application.environment.kind;
}

function isUnavailable(problemDocument: Problem): boolean {
  return problemDocument.status === 503
    && problemDocument.type === "urn:gauntlet:problem:adapter-unavailable";
}

export const DEFAULT_MANIFEST_MAX_AGE_MS = 5_000;

export function createManifestService(options: ManifestServiceOptions): ManifestService {
  const clock = options.clock ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MANIFEST_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError("maxAgeMs must be a non-negative finite number");
  }
  const now = options.now ?? (() => performance.now());
  /** The last refresh of each target, kept only while it was online. */
  const recent = new Map<string, { readonly snapshot: TargetSnapshot; readonly at: number }>();
  const supportedProfiles = new Set(options.supportedProfiles ?? DEFAULT_PROFILES);
  const supportedCapabilities = new Set(options.supportedCapabilities ?? DEFAULT_CAPABILITIES);
  const etags = new Map<string, string>();
  const lastKnownGood = new Map<string, AdapterManifest>();
  const inFlight = new Map<string, Promise<TargetSnapshot>>();

  const publicSnapshot = (snapshot: TargetSnapshot): TargetSnapshot => ownFrozenJson({
    ...snapshot,
    ...(snapshot.manifest === undefined ? {} : { manifest: safeManifestProjection(snapshot.manifest) }),
  }) as TargetSnapshot;

  const timestamp = (): Rfc3339Timestamp => {
    try {
      const value = clock();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new TypeError();
      }
      return value.toISOString();
    } catch {
      return "1970-01-01T00:00:00.000Z";
    }
  };

  const save = (
    target: StaticTargetConfig,
    state: TargetState,
    problemDocument?: Problem,
  ): TargetSnapshot => {
    const manifest = lastKnownGood.get(target.id);
    const snapshot = ownFrozenJson({
      id: target.id,
      label: target.label,
      expectedEnvironment: target.expectedEnvironment,
      tags: target.tags ?? [],
      state,
      ...(manifest === undefined ? {} : { manifest }),
      ...(problemDocument === undefined ? {} : { problem: safeProblem(problemDocument) }),
      refreshedAt: timestamp(),
    }) as TargetSnapshot;
    options.store.saveSnapshot(snapshot);
    return snapshot;
  };

  const classifyHealthFailure = (
    target: StaticTargetConfig,
    result: Extract<ClientResult<unknown>, { readonly ok: false }>,
  ): TargetSnapshot => {
    if (result.failureKind === "protocol-major-mismatch") {
      return save(target, "incompatible", INCOMPATIBLE);
    }
    if (isUnavailable(result.problem)) {
      return save(target, "offline", result.problem);
    }
    return save(target, "degraded", result.problem);
  };

  const handleManifestResult = (
    target: StaticTargetConfig,
    result: ClientResult<ManifestFetchResult>,
  ): TargetSnapshot => {
    if (!result.ok) {
      if (result.failureKind === "protocol-major-mismatch") {
        return save(target, "incompatible", INCOMPATIBLE);
      }
      return save(target, "degraded", result.problem);
    }
    if (result.value.notModified) {
      if (!lastKnownGood.has(target.id)) {
        return save(target, "degraded", INVALID_RESPONSE);
      }
      return save(target, "online");
    }

    const manifest = ownFrozenJson(result.value.manifest);
    if (!environmentsMatch(target, manifest)) {
      return save(target, "incompatible", ENVIRONMENT_MISMATCH);
    }
    lastKnownGood.set(target.id, manifest);
    if (result.etag === undefined) {
      etags.delete(target.id);
    } else {
      etags.set(target.id, result.etag);
    }
    return save(target, "online");
  };

  const performRefresh = async (target: StaticTargetConfig): Promise<TargetSnapshot> => {
    const targetForClient = adapterTarget(target);
    const healthResult = await options.client.health(targetForClient);
    if (!healthResult.ok) {
      return classifyHealthFailure(target, healthResult);
    }
    const manifestResult = await options.client.getManifest(targetForClient, etags.get(target.id));
    return handleManifestResult(target, manifestResult);
  };

  const safeUnexpected = (target: StaticTargetConfig): TargetSnapshot => save(target, "degraded", INVALID_RESPONSE);

  const refreshInternal = (id: string): Promise<TargetSnapshot> => {
    const target = options.registry.get(id);
    if (target === undefined) {
      return Promise.reject(new TypeError("Unknown target"));
    }
    const existing = inFlight.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const request = performRefresh(target).then((snapshot) => {
      if (snapshot.state === "online") {
        recent.set(id, { snapshot, at: now() });
      } else {
        recent.delete(id);
      }
      return snapshot;
    }, (error: unknown) => {
      recent.delete(id);
      throw error;
    }).finally(() => {
      if (inFlight.get(id) === request) {
        inFlight.delete(id);
      }
    });
    inFlight.set(id, request);
    return request;
  };

  /** A recent online snapshot when there is one, otherwise a refresh. */
  const currentInternal = (id: string): Promise<TargetSnapshot> => {
    const entry = recent.get(id);
    if (entry !== undefined && now() - entry.at < maxAgeMs) {
      return Promise.resolve(entry.snapshot);
    }
    return refreshInternal(id);
  };

  const service: ManifestService = {
    async refresh(id: string): Promise<TargetSnapshot> {
      return publicSnapshot(await refreshInternal(id));
    },

    snapshot(id: string): TargetSnapshot | undefined {
      const snapshot = options.store.getSnapshot(id);
      return snapshot === undefined ? undefined : publicSnapshot(snapshot);
    },

    async listTargets(): Promise<readonly TargetSnapshot[]> {
      const targets = options.registry.list();
      const results = await Promise.allSettled(targets.map(async (target) => publicSnapshot(await currentInternal(target.id))));
      return Object.freeze(results.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        return publicSnapshot(safeUnexpected(targets[index]!));
      }));
    },

    checkRequirements(requirements?: ProtocolRequirements): RequirementCheck {
      for (const profile of requirements?.profiles ?? []) {
        if (!supportedProfiles.has(profile)) {
          return { ok: false, problem: unsupportedRequirement(profile) };
        }
      }
      for (const capability of requirements?.capabilities ?? []) {
        if (!supportedCapabilities.has(capability)) {
          return { ok: false, problem: unsupportedRequirement(capability) };
        }
      }
      return { ok: true };
    },

    async requireCompatibleTarget(id: string, requireOptions?: { readonly fresh?: boolean }): Promise<CompatibleTargetResult> {
      const target = options.registry.get(id);
      if (target === undefined) {
        return { ok: false, problem: TARGET_NOT_FOUND_PROBLEM };
      }
      let snapshot: TargetSnapshot;
      try {
        snapshot = await (requireOptions?.fresh === true ? refreshInternal(id) : currentInternal(id));
      } catch {
        snapshot = safeUnexpected(target);
      }
      if (snapshot.state !== "online" || snapshot.manifest === undefined) {
        return { ok: false, problem: snapshot.problem ?? INVALID_RESPONSE };
      }
      return {
        ok: true,
        target: adapterTarget(target),
        manifest: snapshot.manifest,
      };
    },
  };

  return Object.freeze(service);
}
