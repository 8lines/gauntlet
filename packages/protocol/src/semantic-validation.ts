import {
  operationInputHandlingValuesAreValid,
  operationPresetsOmitSecrets,
} from "./preset-secrets.js";
import { assertNonProductionEnvironment } from "./environment.js";
import { PAGE_PLACEMENTS_PROFILE, operationPlacementsAreValid } from "./placements.js";
import { assertRuntimeJsonData, canonicalizeForRevision, computeRevision } from "./revision.js";
import { assertTcSchemaCore } from "./schema-profile.js";
import type {
  AdapterManifest,
  DataSourceResolveRequest,
  DataSourceResolveResponse,
  InputHandlingRule,
  JsonObject,
  JsonValue,
  OperationDefinition,
  Run,
} from "./types.js";

export type FileInputHandlingRule = Extract<InputHandlingRule, { readonly kind: "file" }>;

export function operationInputHandlingIsValid(
  operation: OperationDefinition,
  input: JsonValue,
  fileReferenceIsValid: (value: JsonValue, rule: FileInputHandlingRule) => boolean,
): boolean {
  try {
    assertRuntimeJsonData(input);
    return operationInputHandlingValuesAreValid(operation, input, fileReferenceIsValid);
  } catch {
    return false;
  }
}

function allUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function requirementsAreDeclared(
  requirements: OperationDefinition["requirements"],
  profiles: ReadonlySet<string>,
  capabilities: ReadonlySet<string>,
): boolean {
  return requirements?.profiles?.every((profile) => profiles.has(profile)) !== false
    && requirements?.capabilities?.every((capability) => capabilities.has(capability)) !== false;
}

function featureTreeIsValid(manifest: AdapterManifest): boolean {
  const parents = new Map(manifest.features.map((feature) => [feature.id, feature.parentId]));
  if (parents.size !== manifest.features.length) {
    return false;
  }

  for (const feature of manifest.features) {
    let current = feature.parentId;
    const visited = new Set<string>([feature.id]);
    while (current !== undefined) {
      if (!parents.has(current) || visited.has(current)) {
        return false;
      }
      visited.add(current);
      current = parents.get(current);
    }
  }
  return true;
}

export function manifestSemanticsAreValid(manifest: AdapterManifest): boolean {
  try {
    assertNonProductionEnvironment(manifest.application.environment);
    if (computeRevision(manifest as unknown as JsonObject, "manifestRevision") !== manifest.manifestRevision) {
      return false;
    }
    if (!featureTreeIsValid(manifest)) {
      return false;
    }

    const featureIds = new Set(manifest.features.map(({ id }) => id));
    const operationIds = manifest.operations.map(({ id }) => id);
    const dataSourceIds = manifest.dataSources.map(({ id }) => id);
    if (!allUnique(operationIds) || !allUnique(dataSourceIds)) {
      return false;
    }

    const profiles = new Set(manifest.profiles);
    const capabilities = new Set(manifest.capabilities);
    if (manifest.operations.some((operation) => operation.placements !== undefined)
      && !profiles.has(PAGE_PLACEMENTS_PROFILE)) {
      return false;
    }
    if (manifest.operations.some((operation) =>
      !featureIds.has(operation.featureId)
      || (operation.availability.state === "available"
        && !requirementsAreDeclared(operation.requirements, profiles, capabilities)))) {
      return false;
    }

    for (const dataSource of manifest.dataSources) {
      if (dataSource.capabilities.defaultLimit > dataSource.capabilities.maxLimit) {
        return false;
      }
      if (dataSource.dependencySchema !== undefined) {
        assertTcSchemaCore(dataSource.dependencySchema, { requireObjectRoot: true });
      }
      if (dataSource.contextSchema !== undefined) {
        assertTcSchemaCore(dataSource.contextSchema, { requireObjectRoot: true });
      }
    }
    return true;
  } catch {
    return false;
  }
}

function uiDataSourceIds(node: unknown): readonly string[] {
  const ids: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "field" && typeof record.dataSourceId === "string") {
      ids.push(record.dataSourceId);
    }
    if (Array.isArray(record.children)) {
      record.children.forEach(visit);
    }
    if (Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        visit(tab);
      }
    }
  };
  visit(node);
  return ids;
}

export function operationSemanticsAreValid(operation: OperationDefinition): boolean {
  try {
    if (operation.execution.impact === "destructive"
      && (operation.execution.confirmationRequired !== true
        || operation.execution.idempotency !== "required")) {
      return false;
    }
    if (computeRevision(operation as unknown as JsonObject) !== operation.revision) {
      return false;
    }
    assertTcSchemaCore(operation.inputSchema, { requireObjectRoot: true });
    if (operation.contextSchema !== undefined) {
      assertTcSchemaCore(operation.contextSchema, { requireObjectRoot: true });
    }
    assertTcSchemaCore(operation.output.schema);

    const dataSourceIds = operation.dataSources.map(({ id }) => id);
    if (!allUnique(dataSourceIds) || !allUnique(operation.presets.map(({ id }) => id))) {
      return false;
    }
    if (!operationPresetsOmitSecrets(operation)) {
      return false;
    }
    if (!operationPlacementsAreValid(operation)) {
      return false;
    }
    const referencedDataSources = new Set(dataSourceIds);
    return uiDataSourceIds(operation.uiSchema?.root).every((id) => referencedDataSources.has(id));
  } catch {
    return false;
  }
}

export function resolveSemanticsAreValid(
  request: DataSourceResolveRequest,
  response: DataSourceResolveResponse,
): boolean {
  if (response.results.length !== request.values.length) {
    return false;
  }
  return response.results.every((result, index) =>
    result.value === request.values[index]
    && (result.item === null || result.item.value === result.value));
}

export type RunSemanticViolationCode =
  | "invalid-run"
  | "operation-identity"
  | "timestamp-invalid"
  | "timestamp-order"
  | "progress-bounds"
  | "duplicate-artifact-id"
  | "missing-browser-artifact"
  | "unknown-operation-reference"
  | "output-invalid"
  | "terminal-problem"
  | "sequence-regression"
  | "sequence-conflict"
  | "state-regression"
  | "timestamp-regression"
  | "immutable-field"
  | "terminal-mutation";

export interface RunSemanticViolation {
  readonly code: RunSemanticViolationCode;
  readonly instancePath: string;
}

export interface RunSemanticContext {
  readonly operationId?: string;
  readonly operationRevision?: string;
  readonly operationIds?: readonly string[];
  readonly outputIsValid?: (output: JsonValue) => boolean;
}

function runViolation(
  code: RunSemanticViolationCode,
  instancePath: string,
): RunSemanticViolation {
  return { code, instancePath };
}

function parsedTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function validateRunSemantics(
  run: Run,
  context: RunSemanticContext = {},
): RunSemanticViolation | undefined {
  try {
    if (context.operationId !== undefined && run.operationId !== context.operationId) {
      return runViolation("operation-identity", "/operationId");
    }
    if (context.operationRevision !== undefined && run.operationRevision !== context.operationRevision) {
      return runViolation("operation-identity", "/operationRevision");
    }

    const createdAt = parsedTimestamp(run.createdAt);
    const updatedAt = parsedTimestamp(run.updatedAt);
    if (createdAt === undefined) return runViolation("timestamp-invalid", "/createdAt");
    if (updatedAt === undefined) return runViolation("timestamp-invalid", "/updatedAt");
    if (updatedAt < createdAt) return runViolation("timestamp-order", "/updatedAt");

    const startedAt = run.startedAt === undefined ? undefined : parsedTimestamp(run.startedAt);
    if (run.startedAt !== undefined && startedAt === undefined) {
      return runViolation("timestamp-invalid", "/startedAt");
    }
    if (startedAt !== undefined && (startedAt < createdAt || startedAt > updatedAt)) {
      return runViolation("timestamp-order", "/startedAt");
    }

    const completedAt = run.completedAt === undefined ? undefined : parsedTimestamp(run.completedAt);
    if (run.completedAt !== undefined && completedAt === undefined) {
      return runViolation("timestamp-invalid", "/completedAt");
    }
    if (completedAt !== undefined
      && (completedAt < createdAt
        || completedAt > updatedAt
        || (startedAt !== undefined && completedAt < startedAt))) {
      return runViolation("timestamp-order", "/completedAt");
    }

    const expectedTerminalProblem = run.state === "cancelled"
      ? {
          type: "urn:gauntlet:problem:run-cancelled",
          title: "Run cancelled",
          status: 409,
        }
      : run.state === "timed_out"
        ? {
            type: "urn:gauntlet:problem:run-timed-out",
            title: "Run timed out",
            status: 504,
          }
        : undefined;
    if (expectedTerminalProblem !== undefined) {
      if (run.problem?.type !== expectedTerminalProblem.type) {
        return runViolation("terminal-problem", "/problem/type");
      }
      if (run.problem.title !== expectedTerminalProblem.title) {
        return runViolation("terminal-problem", "/problem/title");
      }
      if (run.problem.status !== expectedTerminalProblem.status) {
        return runViolation("terminal-problem", "/problem/status");
      }
    }

    if (run.progress !== undefined) {
      const { current, total } = run.progress;
      if ((current !== undefined && (!Number.isFinite(current) || current < 0))
        || (total !== undefined && (!Number.isFinite(total) || total < 0))
        || (current !== undefined && total !== undefined && current > total)) {
        return runViolation("progress-bounds", "/progress/current");
      }
      const progressAt = parsedTimestamp(run.progress.updatedAt);
      if (progressAt === undefined) return runViolation("timestamp-invalid", "/progress/updatedAt");
      if (progressAt < createdAt || progressAt > updatedAt) {
        return runViolation("timestamp-order", "/progress/updatedAt");
      }
    }

    const artifactIds = new Set<string>();
    const browserArtifactIds = new Set<string>();
    for (const [index, artifact] of run.artifacts.entries()) {
      if (artifactIds.has(artifact.id)) {
        return runViolation("duplicate-artifact-id", `/artifacts/${index}/id`);
      }
      artifactIds.add(artifact.id);
      if (artifact.kind === "browser-launch") browserArtifactIds.add(artifact.id);
    }

    const operationIds = context.operationIds === undefined
      ? undefined
      : new Set(context.operationIds);
    for (const [index, action] of run.actions.entries()) {
      if (action.kind === "browser-launch" && !browserArtifactIds.has(action.artifactId)) {
        return runViolation("missing-browser-artifact", `/actions/${index}/artifactId`);
      }
      if (action.kind === "invoke-operation"
        && operationIds !== undefined
        && !operationIds.has(action.operationId)) {
        return runViolation("unknown-operation-reference", `/actions/${index}/operationId`);
      }
    }

    if (run.output !== undefined
      && context.outputIsValid !== undefined
      && !context.outputIsValid(run.output)) {
      return runViolation("output-invalid", "/output");
    }
    return undefined;
  } catch {
    return runViolation("invalid-run", "");
  }
}

export function runSemanticsAreValid(
  run: Run,
  context: RunSemanticContext = {},
): boolean {
  return validateRunSemantics(run, context) === undefined;
}

function activeRun(run: Run): boolean {
  return run.state === "queued" || run.state === "running";
}

function canonicalRun(run: Run): string {
  return canonicalizeForRevision(run as unknown as JsonObject);
}

export function validateRunTransition(
  previous: Run,
  next: Run,
): RunSemanticViolation | undefined {
  try {
    const immutableFields = ["id", "operationId", "operationRevision", "createdAt"] as const;
    for (const field of immutableFields) {
      if (next[field] !== previous[field]) {
        return runViolation("immutable-field", `/${field}`);
      }
    }

    if (next.sequence < previous.sequence) {
      return runViolation("sequence-regression", "/sequence");
    }
    const previousCanonical = canonicalRun(previous);
    const nextCanonical = canonicalRun(next);
    if (next.sequence === previous.sequence) {
      return previousCanonical === nextCanonical
        ? undefined
        : runViolation("sequence-conflict", "/sequence");
    }
    if (!activeRun(previous)) {
      return runViolation("terminal-mutation", "");
    }
    if (previous.state === "running" && next.state === "queued") {
      return runViolation("state-regression", "/state");
    }

    const previousUpdatedAt = parsedTimestamp(previous.updatedAt);
    const nextUpdatedAt = parsedTimestamp(next.updatedAt);
    if (previousUpdatedAt === undefined || nextUpdatedAt === undefined) {
      return runViolation("timestamp-invalid", "/updatedAt");
    }
    if (nextUpdatedAt < previousUpdatedAt) {
      return runViolation("timestamp-regression", "/updatedAt");
    }

    for (const field of ["startedAt", "completedAt"] as const) {
      if (previous[field] !== undefined && next[field] !== previous[field]) {
        return runViolation("immutable-field", `/${field}`);
      }
    }

    if (previous.progress !== undefined && next.progress !== undefined) {
      const previousProgressAt = parsedTimestamp(previous.progress.updatedAt);
      const nextProgressAt = parsedTimestamp(next.progress.updatedAt);
      if (previousProgressAt === undefined || nextProgressAt === undefined) {
        return runViolation("timestamp-invalid", "/progress/updatedAt");
      }
      if (nextProgressAt < previousProgressAt) {
        return runViolation("timestamp-regression", "/progress/updatedAt");
      }
    }
    return undefined;
  } catch {
    return runViolation("invalid-run", "");
  }
}

export function runTransitionIsValid(previous: Run, next: Run): boolean {
  return validateRunTransition(previous, next) === undefined;
}
