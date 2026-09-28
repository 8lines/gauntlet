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
      sha256: "sha256:1bca35d1dcd17847fd5e97a74e6803adbc7dad62a5ea2681f65ffcaca56d0fb5",
      revisionField: "manifestRevision",
    },
    {
      id: "operation",
      file: "operation.valid.json",
      sha256: "sha256:8e0d52a085c4d5b2392ae03269a74f267806914648f735d34be89e20046e8cf0",
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
      "manifest.environment.production-name": "sha256:0a7c63eb0f7401834b349fb9063087e372b681e1c5f735baa3d2c731e960a575",
      "manifest.feature.duplicate-id": "sha256:95ffd2eea592347adb49a319e52d00385a681bd63e7144905debb60e06dcec80",
      "manifest.feature.missing-parent": "sha256:552d9c85d660d38ca8562aaa6cc178b92bb800d779a739a3e0eeaf6845b8af5d",
      "manifest.feature.cycle": "sha256:7fd8a0523415c8c019a686a929703b6949f911f8c60dbde887947b351e410786",
      "manifest.operation.duplicate-id": "sha256:7f2e81f3416b4c6002fa782c19b0cf7d42ac6a61e7c6402117714a4adfe79f4b",
      "manifest.data-source.duplicate-id": "sha256:18e60b2391a0386010876a9e3ae52886d7beaacb9751a33872db48d19ffdc6b2",
      "manifest.unavailable.missing-profile": "sha256:c99b6e365c6753251aad93461dfb55b2b0620c20eee38688bfe387716d9c7d3a",
      "manifest.unavailable.missing-capability": "sha256:b090620310525819f3950d5289775ac2d03b1ee3f815f892bdd0c914a31d5a47",
      "manifest.unavailable.missing-mixed": "sha256:5b90232addf85bb7734aa678d3e78e764982b4cd749bf0d187bc1f88c84909e8",
      "manifest.available.missing-profile": "sha256:4c029f4d0ca6ed83603ce82d1f310a615bfc01f668ed4220f7b639ec9d3a3a17",
      "manifest.available.missing-capability": "sha256:5c289ffa6123cc648792f731b086e58d9c419ef28e0276eb6693d9b9561c0b22",
      "manifest.available.missing-mixed": "sha256:302170623f9ad09186eb36e69447d0bfd93446ce10a4891303bffdc12a6ebf77",
      "manifest.diagnostic.omitted-operation-id": "sha256:2b70e0c6bd8a66bdaad52e43bd5f97823b856af175fb638123b4d8e042daa6b7",
      "manifest.operation.unknown-feature": "sha256:ac6397a253d57b56551ee4dd22d19391f50b440ddc7cca6b807347e96d56369f",
      "manifest.data-source.invalid-limits": "sha256:ec6be3a20f3a3b125b27b4c8d6145a1a3cb084e9a3f15ab098a0e3e83237df29",
      "manifest.data-source.remote-dependency-schema": "sha256:9d46087c9ed39e02905ba972c339caaf19b242b95fc0e19f4492bfd49c62cdf1",
      "manifest.data-source.non-object-context-schema": "sha256:20b5a36923330b2f49a598bb65466e32348e3dc63e95870320b4a1ddec3d77ae",
      "manifest.placements.profile-declared": "sha256:c7759317be7267a20c96105285e2edcd1bdbb1022034e0310b037fa61767b935",
      "manifest.placements.profile-missing": "sha256:daed873fa0916a36aba05c900e41506ff5f787772ef8ad08937261ba26913c8d",
    },
  );
  for (const [id, expectedRevision] of [
    ["operation.destructive.valid", "sha256:3778704efe86593ea446e03cea0b1d1da3537f5d1b9305a77dcb590acef5a6df"],
    ["operation.destructive.missing-confirmation", "sha256:978cff358ea5a0868b3975189f3d34b497b8d5cf6d16e10fb58af3d30c2711d6"],
    ["operation.destructive.optional-idempotency", "sha256:701c7e2036deeee178687969bead02dca1f16f32be87d8f414a028da4bb7e98c"],
    ["operation.preset.secret-populated", "sha256:8c9dd8da528ef91774b23fb6c197a94657d1c33453b7878b2fc25a7b916869f6"],
    ["preset.static-applicator-chain.secret-without-trigger", "sha256:454502e6273f731cde4ffe5732d09684bba3898614f9004bdf8ebf95abf1d21a"],
    ["preset.static-applicator-chain.trigger-only", "sha256:55b5018c21410443714ed346e8ca63d22d1c91205acb6ec59089658f2021ae62"],
    ["preset.static-applicator-chain.later-preset-secret", "sha256:f04c72860ab8f2310f32dd15e89189c5072c99d10fce9996e841754e4a4fdb6b"],
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
      expectedRevision: "sha256:4961e386e3903a17c6d391336d8fd1124cc16b77dda818f03546688b22fbca20",
      canonicalBytes: 15631,
    },
    {
      id: "preset.workload.deep.secret-rule-empty",
      recipe: { kind: "deep-chain", depth: 1500, leaf: "empty", secretPointer: true },
      expected: true,
      expectedRevision: "sha256:5b883890d581ecfa44b19651b724b0b69dd860008fae15471a4fe32c9489311e",
      canonicalBytes: 15699,
    },
    {
      id: "preset.workload.deep.secret-rule-populated",
      recipe: { kind: "deep-chain", depth: 1500, leaf: "secret", secretPointer: true },
      expected: false,
      expectedRevision: "sha256:abbe71354683f67c35f16ab880b711c58a2992423b7cf7dd515658c26a93dcb3",
      canonicalBytes: 15716,
    },
    {
      id: "preset.workload.cartesian.empty",
      recipe: { kind: "rules-presets-cartesian", propertyCount: 225, ruleCopies: 2, presetCount: 225 },
      expected: true,
      expectedRevision: "sha256:ba21b5a901ba1678e30583c5912b4675fe560cbce19ce6d95a05c13cce796156",
      canonicalBytes: 54026,
    },
    {
      id: "preset.workload.dense.empty",
      recipe: { kind: "dense-mutual-reference", graphSize: 120 },
      expected: true,
      expectedRevision: "sha256:5b6b7c8957ec8357ef598d2b1f4ac264279671178ba8388de61e1a626f284724",
      canonicalBytes: 426770,
    },
    {
      id: "preset.workload.wide.no-secret-control",
      recipe: { kind: "wide-array", itemCount: 900000, secretRule: false },
      expected: true,
      expectedRevision: "sha256:24379ec4d68d3ea0e212e3c9d64f0a8ff343392646f67b0532d8cbe4be93cef0",
      canonicalBytes: 3602016,
    },
    {
      id: "preset.workload.wide.secret",
      recipe: { kind: "wide-array", itemCount: 900000, secretRule: true },
      expected: false,
      expectedRevision: "sha256:a2e47aeb49fb9fd8a3c7343bb76341cfc63ba3697f7c71e0b6910fc0fc36d4a2",
      canonicalBytes: 3602113,
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
