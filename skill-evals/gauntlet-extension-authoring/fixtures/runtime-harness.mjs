import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const configuredRepositoryRoot = "__REPOSITORY_ROOT__";
const repositoryRoot = configuredRepositoryRoot.startsWith("__REPOSITORY_")
  ? resolve(import.meta.dirname, "../../..")
  : configuredRepositoryRoot;

let corePromise;

async function loadCore() {
  corePromise ??= (async () => {
    const require = createRequire(resolve(repositoryRoot, "package.json"));
    const apiUrl = pathToFileURL(require.resolve("tsx/esm/api")).href;
    const { tsImport } = await import(apiUrl);
    return tsImport(
      resolve(repositoryRoot, "packages/typescript/core/src/index.ts"),
      pathToFileURL(resolve(repositoryRoot, "package.json")).href,
    );
  })();
  return corePromise;
}

const contextSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["requestId", "actor", "target"],
  properties: {
    requestId: { type: "string", minLength: 1, maxLength: 128 },
    actor: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
      additionalProperties: false,
    },
    target: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        environment: { type: "string", maxLength: 128 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export async function createRegisteredOperationRuntime({ definition, handler, application }) {
  const {
    createAjvSchemaValidator,
    defineOperation,
    InMemoryRunStore,
    OperationRegistry,
    RunManager,
  } = await loadCore();
  const validator = createAjvSchemaValidator();
  const operation = defineOperation({
    label: definition.id,
    order: 0,
    tags: [],
    dataSources: [],
    presets: [],
    contextSchema,
    ...definition,
  }, async (input, context) => ({ output: await handler(input, context, application) }));
  const registry = new OperationRegistry();
  registry.registerFeature({ id: operation.definition.featureId, label: operation.definition.featureId });
  registry.register(operation);
  const store = new InMemoryRunStore();
  const pending = [];
  let id = 0;
  let tick = 0;
  const manager = new RunManager(registry, store, {
    validateSchema: ({ schema, value }) => validator.validate(schema, value),
    validateFileReference: () => [],
    idempotencySecret: new TextEncoder().encode("extension-eval-stable-idempotency-secret"),
    createId: () => `extension-eval-run-${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 5, 10, 0, tick++)).toISOString(),
    schedule: (task) => pending.push(task),
  });

  return Object.freeze({
    definition: operation.definition,
    confirmation(overrides = {}) {
      return {
        operationId: operation.definition.id,
        operationRevision: operation.definition.revision,
        impact: operation.definition.execution.impact,
        ...overrides,
      };
    },
    create({
      input,
      idempotencyKey,
      confirmation,
      dryRun,
      requestId = "extension-eval-request",
      actorId = "tester-one",
      targetId = "tenant-red",
    }) {
      return manager.create(operation.definition.id, {
        operationRevision: operation.definition.revision,
        input,
        context: {
          requestId,
          actor: { id: actorId },
          target: { id: targetId, environment: "synthetic-staging" },
        },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(confirmation === undefined ? {} : { confirmation }),
        ...(dryRun === undefined ? {} : { dryRun }),
      });
    },
    get: (runId) => manager.get(runId),
    async settle() {
      while (pending.length > 0) await pending.shift()();
    },
  });
}
