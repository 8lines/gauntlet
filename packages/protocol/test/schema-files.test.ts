import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaNames = [
  "common", "health", "manifest", "operation-definition", "create-run-request", "run", "run-event",
  "data-source-query", "data-source-page", "data-source-resolve-request", "data-source-resolve-response",
  "upload", "session-launch", "problem",
] as const;

async function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of schemaNames) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/v1/${name}.schema.json`, import.meta.url), "utf8"));
    ajv.addSchema(schema);
  }
  return ajv;
}

test("every endpoint fixture validates against its own Draft 2020-12 schema", async () => {
  const ajv = await validator();
  const fixtures = [
    ["health", "health"],
    ["manifest", "manifest"],
    ["manifest", "manifest.minor-forward"],
    ["operation-definition", "operation"],
    ["create-run-request", "create-run-request"],
    ["run", "run.queued"],
    ["run", "run.succeeded"],
    ["run", "run.failed"],
    ["run", "run.cancelled"],
    ["run", "run.timed-out"],
    ["run-event", "run-event"],
    ["data-source-query", "data-source-query"],
    ["data-source-page", "data-source-page"],
    ["data-source-resolve-request", "data-source-resolve-request"],
    ["data-source-resolve-response", "data-source-resolve-response"],
    ["upload", "upload-response"],
    ["session-launch", "session-launch"],
    ["problem", "problem"],
    ["problem", "problem.validation"],
    ["problem", "problem.unsupported-capability"],
  ] as const;
  for (const [schemaName, fixtureName] of fixtures) {
    const schema = ajv.getSchema(`https://schemas.8lines.dev/gauntlet/v1/${schemaName}.schema.json`);
    const fixture = JSON.parse(await readFile(new URL(`../fixtures/v1/${fixtureName}.valid.json`, import.meta.url), "utf8"));
    assert.ok(schema, `missing compiled schema ${schemaName}`);
    assert.equal(schema(fixture), true, `${schemaName}: ${JSON.stringify(schema.errors)}`);
  }
});

test("closed core objects reject unsafe IDs, major versions, unknown properties, and invalid run states", async () => {
  const ajv = await validator();
  const invalidFixtures = [
    ["operation-definition", "operation.invalid-unsafe-id"],
    ["manifest", "manifest.invalid-unknown-property"],
    ["manifest", "manifest.invalid-major-version"],
    ["run", "run.invalid-active-problem"],
    ["run", "run.invalid-terminal-without-problem"],
    ["run", "run.invalid-cancelled-problem"],
    ["run", "run.invalid-timed-out-status"],
  ] as const;
  for (const [schemaName, fixtureName] of invalidFixtures) {
    const validate = ajv.getSchema(`https://schemas.8lines.dev/gauntlet/v1/${schemaName}.schema.json`);
    const fixture = JSON.parse(await readFile(new URL(`../fixtures/v1/${fixtureName}.json`, import.meta.url), "utf8"));
    assert.ok(validate, `missing compiled schema ${schemaName}`);
    assert.equal(validate(fixture), false, `${fixtureName} unexpectedly passed`);
  }
});

test("manifest environments are structured and run confirmations are closed acknowledgements", async () => {
  const ajv = await validator();
  const validateManifest = ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/manifest.schema.json");
  const validateCreateRun = ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/create-run-request.schema.json");
  const manifest = JSON.parse(await readFile(new URL("../fixtures/v1/manifest.valid.json", import.meta.url), "utf8"));
  const createRun = JSON.parse(await readFile(new URL("../fixtures/v1/create-run-request.valid.json", import.meta.url), "utf8"));
  const revision = createRun.operationRevision;
  assert.ok(validateManifest);
  assert.ok(validateCreateRun);

  assert.equal(validateManifest({ ...manifest, application: { id: "app", label: "App" } }), false);
  assert.equal(validateManifest({
    ...manifest,
    application: { id: "app", label: "App", environment: "staging" },
  }), false);
  assert.equal(validateManifest({
    ...manifest,
    application: { id: "app", label: "App", environment: { name: "app-dev", kind: "staging" } },
  }), true);

  assert.equal(validateCreateRun({
    operationRevision: revision,
    input: {},
    confirmation: { operationId: "op", operationRevision: revision, impact: "write" },
  }), true);
  assert.equal(validateCreateRun({
    operationRevision: revision,
    input: {},
    confirmation: { operationId: "op", operationRevision: revision, impact: "write", extra: true },
  }), false);
});

test("all canonical schemas declare Draft 2020-12 and use only bundled refs", async () => {
  for (const name of schemaNames) {
    const text = await readFile(new URL(`../schemas/v1/${name}.schema.json`, import.meta.url), "utf8");
    const schema = JSON.parse(text);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(/\"\$ref\"\s*:\s*\"https?:\/\//.test(text), false, `${name} contains a network ref`);
  }
});

test("browser-facing URLs accept only absolute HTTP and HTTPS URLs", async () => {
  const ajv = await validator();
  const validateRun = ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/run.schema.json");
  const validateSession = ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/session-launch.schema.json");
  const baseRun = JSON.parse(await readFile(new URL("../fixtures/v1/run.queued.valid.json", import.meta.url), "utf8"));
  assert.ok(validateRun);
  assert.ok(validateSession);

  const runDocuments = (url: string) => [
    { ...baseRun, actions: [{ kind: "open-link", label: "Open", url }] },
    { ...baseRun, artifacts: [{ id: "link-1", kind: "link", label: "Open", url }] },
    {
      ...baseRun,
      artifacts: [{ id: "download-1", kind: "download", url, name: "report.txt", mediaType: "text/plain" }],
    },
  ];
  const sessionDocument = (url: string) => ({
    url,
    expiresAt: "2026-08-29T12:15:00Z",
    singleUse: true,
  });

  for (const url of ["http://example.test/path", "https://example.test/path"]) {
    for (const document of runDocuments(url)) {
      assert.equal(validateRun(document), true, JSON.stringify(validateRun.errors));
    }
    assert.equal(validateSession(sessionDocument(url)), true, JSON.stringify(validateSession.errors));
  }

  for (const url of ["javascript:alert(1)", "data:text/html,<h1>unsafe</h1>", "file:///etc/passwd"]) {
    for (const document of runDocuments(url)) {
      assert.equal(validateRun(document), false, `${url} unexpectedly passed as a Run URL`);
    }
    assert.equal(validateSession(sessionDocument(url)), false, `${url} unexpectedly passed as a session URL`);
  }
});
