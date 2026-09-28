import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  canonicalizeForRevision,
  operationSemanticsAreValid,
  type OperationDefinition,
} from "../../src/index.js";
import {
  loadSemanticVectors,
  materializeSemanticWorkload,
} from "./semantic-vector-loader.js";

const schemaNames = [
  "common", "health", "manifest", "operation-definition", "create-run-request", "run", "run-event",
  "data-source-query", "data-source-page", "data-source-resolve-request", "data-source-resolve-response",
  "upload", "session-launch", "problem",
] as const;

async function operationEnvelopeIsValid(operation: unknown): Promise<boolean> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of schemaNames) {
    const schema = JSON.parse(await readFile(
      new URL(`../../schemas/v1/${name}.schema.json`, import.meta.url),
      "utf8",
    ));
    ajv.addSchema(schema);
  }
  const validate = ajv.getSchema(
    "https://schemas.8lines.dev/gauntlet/v1/operation-definition.schema.json",
  );
  return validate !== undefined && validate(operation);
}

function emit(
  status: "ok" | "error",
  id: string,
  actual: boolean,
  canonicalBytes: number,
): void {
  process.stdout.write(`${JSON.stringify({
    status,
    id,
    actual,
    canonicalBytes,
    maxRssKiB: process.resourceUsage().maxRSS,
  })}\n`);
}

async function main(): Promise<void> {
  const [id, ...extra] = process.argv.slice(2);
  if (id === undefined || extra.length !== 0 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) {
    process.exitCode = 2;
    return;
  }
  try {
    const loaded = await loadSemanticVectors();
    const workload = loaded.artifact.workloads.find((candidate) => candidate.id === id);
    if (workload === undefined) {
      process.exitCode = 2;
      return;
    }
    const operation = materializeSemanticWorkload(loaded, workload) as unknown as OperationDefinition;
    const canonicalBytes = Buffer.byteLength(canonicalizeForRevision(operation));
    const actual = await operationEnvelopeIsValid(operation)
      && operationSemanticsAreValid(operation);
    const status = actual === workload.expected ? "ok" : "error";
    emit(status, workload.id, actual, canonicalBytes);
    if (status === "error") process.exitCode = 1;
  } catch {
    emit("error", id, false, 0);
    process.exitCode = 1;
  }
}

await main();
