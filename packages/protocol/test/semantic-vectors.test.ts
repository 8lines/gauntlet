import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  computeRevision,
  type AdapterManifest,
  type DataSourceResolveRequest,
  type DataSourceResolveResponse,
  type JsonObject,
  type OperationDefinition,
} from "../src/index.js";
import {
  expandedPresetCaseId,
  loadSemanticVectors,
  materializeDocumentVector,
  materializePresetCase,
} from "./support/semantic-vector-loader.js";

const execFileAsync = promisify(execFile);

type VectorArtifact = {
  readonly sourceFixtures: readonly {
    readonly id: string;
    readonly file: string;
    readonly sha256: string;
    readonly revisionField?: string;
  }[];
  readonly presetAnalysisLimits: Readonly<Record<string, number>>;
  readonly documentVectors: readonly {
    readonly id: string;
    readonly document?: { readonly revision: { readonly value?: string } };
  }[];
  readonly presetSuites: readonly {
    readonly id: string;
    readonly cases: readonly { readonly id: string; readonly expectedRevision: string }[];
  }[];
  readonly workloads: readonly {
    readonly id: string;
    readonly recipe: Readonly<Record<string, unknown>>;
    readonly expected: boolean;
    readonly expectedRevision: string;
    readonly canonicalBytes: number;
    readonly nodeReferenceBudget: Readonly<Record<string, unknown>>;
  }[];
};

type MutableNodeReferenceBudget = {
  timeoutMs?: number;
  execArgv?: string[];
  maxRssKiBExclusive?: number;
  maxRssDeltaKiBExclusive?: number;
  controlId?: string;
};

const schemaNames = [
  "common", "health", "manifest", "operation-definition", "create-run-request", "run", "run-event",
  "data-source-query", "data-source-page", "data-source-resolve-request", "data-source-resolve-response",
  "upload", "session-launch", "problem",
] as const;

async function endpointValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of schemaNames) {
    const schema = JSON.parse(await readFile(
      new URL(`../schemas/v1/${name}.schema.json`, import.meta.url),
      "utf8",
    ));
    ajv.addSchema(schema);
  }
  const get = (name: string) => {
    const validate = ajv.getSchema(`https://schemas.8lines.dev/gauntlet/v1/${name}.schema.json`);
    assert.ok(validate, name);
    return validate;
  };
  return {
    manifest: get("manifest"),
    operation: get("operation-definition"),
    resolveRequest: get("data-source-resolve-request"),
    resolveResponse: get("data-source-resolve-response"),
  };
}

async function runBashProbe(script: string): Promise<number> {
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });
  const [temporaryRoot] = result.stdout.split("\n");
  assert.ok(temporaryRoot?.startsWith("/"), "probe did not report its temporary root");
  let rootStillExists = true;
  try {
    await access(temporaryRoot);
  } catch {
    rootStillExists = false;
  }
  assert.equal(rootStillExists, false, "probe EXIT trap did not clean its temporary root");
  assert.notEqual(result.code, null, "probe terminated by signal");
  return result.code!;
}

test("the shared semantic-vector artifact is schema-valid, source-bound, and complete", async () => {
  const fixtures = new URL("../fixtures/v1/", import.meta.url);
  const [artifactText, schemaText] = await Promise.all([
    readFile(new URL("adapter-semantic-vectors.json", fixtures), "utf8"),
    readFile(new URL("adapter-semantic-vectors.schema.json", fixtures), "utf8"),
  ]);
  const artifact = JSON.parse(artifactText) as VectorArtifact;
  const schema = JSON.parse(schemaText);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  assert.equal(validate(artifact), true, "semantic vector schema rejected the artifact");
  const references: string[] = [];
  const collectReferences = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectReferences);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref") references.push(String(child));
        collectReferences(child);
      }
    }
  };
  collectReferences(schema);
  assert.equal(references.every((reference) => reference.startsWith("#/$defs/")), true);
  assert.deepEqual(artifact.sourceFixtures, [
    {
      id: "manifest",
      file: "manifest.valid.json",
      sha256: "sha256:e9947f89e453cfe16b3fe4518fbb56df9718eedd71e9fbbee6e71d1a438b424a",
      revisionField: "manifestRevision",
    },
    {
      id: "operation",
      file: "operation.valid.json",
      sha256: "sha256:62332463ed4a1e30e2bab3bcf7ed74a72bac50cb34b92711433c796e959639b0",
      revisionField: "revision",
    },
    {
      id: "resolve-request",
      file: "data-source-resolve-request.valid.json",
      sha256: "sha256:fb7afb06128bfc2e6edaa827e32dc6fa48484f624010ff5d40c16d8d0a7a5856",
    },
    {
      id: "resolve-response",
      file: "data-source-resolve-response.valid.json",
      sha256: "sha256:37c5ef68864df86e3083d395bb9fe6d506c9ec436f4aca146016668bbb2b03fb",
    },
  ]);
  assert.deepEqual(artifact.presetAnalysisLimits, {
    maxGraphNodes: 250000,
    maxGraphEdges: 500000,
    maxPresetVisits: 500000,
    minimumVisitBudget: 8192,
    graphNodeWeight: 4,
    graphEdgeWeight: 2,
    inputNodeWeight: 64,
    routeCountSaturation: 2,
  });
  assert.equal(artifact.documentVectors.length, 56);
  assert.equal(
    artifact.presetSuites.reduce((count, suite) => count + suite.cases.length, 0),
    54,
  );
  assert.equal(artifact.workloads.length, 7);

  const revisions = new Map<string, string>();
  for (const vector of artifact.documentVectors) {
    if (vector.document?.revision.value !== undefined) revisions.set(vector.id, vector.document.revision.value);
  }
  for (const suite of artifact.presetSuites) {
    for (const presetCase of suite.cases) {
      revisions.set(`${suite.id}.${presetCase.id}`, presetCase.expectedRevision);
    }
  }
  assert.deepEqual(
    Object.fromEntries(
      artifact.documentVectors
        .filter((vector) => vector.id.startsWith("manifest.") && vector.document?.revision.value !== undefined)
        .map((vector) => [vector.id, vector.document!.revision.value]),
    ),
    {
      "manifest.environment.production-name": "sha256:17cdb4ab5503ff283fcf903e935a354d31359816be062e4642b67e8f37b00905",
      "manifest.feature.duplicate-id": "sha256:1af339c5bc592a50c5e08598bd98b564a7d93e119ddfede9d387081c8451a9b5",
      "manifest.feature.missing-parent": "sha256:007e885c3605b330ff9f994d939168be276bd92ec354c34469947f0e6b012e91",
      "manifest.feature.cycle": "sha256:e6dd41353db7859353b6870563f6b14070692541b3887835e6dd06b13b5fb396",
      "manifest.operation.duplicate-id": "sha256:9dfd52ecdb2e4ae3ea4fe2d3edf0b1dcdafde4167cb0df995369b734d43a2402",
      "manifest.data-source.duplicate-id": "sha256:f63e3c86ae76c844cc88b29dfa46e77e2adb5e384c8fcd88dcae9a91eb161e51",
      "manifest.unavailable.missing-profile": "sha256:d0b2be4a0093319c82fc7c701111a5eeb1b37f2d3a30a5e8ded53b3704d3579f",
      "manifest.unavailable.missing-capability": "sha256:dd3e015a67eed0df0d38b52105b66a5f678d5b84f23c83906128265d1ef0f106",
      "manifest.unavailable.missing-mixed": "sha256:bb71c2fe8ca51188ef73bd958388c8bce3a6537256b62b60e9c15e48a5cc85ce",
      "manifest.available.missing-profile": "sha256:aa5e00053310b86a61583545a2a552ad11277c9f7ffd95ac85f17aff235db6fc",
      "manifest.available.missing-capability": "sha256:e6c0da17d49c46aa91e3f7d3ce17b5370e31fd5953b329ac2cf3e938bea236d2",
      "manifest.available.missing-mixed": "sha256:af727cda563c5d725ada3b62315b5f7132d185b3bf27b6ee3186318da1835ab7",
      "manifest.diagnostic.omitted-operation-id": "sha256:c3228d321beecef519b35924f8ef415ed3c623ef932a092e17279e4c2521552d",
      "manifest.operation.unknown-feature": "sha256:e72dc1a6d0af5b596188fd08a72a9bec228db7ab1843dae6729ec63aeb5c4686",
      "manifest.data-source.invalid-limits": "sha256:746c8fab8d5039d2b3f94a6e82d77321c2f5a501cf07d96aa09d3fe3ec1a6ace",
      "manifest.data-source.remote-dependency-schema": "sha256:545cf3da72f02d4f4dc1bd98aac6d8ab32b40639e0965215ed1af752ddee324e",
      "manifest.data-source.non-object-context-schema": "sha256:101ec61ff13e4d1aa20dfff3667892894d9da76765f5e86a6ab848381978fadf",
      "manifest.placements.profile-declared": "sha256:9068920632a2c567321b4dd1dac9d1c3747f422601f21744713c29bbf2116965",
      "manifest.placements.profile-missing": "sha256:1c9ad4f1b16dea7f30413604edb805f1eec300fd1e2f24030b2d8f9604870099",
    },
  );
  for (const [id, expectedRevision] of [
    ["operation.destructive.valid", "sha256:50dd8fdf626bdae26950b8bb703f8e5edffda3acf16fc87c86f65602b367b854"],
    ["operation.destructive.missing-confirmation", "sha256:b1774fb877ce680668b26005c4a23bc2f40431ed8a267b603be316fb8397d63e"],
    ["operation.destructive.optional-idempotency", "sha256:c808f477eefa28259c324efc2148ed8d3d55b3ec5930417b23b2e83918edcd68"],
    ["operation.preset.secret-populated", "sha256:4f3d6822f2edbd1a4ae07c42209c50ccb4dea6355f91599379fb3374605c8885"],
    ["preset.static-applicator-chain.secret-without-trigger", "sha256:6a939b0b4eea117ad3285f2b689a6e99e8a20d2bab5542d4cc99c5fa606e5f7a"],
    ["preset.static-applicator-chain.trigger-only", "sha256:98eb0620aeda6662949b05d8e38d09b811bfab751566fd72df3b6943e3c90969"],
    ["preset.static-applicator-chain.later-preset-secret", "sha256:a8899c885fba329b92eabc10972ccee3a9a234083460a87bc6dec6bebf293822"],
  ] as const) {
    assert.equal(revisions.get(id), expectedRevision, id);
  }

  assert.deepEqual(artifact.workloads.map((workload) => ({
    id: workload.id,
    recipe: workload.recipe,
    expected: workload.expected,
    expectedRevision: workload.expectedRevision,
    canonicalBytes: workload.canonicalBytes,
  })), [
    {
      id: "preset.workload.deep.no-rule-empty",
      recipe: { kind: "deep-chain", depth: 1500, leaf: "empty", secretPointer: false },
      expected: true,
      expectedRevision: "sha256:5d63668c9804515abfa471f524fb9c16191c9adc726910058056fcd665c1035a",
      canonicalBytes: 15667,
    },
    {
      id: "preset.workload.deep.secret-rule-empty",
      recipe: { kind: "deep-chain", depth: 1500, leaf: "empty", secretPointer: true },
      expected: true,
      expectedRevision: "sha256:dc91be4117248a0d3041b83665952e857ed76736d941df4c1a65cbf4867bb9af",
      canonicalBytes: 15735,
    },
    {
      id: "preset.workload.deep.secret-rule-populated",
      recipe: { kind: "deep-chain", depth: 1500, leaf: "secret", secretPointer: true },
      expected: false,
      expectedRevision: "sha256:37279cd7270686e75a377cfd01a35a0c7503890747a0776994295655ab3d9db9",
      canonicalBytes: 15752,
    },
    {
      id: "preset.workload.cartesian.empty",
      recipe: { kind: "rules-presets-cartesian", propertyCount: 225, ruleCopies: 2, presetCount: 225 },
      expected: true,
      expectedRevision: "sha256:f77733a245f7e85aa7c53c1a3978ac20e5b66a1eb8d1e1cdee9754d84a583107",
      canonicalBytes: 54062,
    },
    {
      id: "preset.workload.dense.empty",
      recipe: { kind: "dense-mutual-reference", graphSize: 120 },
      expected: true,
      expectedRevision: "sha256:7739a31a82ef04c4f1b45f451908fd1ec22bd0bb9da63c63bc75b195bcc5719c",
      canonicalBytes: 426806,
    },
    {
      id: "preset.workload.wide.no-secret-control",
      recipe: { kind: "wide-array", itemCount: 900000, secretRule: false },
      expected: true,
      expectedRevision: "sha256:69f5598d4307d6aa1035916b6215dd2d33c916e5bd7bb7286bc4f79d55efb22b",
      canonicalBytes: 3602052,
    },
    {
      id: "preset.workload.wide.secret",
      recipe: { kind: "wide-array", itemCount: 900000, secretRule: true },
      expected: false,
      expectedRevision: "sha256:9e15ef55162357bd15dc852ea2281ab326a877c5303afdd3a088909de517c73d",
      canonicalBytes: 3602149,
    },
  ]);

  for (const source of artifact.sourceFixtures) {
    const bytes = await readFile(new URL(source.file, fixtures));
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(actual, source.sha256, source.id);
  }
});

test("the companion schema freezes every Node reference budget and rejects weakening mutations", async () => {
  const fixtures = new URL("../fixtures/v1/", import.meta.url);
  const [artifactText, schemaText] = await Promise.all([
    readFile(new URL("adapter-semantic-vectors.json", fixtures), "utf8"),
    readFile(new URL("adapter-semantic-vectors.schema.json", fixtures), "utf8"),
  ]);
  const artifact = JSON.parse(artifactText) as VectorArtifact;
  const schema = JSON.parse(schemaText);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  assert.deepEqual(artifact.workloads.map(({ id, nodeReferenceBudget }) => ({
    id,
    nodeReferenceBudget,
  })), [
    {
      id: "preset.workload.deep.no-rule-empty",
      nodeReferenceBudget: { timeoutMs: 2500, execArgv: [] },
    },
    {
      id: "preset.workload.deep.secret-rule-empty",
      nodeReferenceBudget: { timeoutMs: 2500, execArgv: [] },
    },
    {
      id: "preset.workload.deep.secret-rule-populated",
      nodeReferenceBudget: { timeoutMs: 2500, execArgv: [] },
    },
    {
      id: "preset.workload.cartesian.empty",
      nodeReferenceBudget: { timeoutMs: 2500, execArgv: [] },
    },
    {
      id: "preset.workload.dense.empty",
      nodeReferenceBudget: { timeoutMs: 2500, execArgv: [] },
    },
    {
      id: "preset.workload.wide.no-secret-control",
      nodeReferenceBudget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
      },
    },
    {
      id: "preset.workload.wide.secret",
      nodeReferenceBudget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
  ]);
  assert.equal(validate(artifact), true, "baseline semantic vector artifact");

  const standardIds = [
    "preset.workload.deep.no-rule-empty",
    "preset.workload.deep.secret-rule-empty",
    "preset.workload.deep.secret-rule-populated",
    "preset.workload.cartesian.empty",
    "preset.workload.dense.empty",
  ] as const;
  const standardInvalidBudgets: readonly {
    readonly label: string;
    readonly budget: MutableNodeReferenceBudget;
  }[] = [
    {
      label: "changed timeout",
      budget: { timeoutMs: 10000, execArgv: [] },
    },
    {
      label: "wide flags",
      budget: {
        timeoutMs: 2500,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
      },
    },
    {
      label: "maximum RSS",
      budget: { timeoutMs: 2500, execArgv: [], maxRssKiBExclusive: 458752 },
    },
    {
      label: "RSS delta",
      budget: { timeoutMs: 2500, execArgv: [], maxRssDeltaKiBExclusive: 40960 },
    },
    {
      label: "control link",
      budget: {
        timeoutMs: 2500,
        execArgv: [],
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
  ];
  const invalidBudgets: {
    label: string;
    id: string;
    budget: MutableNodeReferenceBudget;
  }[] = standardIds.flatMap((id) => standardInvalidBudgets.map(({ label, budget }) => ({
    label: `${id}: ${label}`,
    id,
    budget,
  })));
  invalidBudgets.push(
    {
      label: "wide control: changed timeout",
      id: "preset.workload.wide.no-secret-control",
      budget: {
        timeoutMs: 2500,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
      },
    },
    {
      label: "wide control: reordered flags",
      id: "preset.workload.wide.no-secret-control",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-semi-space-size=48", "--max-old-space-size=512"],
      },
    },
    {
      label: "wide control: duplicated flags",
      id: "preset.workload.wide.no-secret-control",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-old-space-size=512"],
      },
    },
    {
      label: "wide control: one flag omitted",
      id: "preset.workload.wide.no-secret-control",
      budget: { timeoutMs: 10000, execArgv: ["--max-old-space-size=512"] },
    },
    {
      label: "wide control: execArgv omitted",
      id: "preset.workload.wide.no-secret-control",
      budget: { timeoutMs: 10000 },
    },
    {
      label: "wide control: maximum RSS attached",
      id: "preset.workload.wide.no-secret-control",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssKiBExclusive: 458752,
      },
    },
    {
      label: "wide control: RSS delta attached",
      id: "preset.workload.wide.no-secret-control",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssDeltaKiBExclusive: 40960,
      },
    },
    {
      label: "wide control: control link attached",
      id: "preset.workload.wide.no-secret-control",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: changed timeout",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 2500,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: reordered flags",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-semi-space-size=48", "--max-old-space-size=512"],
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: duplicated flags",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-old-space-size=512"],
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: one flag omitted",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512"],
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: execArgv omitted",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: maximum RSS changed",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssKiBExclusive: 458751,
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: maximum RSS omitted",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: RSS delta changed",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40959,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: RSS delta omitted",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssKiBExclusive: 458752,
        controlId: "preset.workload.wide.no-secret-control",
      },
    },
    {
      label: "wide secret: control link changed",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40960,
        controlId: "preset.workload.wide.secret",
      },
    },
    {
      label: "wide secret: control link omitted",
      id: "preset.workload.wide.secret",
      budget: {
        timeoutMs: 10000,
        execArgv: ["--max-old-space-size=512", "--max-semi-space-size=48"],
        maxRssKiBExclusive: 458752,
        maxRssDeltaKiBExclusive: 40960,
      },
    },
  );
  assert.equal(invalidBudgets.length, 44, "complete Node reference-budget mutation matrix");

  const acceptedMutations: string[] = [];
  for (const { label, id, budget } of invalidBudgets) {
    const candidate = structuredClone(artifact) as unknown as {
      workloads: { id: string; nodeReferenceBudget: MutableNodeReferenceBudget }[];
    };
    const workload = candidate.workloads.find((entry) => entry.id === id);
    assert.ok(workload, id);
    workload.nodeReferenceBudget = structuredClone(budget);
    if (validate(candidate)) acceptedMutations.push(label);
  }
  assert.deepEqual(acceptedMutations, [], "schema accepted invalid Node reference budgets");
});

test("semantic-vector bytes, checkout policy, and globally expanded IDs are portable", async () => {
  const fixtures = new URL("../fixtures/v1/", import.meta.url);
  const artifactName = "adapter-semantic-vectors.json";
  const schemaName = "adapter-semantic-vectors.schema.json";
  const artifactBytes = await readFile(new URL(artifactName, fixtures));
  const artifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes)) as {
    sourceFixtures: { id: string; file: string }[];
    documentVectors: { id: string }[];
    presetSuites: { id: string; cases: { id: string }[] }[];
    workloads: { id: string }[];
  };

  assert.ok(artifactBytes.byteLength < 256 * 1024);
  assert.equal(artifactBytes.every((byte) => byte <= 0x7f), true);
  const boundNames = [artifactName, schemaName, ...artifact.sourceFixtures.map(({ file }) => file)];
  for (const name of boundNames) {
    assert.match(name, /^(?!.*(?:\.\.|[\\/?:#]))[A-Za-z0-9][A-Za-z0-9._-]*\.json$/);
    const bytes = await readFile(new URL(name, fixtures));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], name);
    assert.equal(bytes.includes(0x0d), false, name);
    assert.equal(bytes.at(-1), 0x0a, name);
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes), name);
  }

  const ids = [
    ...artifact.documentVectors.map(({ id }) => id),
    ...artifact.presetSuites.flatMap((suite) => suite.cases.map((presetCase) =>
      `${suite.id}.${presetCase.id}`
    )),
    ...artifact.workloads.map(({ id }) => id),
  ];
  assert.equal(new Set(ids).size, 117);

  const fixturePaths = (await readdir(fixtures))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `packages/protocol/fixtures/v1/${name}`);
  const { stdout } = await execFileAsync("git", [
    "check-attr", "text", "eol", "--", ...fixturePaths,
  ], { cwd: new URL("../../../", import.meta.url) });
  const attributes = new Map<string, Record<string, string>>();
  for (const line of stdout.trim().split("\n")) {
    const [file, attribute, value] = line.split(": ");
    assert.ok(file && attribute && value);
    attributes.set(file, { ...attributes.get(file), [attribute]: value });
  }
  for (const value of attributes.values()) {
    assert.deepEqual(value, { text: "set", eol: "lf" });
  }
  assert.equal(attributes.size, fixturePaths.length);
});

test("all 56 document vectors preserve independent preconditions and revision relationships", async () => {
  const loaded = await loadSemanticVectors();
  const validators = await endpointValidators();

  for (const vector of loaded.artifact.documentVectors) {
    const materialized = materializeDocumentVector(loaded, vector);
    if (materialized.predicate === "manifest") {
      const document = materialized.document as unknown as AdapterManifest;
      const validEnvelope = validators.manifest(document);
      assert.equal(validEnvelope, vector.precondition === "envelope-valid", vector.id);
      const actualRevision = computeRevision(document as unknown as JsonObject, "manifestRevision");
      const expectedMatch = vector.document.revision.expect === "match";
      assert.equal(actualRevision === document.manifestRevision, expectedMatch, vector.id);
    } else if (materialized.predicate === "operation") {
      const document = materialized.document as unknown as OperationDefinition;
      assert.equal(validators.operation(document), true, vector.id);
      const actualRevision = computeRevision(document as unknown as JsonObject);
      const expectedMatch = vector.document.revision.expect === "match";
      assert.equal(actualRevision === document.revision, expectedMatch, vector.id);
    } else {
      const request = materialized.request as unknown as DataSourceResolveRequest;
      const response = materialized.response as unknown as DataSourceResolveResponse;
      assert.equal(validators.resolveRequest(request), true, vector.id);
      assert.equal(validators.resolveResponse(response), true, vector.id);
    }
  }
});

test("all 54 ordinary preset cases preserve checked revisions and operation envelopes", async () => {
  const loaded = await loadSemanticVectors();
  const { operation: validateOperation } = await endpointValidators();

  for (const suite of loaded.artifact.presetSuites) {
    for (const presetCase of suite.cases) {
      const id = expandedPresetCaseId(suite, presetCase);
      const operation = materializePresetCase(loaded, suite, presetCase) as unknown as OperationDefinition;
      assert.equal(computeRevision(operation as unknown as JsonObject), presetCase.expectedRevision, id);
      assert.equal(validateOperation(operation), true, id);
    }
  }
});

test("the clean pack/install gate rejects incomplete artifacts and resolves both exports", async () => {
  const missingCompanion = String.raw`
set -eu
set -o pipefail
SEMANTIC_PROBE_ROOT=$(mktemp -d)
trap 'rm -rf -- "$SEMANTIC_PROBE_ROOT"' EXIT
printf '%s\n' "$SEMANTIC_PROBE_ROOT"
mkdir -p "$SEMANTIC_PROBE_ROOT/stage/package/fixtures/v1" "$SEMANTIC_PROBE_ROOT/tarball"
cp packages/protocol/fixtures/v1/adapter-semantic-vectors.json "$SEMANTIC_PROBE_ROOT/stage/package/fixtures/v1/"
tar -czf "$SEMANTIC_PROBE_ROOT/tarball/probe.tgz" -C "$SEMANTIC_PROBE_ROOT/stage" package/fixtures/v1/adapter-semantic-vectors.json
SEMANTIC_TGZ_COUNT=$(find "$SEMANTIC_PROBE_ROOT/tarball" -maxdepth 1 -type f -name '*.tgz' -print | awk 'END { print NR }')
test "$SEMANTIC_TGZ_COUNT" -eq 1
SEMANTIC_TGZ=$(find "$SEMANTIC_PROBE_ROOT/tarball" -maxdepth 1 -type f -name '*.tgz' -print)
diff -u \
  <(printf '%s\n' 'package/fixtures/v1/adapter-semantic-vectors.json' 'package/fixtures/v1/adapter-semantic-vectors.schema.json' | LC_ALL=C sort) \
  <(tar -tf "$SEMANTIC_TGZ" | grep -E '^package/fixtures/v1/adapter-semantic-vectors(\.schema)?\.json$' | LC_ALL=C sort)
`;
  assert.notEqual(await runBashProbe(missingCompanion), 0);

  const duplicateEntry = String.raw`
set -eu
set -o pipefail
SEMANTIC_PROBE_ROOT=$(mktemp -d)
trap 'rm -rf -- "$SEMANTIC_PROBE_ROOT"' EXIT
printf '%s\n' "$SEMANTIC_PROBE_ROOT"
mkdir -p "$SEMANTIC_PROBE_ROOT/stage/package/fixtures/v1" "$SEMANTIC_PROBE_ROOT/tarball"
cp packages/protocol/fixtures/v1/adapter-semantic-vectors.json packages/protocol/fixtures/v1/adapter-semantic-vectors.schema.json "$SEMANTIC_PROBE_ROOT/stage/package/fixtures/v1/"
tar -czf "$SEMANTIC_PROBE_ROOT/tarball/probe.tgz" -C "$SEMANTIC_PROBE_ROOT/stage" \
  package/fixtures/v1/adapter-semantic-vectors.json \
  package/fixtures/v1/adapter-semantic-vectors.json \
  package/fixtures/v1/adapter-semantic-vectors.schema.json
SEMANTIC_TGZ_COUNT=$(find "$SEMANTIC_PROBE_ROOT/tarball" -maxdepth 1 -type f -name '*.tgz' -print | awk 'END { print NR }')
test "$SEMANTIC_TGZ_COUNT" -eq 1
SEMANTIC_TGZ=$(find "$SEMANTIC_PROBE_ROOT/tarball" -maxdepth 1 -type f -name '*.tgz' -print)
diff -u \
  <(printf '%s\n' 'package/fixtures/v1/adapter-semantic-vectors.json' 'package/fixtures/v1/adapter-semantic-vectors.schema.json' | LC_ALL=C sort) \
  <(tar -tf "$SEMANTIC_TGZ" | grep -E '^package/fixtures/v1/adapter-semantic-vectors(\.schema)?\.json$' | LC_ALL=C sort)
`;
  assert.notEqual(await runBashProbe(duplicateEntry), 0);

  const forbiddenWide = String.raw`
set -eu
set -o pipefail
SEMANTIC_PROBE_ROOT=$(mktemp -d)
trap 'rm -rf -- "$SEMANTIC_PROBE_ROOT"' EXIT
printf '%s\n' "$SEMANTIC_PROBE_ROOT"
mkdir -p "$SEMANTIC_PROBE_ROOT/stage/package/fixtures/v1" "$SEMANTIC_PROBE_ROOT/tarball"
cp packages/protocol/fixtures/v1/adapter-semantic-vectors.json packages/protocol/fixtures/v1/adapter-semantic-vectors.schema.json "$SEMANTIC_PROBE_ROOT/stage/package/fixtures/v1/"
touch "$SEMANTIC_PROBE_ROOT/stage/package/fixtures/v1/wide-probe.json"
tar -czf "$SEMANTIC_PROBE_ROOT/tarball/probe.tgz" -C "$SEMANTIC_PROBE_ROOT/stage" \
  package/fixtures/v1/adapter-semantic-vectors.json \
  package/fixtures/v1/adapter-semantic-vectors.schema.json
SEMANTIC_TGZ_COUNT=$(find "$SEMANTIC_PROBE_ROOT/tarball" -maxdepth 1 -type f -name '*.tgz' -print | awk 'END { print NR }')
test "$SEMANTIC_TGZ_COUNT" -eq 1
SEMANTIC_TGZ=$(find "$SEMANTIC_PROBE_ROOT/tarball" -maxdepth 1 -type f -name '*.tgz' -print)
diff -u \
  <(printf '%s\n' 'package/fixtures/v1/adapter-semantic-vectors.json' 'package/fixtures/v1/adapter-semantic-vectors.schema.json' | LC_ALL=C sort) \
  <(tar -tf "$SEMANTIC_TGZ" | grep -E '^package/fixtures/v1/adapter-semantic-vectors(\.schema)?\.json$' | LC_ALL=C sort)
node --input-type=module -e '
  import { readdirSync, statSync } from "node:fs";
  import { join } from "node:path";
  const directory = process.argv[1];
  const forbidden = readdirSync(directory).filter((name) =>
    name.endsWith(".json") && (name.includes("wide") || statSync(join(directory, name)).size > 262144));
  if (forbidden.length !== 0) process.exit(1);
' "$SEMANTIC_PROBE_ROOT/stage/package/fixtures/v1"
`;
  assert.notEqual(await runBashProbe(forbiddenWide), 0);

  const happyPath = String.raw`
set -eu
set -o pipefail
SEMANTIC_PROBE_ROOT=$(mktemp -d)
trap 'rm -rf -- "$SEMANTIC_PROBE_ROOT"' EXIT
printf '%s\n' "$SEMANTIC_PROBE_ROOT"
SEMANTIC_TARBALL_DIR="$SEMANTIC_PROBE_ROOT/tarball"
SEMANTIC_CONSUMER_DIR="$SEMANTIC_PROBE_ROOT/consumer"
mkdir -p "$SEMANTIC_TARBALL_DIR" "$SEMANTIC_CONSUMER_DIR"
node --input-type=module -e '
  import { rmSync } from "node:fs";
  rmSync("packages/protocol/dist", { recursive: true, force: true });
'
pnpm --filter @8lines/gauntlet-protocol build
pnpm --filter @8lines/gauntlet-protocol pack --pack-destination "$SEMANTIC_TARBALL_DIR"
SEMANTIC_TGZ_COUNT=$(find "$SEMANTIC_TARBALL_DIR" -maxdepth 1 -type f -name '*.tgz' -print | awk 'END { print NR }')
test "$SEMANTIC_TGZ_COUNT" -eq 1
SEMANTIC_TGZ=$(find "$SEMANTIC_TARBALL_DIR" -maxdepth 1 -type f -name '*.tgz' -print)
diff -u \
  <(printf '%s\n' 'package/fixtures/v1/adapter-semantic-vectors.json' 'package/fixtures/v1/adapter-semantic-vectors.schema.json' | LC_ALL=C sort) \
  <(tar -tf "$SEMANTIC_TGZ" | grep -E '^package/fixtures/v1/adapter-semantic-vectors(\.schema)?\.json$' | LC_ALL=C sort)
node --input-type=module -e '
  import { readdirSync, statSync } from "node:fs";
  import { join } from "node:path";
  const directory = "packages/protocol/fixtures/v1";
  const forbidden = readdirSync(directory).filter((name) =>
    name.endsWith(".json") && (name.includes("wide") || statSync(join(directory, name)).size > 262144));
  if (forbidden.length !== 0) process.exit(1);
'
(
  cd "$SEMANTIC_CONSUMER_DIR"
  npm install --package-lock=false --ignore-scripts --no-audit --no-fund --no-save --workspaces=false "$SEMANTIC_TGZ"
  test ! -L node_modules/@8lines/gauntlet-protocol
  test ! -e package-lock.json
  test ! -e pnpm-lock.yaml
  node --input-type=module -e '
    import { readFile, realpath } from "node:fs/promises";
    import { isAbsolute, relative } from "node:path";
    import { fileURLToPath } from "node:url";
    const packageRoot = await realpath("node_modules/@8lines/gauntlet-protocol");
    const expected = new Map([
      ["@8lines/gauntlet-protocol/fixtures/v1/adapter-semantic-vectors.json", "fixtures/v1/adapter-semantic-vectors.json"],
      ["@8lines/gauntlet-protocol/fixtures/v1/adapter-semantic-vectors.schema.json", "fixtures/v1/adapter-semantic-vectors.schema.json"],
    ]);
    for (const [specifier, expectedPath] of expected) {
      const resolvedPath = await realpath(fileURLToPath(import.meta.resolve(specifier)));
      const installedPath = relative(packageRoot, resolvedPath);
      if (isAbsolute(installedPath) || installedPath.startsWith("..") || installedPath !== expectedPath) process.exit(1);
      JSON.parse(await readFile(resolvedPath, "utf8"));
    }
  '
)
`;
  assert.equal(await runBashProbe(happyPath), 0);
});
