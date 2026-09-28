import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemasUrl = new URL("../schemas/v1/", import.meta.url);
const fixturesUrl = new URL("../fixtures/v1/", import.meta.url);
const json = async (url: URL) => JSON.parse(await readFile(url, "utf8"));

async function validators() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const name of ["common", "problem", "manifest", "operation-definition"]) {
    ajv.addSchema(await json(new URL(`${name}.schema.json`, schemasUrl)));
  }
  return {
    operation: ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/operation-definition.schema.json")!,
    manifest: ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/manifest.schema.json")!,
  };
}

const valid = [
  [{ kind: "global" }],
  [{ kind: "subject", subjectType: "order" }],
  [{ kind: "global" }, { kind: "subject", subjectType: "order", bindings: { "/applicationId": "orderId", "/a~1b": "k" } }],
];
const invalid = [
  [],
  [{ kind: "page" }],
  [{ kind: "global", subjectType: "order" }],
  [{ kind: "subject" }],
  [{ kind: "subject", subjectType: "bad id" }],
  [{ kind: "subject", subjectType: "order", bindings: {} }],
  [{ kind: "subject", subjectType: "order", bindings: { "": "orderId" } }],
  [{ kind: "subject", subjectType: "order", bindings: { "applicationId": "orderId" } }],
  [{ kind: "subject", subjectType: "order", bindings: { "/applicationId": "bad key" } }],
  [{ kind: "subject", subjectType: "order", extra: true }],
];

test("operation definitions accept only well-formed placements", async () => {
  const { operation } = await validators();
  const base = await json(new URL("operation.valid.json", fixturesUrl));
  for (const placements of valid) assert.equal(operation({ ...base, placements }), true, JSON.stringify(placements));
  for (const placements of invalid) assert.equal(operation({ ...base, placements }), false, JSON.stringify(placements));
});

test("operation summaries accept only well-formed placements", async () => {
  const { manifest } = await validators();
  const base = await json(new URL("manifest.valid.json", fixturesUrl));
  const withPlacements = (placements: unknown) => ({
    ...base,
    operations: base.operations.map((summary: object, index: number) => index === 0 ? { ...summary, placements } : summary),
  });
  for (const placements of valid) assert.equal(manifest(withPlacements(placements)), true, JSON.stringify(placements));
  for (const placements of invalid) assert.equal(manifest(withPlacements(placements)), false, JSON.stringify(placements));
});
