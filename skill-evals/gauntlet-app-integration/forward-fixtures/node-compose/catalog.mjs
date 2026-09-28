import {
  AjvSchemaValidator,
  CapabilityRegistry,
  DataSourceRegistry,
  InMemoryRunStore,
  OperationRegistry,
  RunManager,
  createAdapterCatalog,
  defineOperation,
} from "@8lines/gauntlet-typescript-core";

export function createCatalog({ application, idempotencySecret }) {
  const operations = new OperationRegistry();
  operations.registerFeature({ id: "fixtures", label: "Fixtures", order: 10 });
  let operationRuns = 0;
  let lastOperationInput = null;
  let dataSourceQueries = 0;
  let dataSourceResolves = 0;
  let lastDataSourceQuery = null;
  let lastDataSourceResolve = null;
  operations.register(defineOperation({
    id: "fixtures.set-clock",
    label: "Set synthetic clock",
    featureId: "fixtures",
    order: 10,
    tags: ["synthetic"],
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string", minLength: 1 } },
    },
    dataSources: [],
    presets: [],
    execution: {
      impact: "write",
      confirmationRequired: true,
      dryRunSupported: true,
      idempotency: "required",
      cancellationSupported: false,
    },
    output: {
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["accepted"],
        properties: { accepted: { type: "boolean" } },
      },
    },
  }, async (input) => {
    operationRuns += 1;
    lastOperationInput = input;
    return {
      summary: { title: "Synthetic clock accepted", tone: "success" },
      output: { accepted: true },
    };
  }));

  const dataSources = new DataSourceRegistry();
  dataSources.register({
    definition: {
      id: "accounts",
      label: "Accounts",
      capabilities: {
        search: true,
        pagination: "cursor",
        resolve: true,
        defaultLimit: 10,
        maxLimit: 20,
      },
    },
    query: (input) => {
      dataSourceQueries += 1;
      lastDataSourceQuery = input;
      return { items: [{ value: "account-1", label: "Synthetic account" }] };
    },
    resolve: (input) => {
      dataSourceResolves += 1;
      lastDataSourceResolve = input;
      return {
        results: input.values.map((value) => ({
        value,
        item: value === "account-1" ? { value, label: "Synthetic account" } : null,
        })),
      };
    },
  });

  const schemaValidator = new AjvSchemaValidator();
  const runs = new RunManager(operations, new InMemoryRunStore(), {
    validateSchema: ({ schema, value }) => schemaValidator.validate(schema, value),
    validateFileReference: () => [],
    idempotencySecret,
  });
  const catalog = createAdapterCatalog({
    application,
    profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    capabilities: new CapabilityRegistry(),
    operations,
    dataSources,
    runs,
    schemaValidator,
  });
  return {
    catalog,
    counters: () => ({
      operationRuns,
      lastOperationInput,
      dataSourceQueries,
      dataSourceResolves,
      lastDataSourceQuery,
      lastDataSourceResolve,
    }),
  };
}
