import {
  assertTcSchemaCore,
  computeRevision,
  operationSemanticsAreValid,
  type Artifact,
  type FollowUpAction,
  type JsonObject,
  type JsonValue,
  type OperationDefinition,
  type Problem,
  type Rfc3339Timestamp,
  type RunSummary,
} from "@8lines/gauntlet-protocol";
import { cloneAndDeepFreeze, markCanonicalOperation } from "./operation-internals.js";
import type { RunContext } from "./run-context.js";

export type OperationHandler<I extends JsonObject> =
  (input: I, context: RunContext) => OperationResult | Promise<OperationResult>;

export type OperationDefinitionDraft = Omit<OperationDefinition, "revision">;

interface OperationResultPayload {
  readonly summary?: RunSummary;
  readonly output?: JsonValue;
  readonly artifacts?: readonly Artifact[];
  readonly actions?: readonly FollowUpAction[];
}

export type OperationResult =
  | (OperationResultPayload & { readonly outcome?: "succeeded"; readonly problem?: never })
  | (OperationResultPayload & { readonly outcome: "partial"; readonly problem: Problem });

export interface StructuredLogEntry {
  readonly timestamp?: Rfc3339Timestamp;
  readonly level: "debug" | "info" | "warning" | "error";
  readonly message: string;
  readonly fields?: JsonObject;
}

export interface RegisteredOperation<I extends JsonObject = JsonObject> {
  readonly definition: OperationDefinition;
  readonly handler: OperationHandler<I>;
}

export function defineOperation<I extends JsonObject>(
  draft: OperationDefinitionDraft,
  handler: OperationHandler<I>,
): RegisteredOperation<I> {
  const canonicalDraft = cloneAndDeepFreeze(draft);
  assertTcSchemaCore(canonicalDraft.inputSchema, { requireObjectRoot: true });
  if (canonicalDraft.contextSchema !== undefined) {
    assertTcSchemaCore(canonicalDraft.contextSchema, { requireObjectRoot: true });
  }
  assertTcSchemaCore(canonicalDraft.output.schema);

  const definition: OperationDefinition = cloneAndDeepFreeze({
    ...canonicalDraft,
    revision: computeRevision(canonicalDraft as unknown as JsonObject),
  });
  if (!operationSemanticsAreValid(definition)) {
    throw new TypeError("Operation definition violates shared protocol semantics");
  }

  const registered = Object.freeze({ definition, handler });
  markCanonicalOperation(registered);
  return registered;
}
