import type {
  DataSourceItem,
  EnvironmentDescriptor,
  JsonObject,
} from "@8lines/gauntlet-protocol";
import {
  AjvSchemaValidator,
  CapabilityRegistry,
  DataSourceRegistry,
  OperationRegistry,
  RunManager,
  createAdapterCatalog,
  defineOperation,
  type AdapterCatalog,
  type RunCancellationEndpoint,
  type RunStore,
} from "@8lines/gauntlet-typescript-core";

const schemaDialect = "https://json-schema.org/draft/2020-12/schema" as const;

type ChangeApplicationStateInput = JsonObject & {
  readonly applicationId: string;
  readonly workflowState: "pending" | "approved" | "blocked";
  readonly effectiveAt: string;
  readonly notify: boolean;
  readonly reason?: string;
};

export interface ApplicationCatalogDependencies {
  /** A database/Redis implementation shared by every worker and pod. */
  readonly runStore: RunStore;
  /** The same high-entropy value (at least 32 bytes) in every worker and pod. */
  readonly idempotencySecret: Uint8Array;
  readonly environment: EnvironmentDescriptor;
  readonly changeApplicationState: (input: ChangeApplicationStateInput) => Promise<void>;
  readonly cancellation: RunCancellationEndpoint;
}

const applicationItems: readonly DataSourceItem[] = [
  { value: "application-brown", label: "Application Brown", group: "Pending" },
  { value: "application-green", label: "Application Green", group: "Pending" },
];

export function createApplicationCatalog(
  dependencies: ApplicationCatalogDependencies,
): AdapterCatalog {
  const operations = new OperationRegistry();
  operations.registerFeature({
    id: "applications",
    label: "Applications",
    order: 10,
  });

  operations.register(defineOperation<ChangeApplicationStateInput>({
    id: "applications.change-state",
    label: "Change application state",
    featureId: "applications",
    description: "Moves one explicitly selected application to a new workflow state.",
    order: 10,
    tags: ["applications", "workflow"],
    requirements: {
      profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
      capabilities: ["tc-run-cancellation@1"],
    },
    inputSchema: {
      $schema: schemaDialect,
      type: "object",
      required: ["applicationId", "workflowState", "effectiveAt", "notify"],
      properties: {
        applicationId: { type: "string", minLength: 1 },
        workflowState: { type: "string", enum: ["pending", "approved", "blocked"] },
        effectiveAt: { type: "string", format: "date-time" },
        notify: { type: "boolean", default: false },
        reason: { type: "string", minLength: 3, maxLength: 500 },
      },
      additionalProperties: false,
    },
    uiSchema: {
      profile: "tc-rich-forms@1",
      root: {
        type: "group",
        label: "Workflow change",
        children: [
          {
            type: "columns",
            children: [
              {
                type: "field",
                pointer: "/applicationId",
                widget: "autocomplete",
                dataSourceId: "pending-applications",
                label: "Application",
              },
              {
                type: "field",
                pointer: "/workflowState",
                widget: "select",
                label: "New state",
              },
            ],
          },
          { type: "field", pointer: "/effectiveAt", widget: "date-time" },
          { type: "field", pointer: "/notify", widget: "toggle" },
          {
            type: "field",
            pointer: "/reason",
            widget: "textarea",
            visibleWhen: {
              op: "in",
              pointer: "/workflowState",
              values: ["approved", "blocked"],
            },
          },
        ],
      },
    },
    dataSources: [{
      id: "pending-applications",
      inputPointer: "/applicationId",
      dependencyPointers: ["/workflowState"],
      required: true,
    }],
    presets: [{
      id: "return-to-pending",
      label: "Return to pending",
      input: { workflowState: "pending", notify: false },
      lockedPointers: ["/workflowState"],
    }],
    execution: {
      impact: "write",
      confirmationRequired: true,
      dryRunSupported: false,
      idempotency: "required",
      cancellationSupported: true,
      timeoutSeconds: 120,
      concurrency: "queue",
    },
    output: {
      schema: {
        $schema: schemaDialect,
        type: "object",
        required: ["applicationId", "workflowState", "effectiveAt"],
        properties: {
          applicationId: { type: "string" },
          workflowState: { type: "string" },
          effectiveAt: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
      presentation: { profile: "tc-rich-results@1", defaultView: "summary" },
    },
  }, async (input, context) => {
    context.report({ phase: "changing-state", current: 0, total: 1 });
    await dependencies.changeApplicationState(input);
    context.report({ phase: "complete", current: 1, total: 1 });
    return {
      summary: {
        title: "Application state changed",
        message: `${input.applicationId} is now ${input.workflowState}.`,
        tone: "success",
      },
      output: {
        applicationId: input.applicationId,
        workflowState: input.workflowState,
        effectiveAt: input.effectiveAt,
      },
    };
  }));

  const dataSources = new DataSourceRegistry();
  dataSources.register({
    definition: {
      id: "pending-applications",
      label: "Pending applications",
      capabilities: {
        search: true,
        pagination: "cursor",
        resolve: true,
        defaultLimit: 20,
        maxLimit: 100,
      },
      dependencySchema: {
        $schema: schemaDialect,
        type: "object",
        required: ["/workflowState"],
        properties: {
          "/workflowState": {
            type: "string",
            enum: ["pending", "approved", "blocked"],
          },
        },
        additionalProperties: false,
      },
    },
    query: ({ search, cursor, limit = 20 }) => {
      const normalized = search?.toLocaleLowerCase();
      const matching = normalized === undefined
        ? applicationItems
        : applicationItems.filter(({ label }) => label.toLocaleLowerCase().includes(normalized));
      const parsedOffset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      const offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0
        ? parsedOffset
        : matching.length;
      const items = matching.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        items,
        ...(nextOffset < matching.length ? { nextCursor: String(nextOffset) } : {}),
      };
    },
    resolve: ({ values }) => ({
      results: values.map((value) => ({
        value,
        item: applicationItems.find((item) => item.value === value) ?? null,
      })),
    }),
  });

  const capabilities = new CapabilityRegistry();
  capabilities.registerCancellation(dependencies.cancellation);

  const schemaValidator = new AjvSchemaValidator();
  const runs = new RunManager(operations, dependencies.runStore, {
    validateSchema: ({ schema, value }) => schemaValidator.validate(schema, value),
    validateFileReference: () => [],
    idempotencySecret: dependencies.idempotencySecret,
  });

  return createAdapterCatalog({
    application: {
      id: "portal",
      label: "Portal",
      environment: dependencies.environment,
    },
    profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    capabilities,
    operations,
    dataSources,
    runs,
    schemaValidator,
  });
}
