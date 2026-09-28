import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  canonicalizeForRevision,
  computeRevision,
  type JsonObject,
  type JsonValue,
} from "../../src/index.js";

const ARTIFACT_NAME = "adapter-semantic-vectors.json";
const SCHEMA_NAME = "adapter-semantic-vectors.schema.json";
const FIXTURES_URL = new URL("../../fixtures/v1/", import.meta.url);
const SAFE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SAFE_SIBLING = /^(?!.*(?:\.\.|[\\/?:#]))[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;
const WORKLOAD_KINDS = new Set([
  "deep-chain",
  "rules-presets-cartesian",
  "dense-mutual-reference",
  "wide-array",
]);

export type SemanticPatch =
  | { readonly op: "add" | "replace"; readonly path: string; readonly value: JsonValue }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "copy"; readonly from: string; readonly path: string };

export type RevisionDirective =
  | { readonly mode: "preserve"; readonly expect: "match" | "mismatch" }
  | { readonly mode: "set"; readonly value: string; readonly expect: "match" };

export type ManifestDocumentVector = {
  readonly id: string;
  readonly predicate: "manifest";
  readonly precondition: "envelope-valid" | "owned-json-defensive";
  readonly document: {
    readonly source: "manifest";
    readonly patches: readonly SemanticPatch[];
    readonly revision: RevisionDirective;
  };
  readonly expected: boolean;
};

export type OperationDocumentVector = {
  readonly id: string;
  readonly predicate: "operation";
  readonly precondition: "envelope-valid";
  readonly document: {
    readonly source: "operation";
    readonly patches: readonly SemanticPatch[];
    readonly revision: RevisionDirective;
  };
  readonly expected: boolean;
};

export type ResolveDocumentVector = {
  readonly id: string;
  readonly predicate: "resolve";
  readonly precondition: "envelope-valid";
  readonly request: { readonly source: "resolve-request"; readonly patches: readonly SemanticPatch[] };
  readonly response: { readonly source: "resolve-response"; readonly patches: readonly SemanticPatch[] };
  readonly expected: boolean;
};

export type SemanticDocumentVector =
  | ManifestDocumentVector
  | OperationDocumentVector
  | ResolveDocumentVector;

export type PresetVectorCase = {
  readonly id: string;
  readonly presetInputs: readonly JsonObject[];
  readonly expectedRevision: string;
  readonly expected: boolean;
};

export type PresetVectorSuite = {
  readonly id: string;
  readonly inputSchema: JsonObject;
  readonly secretPointers: readonly string[];
  readonly cases: readonly PresetVectorCase[];
};

export type WorkloadRecipe =
  | { readonly kind: "deep-chain"; readonly depth: number; readonly leaf: "empty" | "secret"; readonly secretPointer: boolean }
  | { readonly kind: "rules-presets-cartesian"; readonly propertyCount: number; readonly ruleCopies: number; readonly presetCount: number }
  | { readonly kind: "dense-mutual-reference"; readonly graphSize: number }
  | { readonly kind: "wide-array"; readonly itemCount: number; readonly secretRule: boolean };

export type SemanticWorkload = {
  readonly id: string;
  readonly recipe: WorkloadRecipe;
  readonly expected: boolean;
  readonly expectedRevision: string;
  readonly canonicalBytes: number;
  readonly nodeReferenceBudget: {
    readonly timeoutMs: number;
    readonly execArgv: readonly string[];
    readonly maxRssKiBExclusive?: number;
    readonly maxRssDeltaKiBExclusive?: number;
    readonly controlId?: string;
  };
};

export type SemanticVectorArtifact = {
  readonly $schema: string;
  readonly format: "tc-adapter-semantic-vectors@1";
  readonly patchProfile: "rfc6902-test-subset@1";
  readonly presetAssemblyProfile: "tc-preset-operation@1";
  readonly workloadProfile: "tc-preset-workloads@1";
  readonly sourceFixtures: readonly {
    readonly id: "manifest" | "operation" | "resolve-request" | "resolve-response";
    readonly file: string;
    readonly sha256: string;
    readonly revisionField?: "manifestRevision" | "revision";
  }[];
  readonly presetAnalysisLimits: Readonly<Record<string, number>>;
  readonly documentVectors: readonly SemanticDocumentVector[];
  readonly presetSuites: readonly PresetVectorSuite[];
  readonly workloads: readonly SemanticWorkload[];
};

export type LoadedSemanticVectors = {
  readonly artifact: SemanticVectorArtifact;
  readonly sources: ReadonlyMap<string, JsonObject>;
};

type MutableJson = null | boolean | string | number | MutableJson[] | { [key: string]: MutableJson };

function invalid(id: string): never {
  throw new Error(`invalid semantic vector: ${id}`);
}

function checkedRevision(
  document: JsonObject,
  id: string,
  revisionField: "revision" | "manifestRevision" = "revision",
): string {
  try {
    return computeRevision(document, revisionField);
  } catch {
    return invalid(id);
  }
}

function checkedCanonicalBytes(document: JsonObject, id: string): number {
  try {
    return Buffer.byteLength(canonicalizeForRevision(document));
  } catch {
    return invalid(id);
  }
}

function asOwnedJson(value: unknown, id: string): MutableJson {
  try {
    return structuredClone(value) as MutableJson;
  } catch {
    return invalid(id);
  }
}

function parseBoundJson(bytes: Uint8Array, id: string): unknown {
  if (
    bytes.length === 0
    || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    || bytes.includes(0x0d)
    || bytes.at(-1) !== 0x0a
  ) {
    return invalid(id);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid(id);
  }
}

async function readBoundBytes(name: string, id: string): Promise<Uint8Array> {
  if (!SAFE_SIBLING.test(name)) invalid(id);
  try {
    return await readFile(new URL(name, FIXTURES_URL));
  } catch {
    return invalid(id);
  }
}

function decodePointer(pointer: string, id: string): string[] {
  if (!pointer.startsWith("/") || pointer.length === 0) invalid(id);
  return pointer.slice(1).split("/").map((token) => {
    if (/~(?:[^01]|$)/.test(token)) invalid(id);
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
  });
}

function arrayIndex(token: string, length: number, allowAppend: boolean, id: string): number {
  if (allowAppend && token === "-") return length;
  if (!CANONICAL_INDEX.test(token)) invalid(id);
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index >= length + Number(allowAppend)) invalid(id);
  return index;
}

function ownObject(value: MutableJson, id: string): { [key: string]: MutableJson } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(id);
  return value;
}

function existingValue(document: MutableJson, pointer: string, id: string): MutableJson {
  let current = document;
  for (const token of decodePointer(pointer, id)) {
    if (Array.isArray(current)) {
      current = current[arrayIndex(token, current.length, false, id)]!;
    } else {
      const object = ownObject(current, id);
      if (!Object.hasOwn(object, token)) invalid(id);
      current = object[token]!;
    }
  }
  return current;
}

function patchParent(document: MutableJson, pointer: string, id: string): {
  parent: MutableJson[] | { [key: string]: MutableJson };
  token: string;
} {
  const path = decodePointer(pointer, id);
  const token = path.pop();
  if (token === undefined) invalid(id);
  let parent = document;
  for (const segment of path) {
    if (Array.isArray(parent)) {
      parent = parent[arrayIndex(segment, parent.length, false, id)]!;
    } else {
      const object = ownObject(parent, id);
      if (!Object.hasOwn(object, segment)) invalid(id);
      parent = object[segment]!;
    }
  }
  if (parent === null || typeof parent !== "object") invalid(id);
  return { parent, token };
}

function writeObjectMember(
  object: { [key: string]: MutableJson },
  token: string,
  value: MutableJson,
): void {
  Object.defineProperty(object, token, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function applyPatches(
  source: JsonObject,
  patches: readonly SemanticPatch[],
  id: string,
  revisionField?: string,
): JsonObject {
  const document = asOwnedJson(source, id);
  for (const patch of patches) {
    const path = decodePointer(patch.path, id);
    if (revisionField !== undefined && path[0] === revisionField) invalid(id);
    if (patch.op === "copy") {
      const from = decodePointer(patch.from, id);
      if (revisionField !== undefined && from[0] === revisionField) invalid(id);
    }
    const value = patch.op === "copy"
      ? asOwnedJson(existingValue(document, patch.from, id), id)
      : patch.op === "remove"
        ? undefined
        : asOwnedJson(patch.value, id);
    const { parent, token } = patchParent(document, patch.path, id);
    if (Array.isArray(parent)) {
      if (patch.op === "add" || patch.op === "copy") {
        parent.splice(arrayIndex(token, parent.length, true, id), 0, value!);
      } else if (patch.op === "remove") {
        parent.splice(arrayIndex(token, parent.length, false, id), 1);
      } else {
        parent[arrayIndex(token, parent.length, false, id)] = value!;
      }
    } else if (patch.op === "add" || patch.op === "copy") {
      writeObjectMember(parent, token, value!);
    } else {
      if (!Object.hasOwn(parent, token)) invalid(id);
      if (patch.op === "remove") delete parent[token];
      else writeObjectMember(parent, token, value!);
    }
  }
  return ownObject(document, id) as JsonObject;
}

function revisedDocument(
  loaded: LoadedSemanticVectors,
  vector: ManifestDocumentVector | OperationDocumentVector,
): JsonObject {
  const source = loaded.sources.get(vector.document.source);
  if (source === undefined) invalid(vector.id);
  const revisionField = vector.predicate === "manifest" ? "manifestRevision" : "revision";
  const document = applyPatches(source, vector.document.patches, vector.id, revisionField) as {
    [key: string]: JsonValue;
  };
  if (vector.document.revision.mode === "set") {
    writeObjectMember(document as { [key: string]: MutableJson }, revisionField, vector.document.revision.value);
  }
  const actual = checkedRevision(document as JsonObject, vector.id, revisionField);
  const declared = document[revisionField];
  const matches = actual === declared;
  if (matches !== (vector.document.revision.expect === "match")) invalid(vector.id);
  return document;
}

export function materializeDocumentVector(
  loaded: LoadedSemanticVectors,
  vector: SemanticDocumentVector,
):
  | { readonly predicate: "manifest"; readonly document: JsonObject }
  | { readonly predicate: "operation"; readonly document: JsonObject }
  | { readonly predicate: "resolve"; readonly request: JsonObject; readonly response: JsonObject } {
  if (vector.predicate === "manifest") {
    return { predicate: "manifest", document: revisedDocument(loaded, vector) };
  }
  if (vector.predicate === "operation") {
    return { predicate: "operation", document: revisedDocument(loaded, vector) };
  }
  const requestSource = loaded.sources.get(vector.request.source);
  const responseSource = loaded.sources.get(vector.response.source);
  if (requestSource === undefined || responseSource === undefined) invalid(vector.id);
  return {
    predicate: "resolve",
    request: applyPatches(requestSource, vector.request.patches, vector.id),
    response: applyPatches(responseSource, vector.response.patches, vector.id),
  };
}

export function expandedPresetCaseId(
  suite: Pick<PresetVectorSuite, "id">,
  presetCase: Pick<PresetVectorCase, "id">,
): string {
  return `${suite.id}.${presetCase.id}`;
}

export function materializePresetCase(
  loaded: LoadedSemanticVectors,
  suite: PresetVectorSuite,
  presetCase: PresetVectorCase,
): JsonObject {
  const id = expandedPresetCaseId(suite, presetCase);
  const source = loaded.sources.get("operation");
  if (source === undefined) invalid(id);
  const operation = asOwnedJson(source, id) as { [key: string]: MutableJson };
  writeObjectMember(operation, "inputSchema", asOwnedJson(suite.inputSchema, id));
  writeObjectMember(operation, "inputHandling", {
    rules: suite.secretPointers.map((schemaPointer) => ({
      kind: "secret",
      schemaPointer,
      retention: "none",
    })),
  });
  writeObjectMember(operation, "dataSources", []);
  delete operation.uiSchema;
  writeObjectMember(operation, "presets", presetCase.presetInputs.map((input, index) => ({
    id: `preset-${index}`,
    label: `Preset ${index}`,
    input: asOwnedJson(input, id),
  })));
  writeObjectMember(operation, "revision", presetCase.expectedRevision);
  if (checkedRevision(operation as JsonObject, id) !== presetCase.expectedRevision) invalid(id);
  return operation as JsonObject;
}

export function materializeSemanticWorkload(
  loaded: LoadedSemanticVectors,
  workload: SemanticWorkload,
): JsonObject {
  const source = loaded.sources.get("operation");
  if (source === undefined) invalid(workload.id);
  let operation: JsonObject;
  switch (workload.recipe.kind) {
    case "deep-chain": {
      const schema: JsonObject = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { chain: { $ref: "#/$defs/node" } },
        $defs: {
          node: {
            type: "object",
            properties: {
              secret: { $ref: "#/$defs/target" },
              next: { $ref: "#/$defs/node" },
            },
          },
          target: { type: "string" },
        },
      };
      let node: JsonObject = workload.recipe.leaf === "secret" ? { secret: "seeded" } : {};
      for (let depth = 0; depth < workload.recipe.depth; depth += 1) node = { next: node };
      operation = assemblePresetOperation(
        source,
        schema,
        workload.recipe.secretPointer ? ["/$defs/target"] : [],
        [{ chain: node }],
        workload.expectedRevision,
        workload.id,
      );
      break;
    }
    case "rules-presets-cartesian": {
      const properties = Object.fromEntries(Array.from(
        { length: workload.recipe.propertyCount },
        (_, index) => [`secret${index}`, { type: "string" }],
      )) as JsonObject;
      const pointers = Array.from(
        { length: workload.recipe.propertyCount },
        (_, index) => `/properties/secret${index}`,
      );
      const rules = Array.from({ length: workload.recipe.ruleCopies }, () => pointers)
        .flat()
        .map((schemaPointer) => ({ kind: "secret", schemaPointer, retention: "none" }));
      const mutable = asOwnedJson(source, workload.id) as { [key: string]: MutableJson };
      writeObjectMember(mutable, "inputSchema", {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: properties as MutableJson,
        additionalProperties: false,
      });
      writeObjectMember(mutable, "inputHandling", { rules });
      writeObjectMember(mutable, "dataSources", []);
      delete mutable.uiSchema;
      writeObjectMember(mutable, "presets", Array.from(
        { length: workload.recipe.presetCount },
        (_, index) => ({ id: `empty-${index}`, label: `Empty ${index}`, input: {} }),
      ));
      writeObjectMember(mutable, "revision", workload.expectedRevision);
      operation = mutable as JsonObject;
      break;
    }
    case "dense-mutual-reference": {
      const nodeNames = Array.from({ length: workload.recipe.graphSize }, (_, index) => `n${index}`);
      const definitions = Object.fromEntries(nodeNames.map((nodeName) => [
        nodeName,
        {
          type: "object",
          properties: Object.fromEntries(nodeNames.map((targetName, index) => [
            `p${index}`,
            { $ref: `#/$defs/${targetName}` },
          ])),
        },
      ])) as JsonObject;
      const mutable = asOwnedJson(source, workload.id) as { [key: string]: MutableJson };
      writeObjectMember(mutable, "inputSchema", {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          start: { $ref: "#/$defs/n0" },
          secret: { type: "string" },
        },
        $defs: definitions as MutableJson,
      });
      writeObjectMember(mutable, "inputHandling", {
        rules: [{ kind: "secret", schemaPointer: "/properties/secret", retention: "none" }],
      });
      writeObjectMember(mutable, "dataSources", []);
      delete mutable.uiSchema;
      writeObjectMember(mutable, "presets", [{ id: "empty", label: "Empty", input: {} }]);
      writeObjectMember(mutable, "revision", workload.expectedRevision);
      operation = mutable as JsonObject;
      break;
    }
    case "wide-array": {
      const mutable = asOwnedJson(source, workload.id) as { [key: string]: MutableJson };
      writeObjectMember(mutable, "inputSchema", {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          values: { type: "array", items: { $ref: "#/$defs/target" } },
        },
        $defs: { target: { type: "string" } },
      });
      if (workload.recipe.secretRule) {
        writeObjectMember(mutable, "inputHandling", {
          rules: [{ kind: "secret", schemaPointer: "/$defs/target", retention: "none" }],
        });
      } else {
        delete mutable.inputHandling;
      }
      writeObjectMember(mutable, "dataSources", []);
      delete mutable.uiSchema;
      writeObjectMember(mutable, "presets", [{
        id: "wide",
        label: "Wide",
        input: { values: Array.from({ length: workload.recipe.itemCount }, () => "x") },
      }]);
      writeObjectMember(mutable, "revision", workload.expectedRevision);
      operation = mutable as JsonObject;
      break;
    }
    default:
      return invalid(workload.id);
  }
  if (
    checkedRevision(operation, workload.id) !== workload.expectedRevision
    || checkedCanonicalBytes(operation, workload.id) !== workload.canonicalBytes
  ) {
    invalid(workload.id);
  }
  return operation;
}

function assemblePresetOperation(
  source: JsonObject,
  inputSchema: JsonObject,
  secretPointers: readonly string[],
  presetInputs: readonly JsonObject[],
  expectedRevision: string,
  id: string,
): JsonObject {
  const operation = asOwnedJson(source, id) as { [key: string]: MutableJson };
  writeObjectMember(operation, "inputSchema", asOwnedJson(inputSchema, id));
  writeObjectMember(operation, "inputHandling", {
    rules: secretPointers.map((schemaPointer) => ({ kind: "secret", schemaPointer, retention: "none" })),
  });
  writeObjectMember(operation, "dataSources", []);
  delete operation.uiSchema;
  writeObjectMember(operation, "presets", presetInputs.map((input, index) => ({
    id: `preset-${index}`,
    label: `Preset ${index}`,
    input: asOwnedJson(input, id),
  })));
  writeObjectMember(operation, "revision", expectedRevision);
  return operation as JsonObject;
}

function assertGlobalIntegrity(loaded: LoadedSemanticVectors): void {
  const { artifact } = loaded;
  const presetCount = artifact.presetSuites.reduce((count, suite) => count + suite.cases.length, 0);
  if (artifact.documentVectors.length !== 56 || presetCount !== 54 || artifact.workloads.length !== 7) {
    invalid("artifact");
  }

  const ids = [
    ...artifact.documentVectors.map(({ id }) => id),
    ...artifact.presetSuites.flatMap((suite) => suite.cases.map((presetCase) =>
      expandedPresetCaseId(suite, presetCase)
    )),
    ...artifact.workloads.map(({ id }) => id),
  ];
  if (ids.some((id) => !SAFE_ID.test(id)) || new Set(ids).size !== 117) invalid("artifact");
  const mismatchIds: string[] = [];
  for (const vector of artifact.documentVectors) {
    materializeDocumentVector(loaded, vector);
    if (vector.predicate !== "resolve" && vector.document.revision.expect === "mismatch") {
      mismatchIds.push(vector.id);
    }
  }
  if (mismatchIds.sort().join("\n") !== "manifest.stale-revision\noperation.stale-revision") {
    invalid("artifact");
  }
  for (const suite of artifact.presetSuites) {
    for (const presetCase of suite.cases) materializePresetCase(loaded, suite, presetCase);
  }
  for (const workload of artifact.workloads) {
    if (!WORKLOAD_KINDS.has(workload.recipe.kind)) invalid(workload.id);
  }
}

export function computeVectorRevision(
  loaded: LoadedSemanticVectors,
  vector: ManifestDocumentVector | OperationDocumentVector,
): string {
  const source = loaded.sources.get(vector.document.source);
  if (source === undefined) invalid(vector.id);
  const revisionField = vector.predicate === "manifest" ? "manifestRevision" : "revision";
  return computeRevision(applyPatches(source, vector.document.patches, vector.id, revisionField), revisionField);
}

export type LoadSemanticVectorsOptions = {
  readonly skipRevisionChecks?: boolean;
};

export async function loadSemanticVectors(
  options: LoadSemanticVectorsOptions = {},
): Promise<LoadedSemanticVectors> {
  const [artifactBytes, schemaBytes] = await Promise.all([
    readBoundBytes(ARTIFACT_NAME, "artifact"),
    readBoundBytes(SCHEMA_NAME, "schema"),
  ]);
  if (artifactBytes.byteLength >= 256 * 1024 || artifactBytes.some((byte) => byte > 0x7f)) {
    invalid("artifact");
  }
  const artifactValue = parseBoundJson(artifactBytes, "artifact");
  const schemaValue = parseBoundJson(schemaBytes, "schema");
  try {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schemaValue as object);
    if (!validate(artifactValue)) invalid("artifact");
  } catch {
    invalid("artifact");
  }
  const artifact = artifactValue as SemanticVectorArtifact;
  const sourceIds = artifact.sourceFixtures.map(({ id }) => id);
  if (new Set(sourceIds).size !== sourceIds.length) invalid("artifact");

  const sourceEntries = await Promise.all(artifact.sourceFixtures.map(async (sourceFixture) => {
    const bytes = await readBoundBytes(sourceFixture.file, sourceFixture.id);
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== sourceFixture.sha256) invalid(sourceFixture.id);
    const value = parseBoundJson(bytes, sourceFixture.id);
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(sourceFixture.id);
    return [sourceFixture.id, value as JsonObject] as const;
  }));
  const loaded: LoadedSemanticVectors = { artifact, sources: new Map(sourceEntries) };
  if (!options.skipRevisionChecks) {
    assertGlobalIntegrity(loaded);
  }
  return loaded;
}
