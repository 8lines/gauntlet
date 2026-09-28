import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { parse } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const skillRoot = resolve(repositoryRoot, "skills/gauntlet-extension-authoring");
const evaluationRoot = resolve(repositoryRoot, "skill-evals/gauntlet-extension-authoring");

function fenced(source, language) {
  const match = new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```", "u").exec(source);
  assert.ok(match, `missing ${language} reference block`);
  return match[1];
}

test("TypeScript operation reference compiles against the real public source interfaces", () => {
  const source = readFileSync(resolve(skillRoot, "references/typescript.md"), "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "gauntlet-extension-typescript-reference-"));
  try {
    writeFileSync(resolve(scratch, "operation.ts"), `${fenced(source, "ts")}\n`);
    writeFileSync(resolve(scratch, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
        typeRoots: [resolve(repositoryRoot, "node_modules/@types")],
        paths: {
          "@8lines/gauntlet-protocol": [resolve(repositoryRoot, "packages/protocol/src/index.ts")],
          "@8lines/gauntlet-typescript-core": [resolve(repositoryRoot, "packages/typescript/core/src/index.ts")],
        },
      },
      files: ["operation.ts"],
    }, null, 2)}\n`);
    const result = spawnSync(resolve(repositoryRoot, "node_modules/.bin/tsc"), ["--project", "tsconfig.json"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Spring definition resource has a current canonical revision and valid shared semantics", async () => {
  const {
    computeRevision,
    operationSemanticsAreValid,
  } = await tsImport("../../../packages/protocol/src/index.ts", import.meta.url);
  const source = readFileSync(resolve(skillRoot, "references/java-spring.md"), "utf8");
  const definition = JSON.parse(fenced(source, "json"));
  assert.equal(definition.revision, computeRevision(definition));
  assert.equal(operationSemanticsAreValid(definition), true);
});

test("scenario matrix resolves every exact prompt and all scorecard criteria are unique", () => {
  const matrix = parse(readFileSync(resolve(evaluationRoot, "scenarios.yaml"), "utf8"));
  const scorecard = parse(readFileSync(resolve(evaluationRoot, "scorecard.yaml"), "utf8"));
  const scenarios = [...matrix.scenarios, ...matrix.forwardScenarios];
  assert.equal(new Set(scenarios.map(({ id }) => id)).size, scenarios.length);
  for (const scenario of scenarios) {
    assert.equal(scenario.prompt, `prompts/${scenario.id}.md`);
    assert.ok(readFileSync(resolve(evaluationRoot, scenario.prompt), "utf8").length > 100);
  }
  const criteria = [
    ...scorecard.required,
    ...scorecard.forbidden,
    ...scorecard.validScenarioRequired,
    ...scorecard.nextjsRequired,
  ];
  assert.equal(new Set(criteria).size, criteria.length);
  assert.ok(scorecard.validScenarioRequired.includes("idempotency_replay_and_mismatch_safety"));
  assert.equal(criteria.some((criterion) => criterion.includes("conflict")), false);
});

test("forward review-deadline prompt discloses the verifier-bound operation contract", () => {
  const source = readFileSync(
    resolve(evaluationRoot, "prompts/forward-review-deadline.md"),
    "utf8",
  );
  assert.match(source, /operation `reviews\.shift-deadline`/u);
  assert.match(
    source,
    /`application\.authorize\(\{ actorId, targetId, applicationId \}\)` returns `\{ tenantId \}`/u,
  );
  assert.match(
    source,
    /`application\.shiftReviewDeadline\(\{ tenantId, applicationId, effectiveDate \}\)`/u,
  );
  assert.match(source, /returns only `\{ applicationId, effectiveDate \}`/u);
});

test("valid operation prompt discloses the verifier-bound application contract", () => {
  const source = readFileSync(resolve(evaluationRoot, "prompts/valid-operation.md"), "utf8");
  assert.match(source, /definition uses exactly `id`, `featureId`, `inputSchema`, `output`, and `execution`/u);
  assert.match(
    source,
    /execution uses exactly `impact`, `confirmationRequired`, `dryRunSupported`, `idempotency`, and `cancellationSupported`/u,
  );
  assert.match(source, /Completion applies only to this synthetic candidate contract/u);
  assert.match(
    source,
    /`application\.authorize\(\{ actorId, targetId, userId \}\)` returns `\{ tenantId \}`/u,
  );
  assert.match(
    source,
    /`application\.resendWelcomeEmail\(\{ tenantId, userId \}\)` returns `\{ deliveryId, status \}`/u,
  );
});

test("valid data-source prompt discloses the verifier-bound application contract", () => {
  const source = readFileSync(resolve(evaluationRoot, "prompts/valid-data-source.md"), "utf8");
  assert.match(source, /data source `customers`/u);
  assert.match(source, /`definition\.capabilities` uses exactly/u);
  assert.match(source, /definition uses exactly `id`, `label`, `capabilities`, and `contextSchema`/u);
  assert.match(source, /closed portable Draft 2020-12 object schema/u);
  assert.match(source, /do not invent custom query\/output schema members/u);
  for (const field of [
    "search: true",
    'pagination: "cursor"',
    "resolve: true",
    "defaultLimit: 10",
    "maxLimit: 25",
  ]) assert.ok(source.includes(field), `missing data-source capability ${field}`);
  assert.match(source, /`query` receives `\{ search, limit, cursor\?, context \}`/u);
  assert.match(source, /`resolve` receives `\{ values, context \}`/u);
  assert.match(source, /`context\.actor\.id`/u);
  assert.match(source, /`context\.target\.id`/u);
  assert.match(source, /Unicode NFKD/u);
  assert.match(source, /`localeCompare\(\.\.\., "en"\)`/u);
  assert.match(source, /`context\.requestId`/u);
  assert.match(source, /before calling the application facade/u);
  assert.match(source, /Treat rows as untrusted application output/u);
  assert.match(
    source,
    /`application\.authorize\(\{ actorId, targetId \}\)` returns `\{ tenantId \}`/u,
  );
  assert.match(source, /`application\.customers` records/u);
  assert.match(source, /`application\.cursorSecret`/u);
  assert.match(source, /`\{ value, label \}` items/u);
  assert.match(source, /`\{ value, item \}` results/u);
  assert.match(source, /Completion applies only to this synthetic candidate contract/u);
});

test("forward operation prompt discloses the verifier-bound definition shape", () => {
  const source = readFileSync(
    resolve(evaluationRoot, "prompts/forward-review-deadline.md"),
    "utf8",
  );
  assert.match(source, /definition uses exactly `id`, `featureId`, `inputSchema`, `output`, and `execution`/u);
  assert.match(
    source,
    /execution uses exactly `impact`, `confirmationRequired`, `dryRunSupported`, `idempotency`, and `cancellationSupported`/u,
  );
  assert.match(source, /Completion applies only to this synthetic candidate contract/u);
});

test("Symfony context reference bounds both actor and target identifiers", () => {
  const source = readFileSync(resolve(skillRoot, "references/php-symfony.md"), "utf8");
  const block = fenced(source, "php");
  for (const objectName of ["actor", "target"]) {
    const start = block.indexOf(`'${objectName}' => [`);
    assert.notEqual(start, -1, `missing ${objectName} schema`);
    const sibling = objectName === "actor" ? "target" : "locale";
    const end = block.indexOf(`'${sibling}' => [`, start + 1);
    const objectBlock = block.slice(start, end === -1 ? undefined : end);
    assert.match(
      objectBlock,
      /'id' => \['type' => 'string', 'minLength' => 1, 'maxLength' => 128\]/u,
      `${objectName}.id must be bounded`,
    );
  }
});

test("extension guidance consistently describes replay-on-mismatched-input semantics", () => {
  const sources = [
    resolve(skillRoot, "SKILL.md"),
    ...readdirSync(resolve(skillRoot, "references"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => resolve(skillRoot, "references", entry.name)),
    resolve(evaluationRoot, "scorecard.yaml"),
    resolve(evaluationRoot, "prompts/destructive-as-write.md"),
    resolve(evaluationRoot, "prompts/valid-operation.md"),
  ];
  for (const path of sources) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /conflict/iu, path);
  }
  const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
  assert.ok(skill.trim().split(/\s+/u).length <= 500, "SKILL.md must remain at most 500 words");
});
