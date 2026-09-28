import type {
  ConfirmationAcknowledgement,
  FeatureDefinition,
  JsonObject,
} from "@8lines/gauntlet-protocol";
import {
  defineOperation,
  type OperationDefinitionDraft,
  type RegisteredOperation,
} from "../../src/index.js";

export function feature(id: string): FeatureDefinition {
  return { id, label: id };
}

export function operation(
  id: string,
  overrides: Partial<OperationDefinitionDraft> = {},
): RegisteredOperation<JsonObject> {
  const featureId = id.split(".", 1)[0] ?? id;
  return defineOperation({
    id,
    label: "First",
    featureId,
    order: 0,
    tags: [],
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    },
    dataSources: [],
    presets: [],
    execution: {
      impact: "read",
      confirmationRequired: false,
      dryRunSupported: false,
      idempotency: "optional",
      cancellationSupported: false,
    },
    output: {
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
      },
    },
    ...overrides,
  }, () => ({
    summary: { title: "ok", tone: "success" },
    output: {},
    artifacts: [],
    actions: [],
  }));
}

export function confirmationFor(
  registered: RegisteredOperation,
): ConfirmationAcknowledgement {
  return {
    operationId: registered.definition.id,
    operationRevision: registered.definition.revision,
    impact: registered.definition.execution.impact,
  };
}
