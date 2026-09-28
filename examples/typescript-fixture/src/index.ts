import {
  AjvSchemaValidator,
  CapabilityRegistry,
  DataSourceRegistry,
  InMemoryRunStore,
  OperationRegistry,
  RunManager,
  createAdapterCatalog,
  defineOperation,
  subjectPlacement,
  type AdapterCatalog,
  type OperationDefinitionDraft,
} from "@8lines/gauntlet-typescript-core";

const schema = "https://json-schema.org/draft/2020-12/schema" as const;
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const applications = [
  { value: first, label: "Application Brown" },
  { value: second, label: "Application Green" },
] as const;

const inputSchema = {
  $schema: schema,
  type: "object",
  required: ["applicationId", "confirmationCode"],
  properties: {
    applicationId: { type: "string", format: "uuid" },
    confirmationCode: { type: "string", pattern: "^[0-9]{6}$" },
  },
  additionalProperties: false,
} as const;

const output = {
  schema: {
    $schema: schema,
    type: "object",
    required: ["finalized"],
    properties: { finalized: { const: true } },
    additionalProperties: false,
  },
  presentation: { profile: "tc-rich-results@1", defaultView: "summary" },
} as const;

function operationMetadata(
  id: "agency-applications.finalize" | "agency-applications.fail",
): OperationDefinitionDraft {
  return {
    id,
    label: id.endsWith(".fail")
      ? "Fail agency application"
      : "Finalize agency application",
    featureId: "agency-applications",
    description: "Exercise an explicitly registered agency application binding.",
    order: id.endsWith(".fail") ? 20 : 10,
    tags: ["agency", "applications"],
    requirements: {
      profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    },
    placements: [subjectPlacement("agency-application", { "/applicationId": "applicationId" })],
    inputSchema,
    inputHandling: {
      rules: [{ kind: "secret" as const, schemaPointer: "/properties/confirmationCode", retention: "none" as const }],
    },
    dataSources: [{
      id: "pending-applications",
      inputPointer: "/applicationId",
      dependencyPointers: ["/workflowState"],
      contextPointers: ["/target/id"],
      required: true,
    }],
    presets: [],
    execution: {
      impact: "write" as const,
      confirmationRequired: true,
      dryRunSupported: false,
      idempotency: "required" as const,
      cancellationSupported: false,
      concurrency: "queue" as const,
    },
    output,
  };
}

export function createConformanceCatalog(): AdapterCatalog {
  const operations = new OperationRegistry();
  operations.registerFeature({
    id: "agency-applications",
    label: "Agency applications",
    order: 10,
  });
  operations.register(defineOperation(
    operationMetadata("agency-applications.finalize"),
    async (_input, context) => {
      context.report({ current: 1, total: 1, phase: "complete" });
      context.addArtifact({
        id: "finalize-result",
        kind: "notice",
        level: "success",
        message: "Application finalized.",
      });
      context.addAction({
        kind: "open-link",
        label: "Review applications",
        url: "https://portal.example.test/applications",
      });
      return {
        summary: {
          title: "Application finalized",
          message: "Finalization completed.",
          tone: "success",
        },
        output: { finalized: true },
      };
    },
  ));
  operations.register(defineOperation(
    operationMetadata("agency-applications.fail"),
    async (input) => {
      throw new Error(`private fixture failure ${String(input.confirmationCode)}`);
    },
  ));

  const dataSources = new DataSourceRegistry();
  dataSources.register({
    definition: {
      id: "pending-applications",
      label: "Pending applications",
      capabilities: {
        search: true,
        pagination: "cursor",
        resolve: true,
        defaultLimit: 2,
        maxLimit: 20,
      },
      dependencySchema: {
        $schema: schema,
        type: "object",
        required: ["/workflowState"],
        properties: { "/workflowState": { const: "pending" } },
        additionalProperties: false,
      },
      contextSchema: {
        $schema: schema,
        type: "object",
        required: ["requestId", "target"],
        properties: {
          requestId: { type: "string" },
          target: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              environment: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    query: (request) => {
      const filtered = request.search === undefined
        ? applications
        : applications.filter(({ label }) => label.toLowerCase().includes(request.search!.toLowerCase()));
      const offset = request.cursor === undefined ? 0 : Number.parseInt(request.cursor, 10);
      const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : filtered.length;
      const limit = request.limit ?? 2;
      const items = filtered.slice(safeOffset, safeOffset + limit);
      const nextOffset = safeOffset + items.length;
      return {
        items,
        ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
      };
    },
    resolve: (request) => ({
      results: request.values.map((value) => ({
        value,
        item: applications.find((candidate) => candidate.value === value) ?? null,
      })),
    }),
  });

  const validator = new AjvSchemaValidator();
  let runSequence = 0;
  const manager = new RunManager(
    operations,
    new InMemoryRunStore(),
    {
      validateSchema: ({ schema: value, value: instance }) => validator.validate(value, instance),
      validateFileReference: () => [],
      now: () => "2026-08-29T12:00:00Z",
      createId: () => `conformance-run-${++runSequence}`,
      idempotencySecret: new Uint8Array(32).fill(7),
    },
  );
  return createAdapterCatalog({
    application: {
      id: "conformance-adapter",
      label: "Conformance fixture",
      environment: { name: "typescript-fixture-test", kind: "test" },
    },
    profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    capabilities: new CapabilityRegistry(),
    operations,
    dataSources,
    runs: manager,
    schemaValidator: validator,
  });
}
