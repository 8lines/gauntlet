import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type OpenApiRecord = Record<string, unknown>;

function record(value: unknown, label: string): OpenApiRecord {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as OpenApiRecord;
}

async function openApiDocument(): Promise<OpenApiRecord> {
  const source = await readFile(new URL("../openapi/adapter-v1.yaml", import.meta.url), "utf8");
  return record(parse(source), "OpenAPI document");
}

function operationResponses(document: OpenApiRecord, path: string, method: "get" | "post"): OpenApiRecord {
  const paths = record(document.paths, "paths");
  const pathItem = record(paths[path], path);
  const operation = record(pathItem[method], `${method.toUpperCase()} ${path}`);
  return record(operation.responses, `${method.toUpperCase()} ${path} responses`);
}

function jsonSchemaRef(response: unknown, label: string): string {
  const content = record(record(response, label).content, `${label} content`);
  const mediaType = record(content["application/json"], `${label} application/json`);
  return record(mediaType.schema, `${label} schema`).$ref as string;
}

function requestJsonSchemaRef(document: OpenApiRecord, path: string, method: "post"): string {
  const paths = record(document.paths, "paths");
  const pathItem = record(paths[path], path);
  const operation = record(pathItem[method], `${method.toUpperCase()} ${path}`);
  return jsonSchemaRef(operation.requestBody, `${method.toUpperCase()} ${path} request`);
}

test("OpenAPI distinguishes synchronous and accepted run creation responses", async () => {
  const document = await openApiDocument();
  const path = "/_gauntlet/v1/operations/{operationId}/runs";
  const responses = operationResponses(document, path, "post");

  assert.equal(requestJsonSchemaRef(document, path, "post"), "../schemas/v1/create-run-request.schema.json");
  assert.equal(jsonSchemaRef(responses["201"], "createRun 201"), "../schemas/v1/run.schema.json");
  assert.equal(jsonSchemaRef(responses["202"], "createRun 202"), "../schemas/v1/run.schema.json");
});

test("OpenAPI conditional manifest and operation GETs retain ETags and bodyless 304 responses", async () => {
  const document = await openApiDocument();
  const cases = [
    ["/_gauntlet/v1/manifest", "../schemas/v1/manifest.schema.json"],
    ["/_gauntlet/v1/operations/{operationId}", "../schemas/v1/operation-definition.schema.json"],
  ] as const;

  for (const [path, expectedRef] of cases) {
    const responses = operationResponses(document, path, "get");
    const success = record(responses["200"], `${path} 200`);
    const headers = record(success.headers, `${path} 200 headers`);
    assert.ok(Object.hasOwn(headers, "ETag"), `${path} 200 must retain ETag`);
    assert.equal(jsonSchemaRef(success, `${path} 200`), expectedRef);

    const notModified = record(responses["304"], `${path} 304`);
    assert.equal(Object.hasOwn(notModified, "content"), false, `${path} 304 must not declare a body`);
  }
});
