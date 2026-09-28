import { readFile } from "node:fs/promises";
import { computeVectorRevision, loadSemanticVectors } from "./semantic-vector-loader.js";

// Usage: tsx test/support/print-vector-revisions.ts <vector-id-prefix>
const prefix = process.argv[2] ?? "";
const raw = JSON.parse(await readFile(new URL("../../fixtures/v1/adapter-semantic-vectors.json", import.meta.url), "utf8"));
const loaded = await loadSemanticVectors({ skipRevisionChecks: true });
for (const vector of raw.documentVectors) {
  if (vector.predicate === "resolve" || !vector.id.startsWith(prefix)) continue;
  console.log(`${vector.id} ${computeVectorRevision(loaded, vector)}`);
}
