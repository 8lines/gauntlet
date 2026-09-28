import type {
  CreateRunRequest,
  InvocationContext,
  JsonObject,
  OperationDefinition,
} from "@8lines/gauntlet-protocol";

export function buildCreateRunRequest(
  definition: OperationDefinition,
  input: JsonObject,
  context: InvocationContext,
  dryRun: boolean,
  idempotencyKey?: string,
): CreateRunRequest {
  return {
    operationRevision: definition.revision,
    input,
    context,
    dryRun,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(definition.execution.confirmationRequired ? {
      confirmation: {
        operationId: definition.id,
        operationRevision: definition.revision,
        impact: definition.execution.impact,
      },
    } : {}),
  };
}
