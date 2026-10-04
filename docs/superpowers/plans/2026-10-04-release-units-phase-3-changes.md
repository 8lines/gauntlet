# Release units, phase 3: change files, release preparation and compatibility

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contributors record releasable changes as `.changes/*.md` files that a required CI job demands for every touched unit; `pnpm release:prepare` turns them into a complete release pull request (versions with cascade, every pin, Composer locks, changelogs, compatibility ledger, re-bound skill receipts, `.release/plan.json`) that needs no hand edits; package and application compatibility is generated into the docs, checked against every plan and stated in every GitHub Release.

**Architecture:** New modules: `scripts/skills/rebind.mjs` (receipt re-binding with a mechanical "only 64-hex hashes changed" guard and a Re-binding log), `scripts/release/pins.mjs` (finds any released coordinate pin that no version slot covers), `scripts/release/changes.mjs` (change-file format, bump and cascade computation, `release:changes --check`), `scripts/release/changelog.mjs` (unit changelog paths, Keep a Changelog sections), `scripts/release/compatibility.mjs` (generated ledger `docs/reference/compatibility.md`, plan rejection, release-note line), `scripts/release/composer-locks.mjs` (Docker `composer:2` re-pin with verification) and `scripts/release/prepare.mjs` (`release:prepare`, all-or-nothing with git restore). Existing modules grow: the `release-model.mjs` slot catalog covers every documented pin (counted slots, a catalog-rendered unit version table, the Symfony example's constraints), `plan.mjs` records consumed change files and rejects incompatible plans, `release-set.mjs` adds the compatibility line to notes, `stage-composer.mjs` admits a package changelog, CI gains a `changes` job and release pull requests rehearse their own plan.

**Tech Stack:** Node.js 24 ESM scripts tested with `node:test`, the `yaml` package, git, GitHub Actions YAML (policy tests parse it), Docker (`composer:2.10.3` pinned image for Composer locks).

**Spec:** `docs/superpowers/specs/2026-10-03-independent-release-units-design.md` (sections Change files, Preparing a release, Compatibility, Skills and evaluations, Documentation, Testing; Release units and Publishing were phases 1-2).

**Roadmap:** phase 1 (merged) unit catalog and per-unit versions; phase 2 (merged) plan-driven publishing; phase 3 (this plan) change files, `release:prepare`, changelogs, compatibility and the documentation rewrite.

## Global Constraints

- Work on a branch from `main` after the phase 2 merge (`a198f58` or later). Commit after every task with the exact message given; every message ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never stage the untracked `design/` or `.playwright-mcp/` directories (always `git add` explicit paths).
- Nothing is published or tagged. The only remote action in this plan is Task 11 Step 7 (throwaway rehearsal branches and draft pull requests, never merged), and it runs only after the controller confirms it.
- Code, comments and file names in English. Node scripts are ESM `.mjs` in the existing `scripts/release` style: frozen data, closed option objects, fixed error messages, no symlink-following reads, one-line JSON CLI output (exit 2 for invalid arguments, 1 for failures).
- Unit ids (catalog order): `gauntlet`, `protocol`, `dashboard-client`, `typescript-core`, `typescript-node`, `next-adapter`, `conformance-runner`, `widget`, `php-core`, `symfony-bundle`, `java-core`, `spring-boot-starter`, `skills`. Dependencies and dependents come from `scripts/release/units.mjs` (`dependsOn`, `dependencyOrder`, `dependentsOf`).
- Change file (spec, verbatim rules): `.changes/<name>.md`, name matching `^[a-z0-9][a-z0-9-]{0,63}\.md$`; YAML front matter between `---` lines with exactly `type` (`added | changed | fixed | removed | security`) and `units` (map of unit id to `patch | minor | major | none`); the body is the changelog sentence, written for users, sentence case, no em dashes. Bumps apply literally under semver; before 1.0 the documented convention is that a breaking change is `minor`. Several change files for one unit resolve to the highest bump. `none` records that a change to owned paths needs no release; it is removed at preparation and never released.
- Cascade: every transitive dependent of a released unit (`dependentsOf`) is released with at least a patch. Each released unit gets one entry `Updated \`<dependency>\` to X.Y.Z.` under `### Changed` for every released direct dependency.
- Plan file `.release/plan.json` keeps the phase 2 canonical form `{ "schemaVersion": 1, "units": [{ "id", "from", "to" }], "order": [ids] }` and gains an optional `"changes": [sorted change file names]` after `order`, present only when non-empty.
- Changelogs follow Keep a Changelog. The root `CHANGELOG.md` is the `gauntlet` changelog, keeps the shared history up to 0.1.8 and links every unit changelog. Every other unit's changelog is `<directory of its version source>/CHANGELOG.md` (`changelogPath` in `scripts/release/changelog.mjs`). Each changelog has an `## Unreleased` heading that stays empty; preparation inserts `## [X.Y.Z] - YYYY-MM-DD` right below it.
- Compatibility: units declare contracts in `units.mjs` `contracts` (`implements: { protocol: 1 }`; the application `supports: { protocol: [1], widgetChannel: [1] }`). `docs/reference/compatibility.md` is generated and records each unit's released version and contracts.
- PHP runs only through Docker with the pinned image `COMPOSER_IMAGE` exported by `scripts/release/test-php-compatibility.mjs` (`composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584`). Never require host PHP or a host JDK.
- Bound skill-evaluation inputs (from `skill-evals/*/external-inputs.json`): `.npmrc`, `LICENSE`, `VERSION`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `examples/symfony/composer.json`, `examples/symfony/composer.lock`, `scripts/release/release-model.mjs`, `scripts/release/stage-composer.mjs`, `scripts/release/units.mjs`, the whole trees `packages/dashboard-client`, `packages/php/core`, `packages/php/symfony-bundle`, `packages/protocol`, `packages/typescript/core`, `packages/typescript/node`, plus any skill text under `skills/`. From Task 1 on, a task that changes any of them runs `pnpm skills:rebind --reason "<the sentence given in that task>"` after its last edit, then `pnpm skills:validate`, and commits `skill-evals/gauntlet-app-integration` and `skill-evals/gauntlet-extension-authoring` in the same commit.
- Environment: pnpm 11.24 on `PATH` (`corepack enable`), `pnpm install --frozen-lockfile --package-import-method=copy` done (re-binding hashes `node_modules/.pnpm` trees), Docker for Composer (Task 8 and the PHP rehearsal). The full `release:dry-run` is slow locally; dry runs of specific plans are rehearsed in CI (Task 10, Task 11).
- Verification commands: `pnpm release:test`, `node --test scripts/docs/test/*.test.mjs`, `node scripts/docs/check-docs.mjs`, `node scripts/release/version.mjs --check`, `pnpm skills:validate`, `pnpm skills:test-install`, `pnpm skills:test-evals` (needs Docker), `pnpm test:helm`, `pnpm check` at the end.

## Review Focus

1. A preparation that fails part-way (Composer without network, a receipt that will not validate) must leave the branch exactly as it was, change files included, instead of a half-rewritten tree. Pinned by Task 9 ("a failure after the first write restores every tracked file and keeps the change files").
2. A maintainer who has not fetched tags, or whose previously prepared plan was never released, would compute versions from a stale base; preparation must refuse before writing and name `git fetch --tags origin`. Pinned by Task 9 ("refuses unsafe starting points and leaves the tree untouched").
3. Several change files for one unit with different bumps, and `none` mixed with real bumps, must resolve to the highest real bump, keep every user-facing sentence, and never release anything on `none` alone. Pinned by Task 4 ("the highest bump wins across change files, none never releases, and none alone releases nothing").
4. A changelog that already has hand-written entries under `## Unreleased`, or a section for the target version, must stop preparation instead of burying or duplicating entries. Pinned by Task 6 ("refuses hand-written Unreleased entries, a missing Unreleased heading and an existing version section").
5. A release pull request must not become a blanket exemption from change files: its plan covers only the planned units, and deleting someone else's change file covers nothing. Pinned by Task 5 ("a release pull request covers only its planned units, and deleting a change file covers nothing").

## File Structure

Create:

- `scripts/skills/rebind.mjs`: re-binds evaluation receipts to current bytes (external inputs, skill, evaluation, transcripts), only hash values change, appends a Re-binding log entry, all-or-nothing. Test `scripts/skills/test/rebind.test.mjs`.
- `scripts/release/test/version-fixture.mjs`: the version fixture shared by `release-model.test.mjs` and `prepare.test.mjs` (moved out of `release-model.test.mjs` and extended with the new slot files).
- `scripts/release/pins.mjs`: lists tracked files and reports every released coordinate pin outside a version slot. Test `scripts/release/test/pins.test.mjs`.
- `scripts/release/changes.mjs`: change-file parsing, `.changes` reading, `nextVersion`, `computeRelease` (bumps and cascade), ownership of paths, coverage evaluation and the `release:changes --check` CLI. Test `scripts/release/test/changes.test.mjs`.
- `scripts/release/changelog.mjs`: `changelogPath`, `changelogSection` (moved from `release-set.mjs`), section rendering and insertion, new unit changelog text. Test `scripts/release/test/changelog.test.mjs`.
- Twelve unit changelogs: `packages/protocol/CHANGELOG.md`, `packages/dashboard-client/CHANGELOG.md`, `packages/typescript/core/CHANGELOG.md`, `packages/typescript/node/CHANGELOG.md`, `packages/typescript/next/CHANGELOG.md`, `conformance/runner/CHANGELOG.md`, `packages/widget/CHANGELOG.md`, `packages/php/core/CHANGELOG.md`, `packages/php/symfony-bundle/CHANGELOG.md`, `packages/java/core/CHANGELOG.md`, `packages/java/spring-boot-starter/CHANGELOG.md`, `skills/CHANGELOG.md`.
- `scripts/release/compatibility.mjs` and the generated `docs/reference/compatibility.md`. Test `scripts/release/test/compatibility.test.mjs`.
- `scripts/release/composer-locks.mjs`: Docker invocation and verification of Composer lock re-pinning. Test `scripts/release/test/composer-locks.test.mjs`.
- `scripts/release/prepare.mjs`: `release:prepare`. Test `scripts/release/test/prepare.test.mjs`.

Modify:

- `scripts/release/release-model.mjs` (slot counts, new slot files, unit version table, constraint consumers, exports), `scripts/release/test/release-model.test.mjs`.
- `scripts/release/plan.mjs` (`changes`, `CHANGE_FILE_NAME`, compatibility in `--check`), `scripts/release/test/plan.test.mjs`.
- `scripts/release/units.mjs` (`skills` owned paths), `scripts/release/test/units.test.mjs`.
- `scripts/release/release-set.mjs` (changelog helpers moved, compatibility line in notes), `scripts/release/test/release-set.test.mjs`.
- `scripts/release/stage-composer.mjs` (optional `CHANGELOG.md`), `scripts/release/test/stage-composer.test.mjs`.
- `scripts/docs/check-docs.mjs` (unbound pins, compatibility ledger), `scripts/docs/test/check-docs.test.mjs`, `scripts/docs/test/release-runbooks.test.mjs`, `scripts/docs/test/policy-docs.test.mjs`.
- `.github/workflows/ci.yml` (`changes` job, release pull request rehearsal), `scripts/release/test/workflow-policy.test.mjs`.
- `package.json` (`skills:rebind`, `release:changes`, `release:prepare`).
- Docs: `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/README.md`, `docs/documentation-manifest.json`, `docs/releases/releasing.md`, `docs/releases/installing-packages.md`, `docs/releases/upgrading.md`, `docs/integrations/index.md`, `conformance/runner/README.md`, `packages/java/README.md`, `packages/java/core/README.md`.
- Re-bound receipts: `skill-evals/gauntlet-app-integration/**` and `skill-evals/gauntlet-extension-authoring/**` (`EVALUATING.md`, `external-inputs.json`, `verification.json`, `results/*.jsonl`).

---

### Task 1: Receipt re-binding command

**Files:**
- Create: `scripts/skills/rebind.mjs`
- Test: `scripts/skills/test/rebind.test.mjs`
- Modify: `package.json` (`scripts`: add `"skills:rebind": "node scripts/skills/rebind.mjs"` after `skills:validate`)
- Re-bind: the new command re-binds both evaluations (`package.json` is bound)

**Interfaces:**
- Consumes: `hashEvaluationInputs(evaluationRoot)` (`scripts/skills/evaluation-content.mjs`), `generateExternalInputsManifest({ root, evaluationRoot, sourceFiles, sourceTrees, linkedRuntimeTrees })` (`scripts/skills/external-inputs.mjs`; it refuses to overwrite an existing manifest, so the old one is removed first and restored on failure), `hashSkill(skillDirectory): Promise<string>` (`scripts/skills/skill-content.mjs`), `validateSkill({ root, name }): Promise<{ errors: string[] }>` (`scripts/skills/validate.mjs`); fixtures `validFixture(name)`, `cleanup(...paths)` from `scripts/skills/test/support.mjs`.
- Produces (exported from `scripts/skills/rebind.mjs`):
  - `REBINDING_LOG_HEADING = "## Re-binding log"`.
  - `assertOnlyHashesChanged(before: string, after: string): void` throws `Re-binding changed more than 64-hex hash values`.
  - `rebindingLogEntry(date: string, reason: string): string` → `- <date>: <reason> Hashes were re-bound to the current bytes without new model samples; this confirms content integrity, not behaviour.`
  - `appendRebindingLog(source: string, entry: string): string` (creates the section at the end, appends, idempotent for the same last entry, throws `The Re-binding log must be the last section of EVALUATING.md`).
  - `parseRebindArguments(argv: string[]): Readonly<{ reason: string; date: string }>` (TypeError with the usage text; `reason` starts with an uppercase letter, ends with a period, has no newline or em dash, at most 600 characters; `date` defaults to today in UTC).
  - `rebindEvaluations({ root: string, reason: string, date: string, names?: string[] }): Promise<Readonly<{ skills: readonly Readonly<{ name: string; changed: readonly string[] }>[] }>>`. `names` defaults to every `skill-evals/<name>` directory holding a `verification.json`, sorted. `changed` lists repository-relative paths, `[]` when every hash was current (then nothing, not even the log, is written). All-or-nothing across names; errors start with `Evaluation receipts could not be re-bound`.
  - CLI `node scripts/skills/rebind.mjs --reason "<Sentence.>" [--date YYYY-MM-DD]` → stdout `{"ok":true,"skills":[{"name":…,"changed":[…]}…]}`; failure → exit 1, stderr `{"error":{"code":"REBIND_FAILED","message":…},"ok":false}`; invalid arguments → exit 2, `INVALID_ARGUMENTS`.

- [ ] **Step 1: Write the failing tests** in `scripts/skills/test/rebind.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  REBINDING_LOG_HEADING, appendRebindingLog, assertOnlyHashesChanged, parseRebindArguments, rebindEvaluations,
  rebindingLogEntry,
} from "../rebind.mjs";
import { validateSkill } from "../validate.mjs";
import { cleanup, validFixture } from "./support.mjs";

const NAME = "safe-integration";
const REASON = "Fixture input changed.";
const DATE = "2026-10-04";
const RECORDS = ["verification.json", "external-inputs.json", "results/baseline.jsonl", "results/guided.jsonl", "results/forward.jsonl"];

function evaluationFile(root, path) {
  return join(root, "skill-evals", NAME, path);
}

function snapshot(root) {
  return Object.fromEntries([...RECORDS, "EVALUATING.md"].map((path) => [path, readFileSync(evaluationFile(root, path), "utf8")]));
}

test("only 64-hex hash values may differ", () => {
  const before = `{"a":"${"1".repeat(64)}","b":"keep"}`;
  assertOnlyHashesChanged(before, before.replace("1".repeat(64), "f".repeat(64)));
  for (const after of [before.replace("keep", "kept"), before.replace("1".repeat(64), "1".repeat(63)), `${before}\n`]) {
    assert.throws(() => assertOnlyHashesChanged(before, after), /Re-binding changed more than 64-hex hash values/u);
  }
});

test("the re-binding log is created once, appended to and stays the last section", () => {
  const entry = rebindingLogEntry(DATE, REASON);
  assert.equal(entry, "- 2026-10-04: Fixture input changed. Hashes were re-bound to the current bytes without new model samples; this confirms content integrity, not behaviour.");
  const created = appendRebindingLog("# Protocol\n\nText.\n", entry);
  assert.equal(created, `# Protocol\n\nText.\n\n${REBINDING_LOG_HEADING}\n\n${entry}\n`);
  assert.equal(appendRebindingLog(created, entry), created);
  const second = rebindingLogEntry("2026-10-05", "Another input changed.");
  assert.equal(appendRebindingLog(created, second), `${created}${second}\n`);
  assert.throws(() => appendRebindingLog(`${created}\n## Later\n`, second), /must be the last section/u);
});

test("arguments name one sentence and an optional calendar date", () => {
  assert.deepEqual(parseRebindArguments(["--reason", REASON, "--date", DATE]), { reason: REASON, date: DATE });
  assert.match(parseRebindArguments(["--reason", REASON]).date, /^\d{4}-\d{2}-\d{2}$/u);
  for (const argv of [
    [], ["--reason"], ["--reason", "lower case."], ["--reason", "No period"], ["--reason", "Dash — here."],
    ["--reason", REASON, "--date", "2026-02-30"], ["--reason", REASON, "--date", "2026-13-01"], ["--reason", REASON, "--extra", "x"],
  ]) {
    assert.throws(() => parseRebindArguments(argv), /Usage: rebind\.mjs/u, JSON.stringify(argv));
  }
});

test("re-binding makes a receipt current again and changes only hash values", async (t) => {
  const root = await validFixture(NAME);
  t.after(() => cleanup(root));
  writeFileSync(evaluationFile(root, "EVALUATING.md"), "# Fixture protocol\n", { mode: 0o600 });
  writeFileSync(join(root, "fixtures/evaluation-input.txt"), "changed external input\n");
  assert.notDeepEqual((await validateSkill({ root, name: NAME })).errors, []);
  const before = snapshot(root);

  const result = await rebindEvaluations({ root, reason: REASON, date: DATE, names: [NAME] });

  assert.deepEqual((await validateSkill({ root, name: NAME })).errors, []);
  assert.deepEqual(result.skills.map(({ name }) => name), [NAME]);
  assert.deepEqual([...result.skills[0].changed], [
    "skill-evals/safe-integration/EVALUATING.md",
    "skill-evals/safe-integration/external-inputs.json",
    "skill-evals/safe-integration/results/baseline.jsonl",
    "skill-evals/safe-integration/results/forward.jsonl",
    "skill-evals/safe-integration/results/guided.jsonl",
    "skill-evals/safe-integration/verification.json",
  ]);
  const after = snapshot(root);
  for (const path of RECORDS) assertOnlyHashesChanged(before[path], after[path]);
  assert.equal(after["EVALUATING.md"], `# Fixture protocol\n\n${REBINDING_LOG_HEADING}\n\n${rebindingLogEntry(DATE, REASON)}\n`);
});

test("re-binding current receipts changes nothing and adds no log entry", async (t) => {
  const root = await validFixture(NAME);
  t.after(() => cleanup(root));
  writeFileSync(evaluationFile(root, "EVALUATING.md"), "# Fixture protocol\n", { mode: 0o600 });
  await rebindEvaluations({ root, reason: REASON, date: DATE, names: [NAME] });
  const before = snapshot(root);
  const again = await rebindEvaluations({ root, reason: "Nothing changed.", date: DATE, names: [NAME] });
  assert.deepEqual(again.skills, [{ name: NAME, changed: [] }]);
  assert.deepEqual(snapshot(root), before);
});

test("a re-binding that cannot make the receipt valid restores every file", async (t) => {
  const root = await validFixture(NAME);
  t.after(() => cleanup(root));
  writeFileSync(evaluationFile(root, "EVALUATING.md"), "# Fixture protocol\n", { mode: 0o600 });
  // A changed prompt is re-bound like any input, but the recorded prompts no longer match it.
  writeFileSync(evaluationFile(root, "prompts/forward-scenario.md"), "a different prompt\n");
  const before = snapshot(root);
  await assert.rejects(
    rebindEvaluations({ root, reason: REASON, date: DATE, names: [NAME] }),
    /Evaluation receipts could not be re-bound/u,
  );
  assert.deepEqual(snapshot(root), before);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/skills/test/rebind.test.mjs`
Expected: FAIL with `Cannot find module` for `../rebind.mjs`.

- [ ] **Step 3: Implement `scripts/skills/rebind.mjs`**

```js
#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { hashEvaluationInputs } from "./evaluation-content.mjs";
import { generateExternalInputsManifest } from "./external-inputs.mjs";
import { hashSkill } from "./skill-content.mjs";
import { validateSkill } from "./validate.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
export const REBINDING_LOG_HEADING = "## Re-binding log";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REASON = /^[A-Z][^\n—]{0,598}\.$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const PHASES = Object.freeze(["baseline", "guided", "forward"]);
const FAILURE = "Evaluation receipts could not be re-bound";
const USAGE = 'Usage: rebind.mjs --reason "<Sentence ending with a period.>" [--date YYYY-MM-DD]';

export function assertOnlyHashesChanged(before, after) {
  const frame = (text) => ({ rest: text.split(/[0-9a-f]{64}/u), count: text.match(/[0-9a-f]{64}/gu)?.length ?? 0 });
  const left = frame(before);
  const right = frame(after);
  if (left.count !== right.count || left.rest.length !== right.rest.length
      || left.rest.some((part, index) => part !== right.rest[index])) {
    throw new Error("Re-binding changed more than 64-hex hash values");
  }
}

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validReason(value) {
  return typeof value === "string" && REASON.test(value);
}

export function rebindingLogEntry(date, reason) {
  if (!validDate(date) || !validReason(reason)) throw new TypeError(USAGE);
  return `- ${date}: ${reason} Hashes were re-bound to the current bytes without new model samples; this confirms content integrity, not behaviour.`;
}

export function appendRebindingLog(source, entry) {
  const headings = source.split("\n").filter((line) => line.startsWith("## "));
  const position = headings.indexOf(REBINDING_LOG_HEADING);
  if (position >= 0 && position !== headings.length - 1) {
    throw new Error("The Re-binding log must be the last section of EVALUATING.md");
  }
  const body = source.replace(/\n+$/u, "");
  if (position < 0) return `${body}\n\n${REBINDING_LOG_HEADING}\n\n${entry}\n`;
  if (body.split("\n").at(-1) === entry) return source;
  return `${body}\n${entry}\n`;
}

export function parseRebindArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0 || argv.some((value) => typeof value !== "string")) {
    throw new TypeError(USAGE);
  }
  let reason;
  let date;
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === "--reason" && reason === undefined && validReason(value)) reason = value;
    else if (flag === "--date" && date === undefined && validDate(value)) date = value;
    else throw new TypeError(USAGE);
  }
  if (reason === undefined) throw new TypeError(USAGE);
  return Object.freeze({ reason, date: date ?? new Date().toISOString().slice(0, 10) });
}

function writeAtomically(path, text, mode) {
  const scratch = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(scratch, text, { flag: "wx", mode });
  try {
    renameSync(scratch, path);
  } catch (error) {
    unlinkSync(scratch);
    throw error;
  }
}

function replaceOnce(text, from, to) {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`${FAILURE}: ${from.split(":")[0]} does not occur exactly once`);
  return parts.join(to);
}

function evaluationNames(root) {
  return readdirSync(resolve(root, "skill-evals"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && NAME.test(entry.name))
    .map(({ name }) => name)
    .filter((name) => {
      try {
        return lstatSync(resolve(root, "skill-evals", name, "verification.json")).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

async function rebindOne(root, name, reason, date, journal) {
  const evaluationRoot = resolve(root, "skill-evals", name);
  const track = (path) => {
    if (!journal.has(path)) journal.set(path, { bytes: readFileSync(path), mode: lstatSync(path).mode & 0o777 });
    return journal.get(path);
  };
  const receiptPath = join(evaluationRoot, "verification.json");
  const externalPath = join(evaluationRoot, "external-inputs.json");
  const logPath = join(evaluationRoot, "EVALUATING.md");
  const receiptSource = readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(receiptSource);

  const external = track(externalPath);
  const manifest = JSON.parse(external.bytes.toString("utf8"));
  unlinkSync(externalPath);
  const externalInputsSha256 = generateExternalInputsManifest({
    root,
    evaluationRoot,
    sourceFiles: manifest.sourceFiles.map(({ path }) => path),
    sourceTrees: manifest.sourceTrees.map(({ path, excludedTopLevel }) => ({ path, excludedTopLevel })),
    linkedRuntimeTrees: manifest.linkedRuntimeTrees.map(({ path }) => path),
  });
  chmodSync(externalPath, external.mode);
  assertOnlyHashesChanged(external.bytes.toString("utf8"), readFileSync(externalPath, "utf8"));
  const skillSha256 = await hashSkill(resolve(root, "skills", name));
  let evaluationSha256 = hashEvaluationInputs(evaluationRoot);

  const changed = [];
  if (externalInputsSha256 !== receipt.externalInputsSha256 || skillSha256 !== receipt.skillSha256
      || evaluationSha256 !== receipt.evaluationSha256) {
    const log = track(logPath);
    const logSource = log.bytes.toString("utf8");
    const nextLog = appendRebindingLog(logSource, rebindingLogEntry(date, reason));
    if (!nextLog.startsWith(logSource.replace(/\n+$/u, ""))) throw new Error(`${FAILURE}: EVALUATING.md changed above its log`);
    writeAtomically(logPath, nextLog, log.mode);
    evaluationSha256 = hashEvaluationInputs(evaluationRoot);

    const fields = [
      ["evaluationSha256", receipt.evaluationSha256, evaluationSha256],
      ["externalInputsSha256", receipt.externalInputsSha256, externalInputsSha256],
      ["skillSha256", receipt.skillSha256, skillSha256],
    ];
    let nextReceipt = receiptSource;
    for (const [key, from, to] of fields) nextReceipt = replaceOnce(nextReceipt, `"${key}": "${from}"`, `"${key}": "${to}"`);
    for (const phase of PHASES) {
      const path = resolve(evaluationRoot, ...receipt[phase].transcript.split("/"));
      if (!path.startsWith(`${evaluationRoot}${sep}`)) throw new Error(`${FAILURE}: ${phase} transcript escapes the evaluation`);
      const transcript = track(path);
      const before = transcript.bytes.toString("utf8");
      // Baseline records carry "skillSha256":null and are never bound to a skill hash.
      const recordFields = fields.filter(([key]) => !(key === "skillSha256" && phase === "baseline"));
      const after = before.split("\n").map((line) => (line === ""
        ? line
        : recordFields.reduce((text, [key, from, to]) => replaceOnce(text, `"${key}":"${from}"`, `"${key}":"${to}"`), line)))
        .join("\n");
      assertOnlyHashesChanged(before, after);
      writeAtomically(path, after, transcript.mode);
      nextReceipt = replaceOnce(
        nextReceipt,
        `"transcriptSha256": "${receipt[phase].transcriptSha256}"`,
        `"transcriptSha256": "${createHash("sha256").update(after, "utf8").digest("hex")}"`,
      );
      changed.push(path);
    }
    assertOnlyHashesChanged(receiptSource, nextReceipt);
    writeAtomically(receiptPath, nextReceipt, track(receiptPath).mode);
    changed.push(logPath, externalPath, receiptPath);
  }

  const { errors } = await validateSkill({ root, name });
  if (errors.length > 0) throw new Error(`${FAILURE}: ${name}: ${errors.join("; ")}`);
  return Object.freeze({
    name,
    changed: Object.freeze(changed.map((path) => relative(root, path).split(sep).join("/")).sort()),
  });
}

export async function rebindEvaluations({ root, reason, date, names } = {}) {
  if (typeof root !== "string" || resolve(root) !== root) throw new TypeError(USAGE);
  rebindingLogEntry(date, reason);
  const selected = names ?? evaluationNames(root);
  if (!Array.isArray(selected) || selected.length === 0 || selected.some((name) => typeof name !== "string" || !NAME.test(name))) {
    throw new TypeError(USAGE);
  }
  const journal = new Map();
  try {
    const skills = [];
    for (const name of selected) skills.push(await rebindOne(root, name, reason, date, journal));
    return Object.freeze({ skills: Object.freeze(skills) });
  } catch (error) {
    for (const [path, { bytes, mode }] of journal) {
      try {
        unlinkSync(path);
      } catch {
        // The external-input manifest is absent when its regeneration failed.
      }
      writeFileSync(path, bytes, { flag: "wx", mode });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith(FAILURE) ? message : `${FAILURE}: ${message}`);
  }
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export async function runRebindCli(argv, { root = ROOT } = {}) {
  let options;
  try {
    options = parseRebindArguments(argv);
  } catch {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const { skills } = await rebindEvaluations({ root, ...options });
    return { exitCode: 0, stdout: jsonLine({ ok: true, skills }), stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "REBIND_FAILED", message: error instanceof Error ? error.message : FAILURE }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRebindCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
```

Add to `package.json` `scripts`, right after `"skills:validate"`: `"skills:rebind": "node scripts/skills/rebind.mjs",`.

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/skills/test/rebind.test.mjs && pnpm skills:test-install`
Expected: PASS.

- [ ] **Step 5: Re-bind the repository's receipts with the new command** (`package.json` changed):

Run: `pnpm skills:rebind --reason "Added the skills:rebind workspace script." && pnpm skills:validate && git diff --stat -- skill-evals`
Expected: one JSON line with `"ok":true` and, for each of `gauntlet-app-integration` and `gauntlet-extension-authoring`, six changed paths (`EVALUATING.md`, `external-inputs.json`, three transcripts, `verification.json`); `skills:validate` prints `"ok":true`; the diff touches exactly those 12 files, and each `EVALUATING.md` ends with a `## Re-binding log` section holding one entry.

- [ ] **Step 6: Commit**

```bash
git add scripts/skills/rebind.mjs scripts/skills/test/rebind.test.mjs package.json skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring
git commit -m "feat(skills): re-bind evaluation receipts with skills:rebind and a Re-binding log

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Every documented pin is a release version slot

**Files:**
- Modify: `scripts/release/release-model.mjs` (`RELEASE_CONSUMER_JSON_FILES` ~388-403, `pushConsumerJsonChecks` ~405-422, `RELEASE_TEXT_FILES` ~424-489, `releaseTextSpans` ~491-520, `VERSION_LOCATIONS` ~717-747, `prepareReleaseUpdate` consumer mapping ~950-955; new exports)
- Create: `scripts/release/test/version-fixture.mjs` (helpers moved from `release-model.test.mjs` lines 86-278)
- Modify: `scripts/release/test/release-model.test.mjs`
- Modify docs: `docs/releases/installing-packages.md`, `docs/integrations/index.md`, `conformance/runner/README.md`, `packages/java/README.md`, `packages/java/core/README.md`
- Re-bind: `release-model.mjs` is bound

**Interfaces:**
- Consumes: `RELEASE_UNITS` (`units.mjs`); `setUnitVersions`, `collectUnitVersionMismatches`, `readUnitVersions` (phase 2).
- Produces (exported from `release-model.mjs`):
  - Slots accept an optional `count` (default 1): the prefix must occur exactly `count` times, each occurrence followed by a stable version and the suffix.
  - `RELEASE_TEXT_FILES` (frozen `[{ path, slots: [{ unit, prefix, suffix, count? }] }]`) is exported.
  - `readReleaseTextSpans(root: string, path: string): readonly Readonly<{ start: number; end: number; value: string; unit: string }>[]` (throws for a path outside `RELEASE_TEXT_FILES` or a malformed file).
  - `unitVersionTableRowPrefix(unit): string` → ``| `<id>` | `<artifact>`, … | ``; `renderUnitVersionTable(versions: ReadonlyMap<string,string>): string` → header `| Unit | Published as | Version |`, `| --- | --- | --- |`, one row per unit in catalog order, trailing LF.
  - `RELEASE_CONSUMER_JSON_FILES` entries may set `constraint: true` per key path (value `^<version>`); `examples/symfony/composer.json` is such a consumer for `php-core` and `symfony-bundle`. Its `VERSION_LOCATIONS` type is `json-constraint`.
  - `scripts/release/test/version-fixture.mjs` exports `PACKAGE_IDENTITIES`, `RELEASE_TEXT_PATHS`, `RELEASE_TEXT_UNITS`, `EXPECTED_UPDATE_PATHS`, `UNIT_VERSION_FILES`, `GRADLE_VERSION_DERIVATION`, `writeFixtureFile`, `releaseTextFixtures`, `writeReleaseTextFixtures`, `writeConsumerJsonFixtures`, `createVersionFixture` (Task 9 consumes `createVersionFixture`).

- [ ] **Step 1: Move the fixture into `scripts/release/test/version-fixture.mjs`.** Move `PACKAGE_IDENTITIES` (lines 86-96), `UNIT_VERSION_FILES` (147-151), `GRADLE_VERSION_DERIVATION` (153-168), `writeFixtureFile` (170-174), `writeReleaseTextFixtures` (217-219) and `createVersionFixture` (235-278) verbatim, each prefixed with `export`, and replace the remaining moved definitions with the extended versions below. In `release-model.test.mjs`, delete the moved definitions (lines 86-278) and add `import { EXPECTED_UPDATE_PATHS, PACKAGE_IDENTITIES, RELEASE_TEXT_PATHS, RELEASE_TEXT_UNITS, UNIT_VERSION_FILES, createVersionFixture, releaseTextFixtures, writeConsumerJsonFixtures, writeFixtureFile, writeReleaseTextFixtures } from "./version-fixture.mjs";` (keep `withVersionFixture`, `fixtureSnapshot`, `findUpdaterScratch`, `testingOptions` in the test file). The head of the new module:

```js
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderUnitVersionTable } from "../release-model.mjs";
import { RELEASE_UNITS } from "../units.mjs";

export const RELEASE_TEXT_PATHS = [
  "tests/consumers/java/build.gradle.kts",
  "tests/consumers/java/gradle.lockfile",
  "skills/gauntlet-app-integration/references/node.md",
  "skills/gauntlet-app-integration/references/nextjs.md",
  "skills/gauntlet-app-integration/references/symfony.md",
  "skills/gauntlet-app-integration/references/spring.md",
  "skills/gauntlet-app-integration/references/deployment.md",
  "skills/gauntlet-app-integration/references/safety-gates.md",
  "docs/ai-skills.md",
  "deploy/helm/README.md",
  "docs/releases/installing-packages.md",
  "docs/integrations/index.md",
  "docs/integrations/widget.md",
  "conformance/runner/README.md",
  "packages/java/README.md",
  "packages/java/core/README.md",
  "packages/java/spring-boot-starter/README.md",
  "packages/php/symfony-bundle/README.md",
  "packages/typescript/core/README.md",
];

// Each release-text file with the units whose slots it holds, in first-appearance order, and the slot count per unit.
export const RELEASE_TEXT_UNITS = [
  ["tests/consumers/java/build.gradle.kts", [["spring-boot-starter", 1]]],
  ["tests/consumers/java/gradle.lockfile", [["java-core", 1], ["spring-boot-starter", 1]]],
  ["skills/gauntlet-app-integration/references/node.md", [["protocol", 1], ["typescript-core", 1], ["typescript-node", 1]]],
  ["skills/gauntlet-app-integration/references/nextjs.md", [["protocol", 1], ["typescript-core", 1], ["next-adapter", 1]]],
  ["skills/gauntlet-app-integration/references/symfony.md", [["php-core", 1], ["symfony-bundle", 1]]],
  ["skills/gauntlet-app-integration/references/spring.md", [["spring-boot-starter", 3]]],
  ["skills/gauntlet-app-integration/references/deployment.md", [["gauntlet", 3]]],
  ["skills/gauntlet-app-integration/references/safety-gates.md", [["gauntlet", 1]]],
  ["docs/ai-skills.md", [["skills", 3]]],
  ["deploy/helm/README.md", [["gauntlet", 9]]],
  ["docs/releases/installing-packages.md", [
    ["protocol", 2], ["typescript-core", 2], ["typescript-node", 2], ["symfony-bundle", 2], ["php-core", 2],
    ["java-core", 2], ["spring-boot-starter", 2], ["gauntlet", 4], ["dashboard-client", 1], ["next-adapter", 1],
    ["conformance-runner", 1], ["widget", 1], ["skills", 1],
  ]],
  ["docs/integrations/index.md", [
    ["typescript-core", 2], ["typescript-node", 1], ["next-adapter", 1], ["php-core", 1], ["symfony-bundle", 1],
    ["java-core", 1], ["spring-boot-starter", 1],
  ]],
  ["docs/integrations/widget.md", [["widget", 1]]],
  ["conformance/runner/README.md", [["conformance-runner", 3]]],
  ["packages/java/README.md", [["java-core", 1], ["spring-boot-starter", 2]]],
  ["packages/java/core/README.md", [["java-core", 2]]],
  ["packages/java/spring-boot-starter/README.md", [["spring-boot-starter", 2]]],
  ["packages/php/symfony-bundle/README.md", [["php-core", 1], ["symfony-bundle", 1]]],
  ["packages/typescript/core/README.md", [["protocol", 3], ["typescript-core", 2]]],
];

export const EXPECTED_UPDATE_PATHS = [
  "packages/protocol/package.json",
  "packages/dashboard-client/package.json",
  "packages/typescript/core/package.json",
  "packages/typescript/node/package.json",
  "packages/typescript/next/package.json",
  "conformance/runner/package.json",
  "packages/widget/package.json",
  "apps/dashboard/package.json",
  "apps/server/package.json",
  "packages/php/core/composer.json",
  "packages/php/symfony-bundle/composer.json",
  "deploy/helm/gauntlet/Chart.yaml",
  "deploy/helm/gauntlet/values.yaml",
  "deploy/compose/.env.example",
  "tests/consumers/php-core/composer.json",
  "tests/consumers/php-symfony/composer.json",
  "examples/symfony/composer.json",
  ...RELEASE_TEXT_PATHS,
  "packages/java/core/VERSION",
  "packages/java/spring-boot-starter/VERSION",
  "skills/VERSION",
  "VERSION",
];
```

`releaseTextFixtures(version)` keeps its nine existing entries verbatim and appends, in this order:

```js
    [
      "deploy/helm/README.md",
      `The example uses the exact \`${version}\` application tag: stable tags are versioned.\n\n`
        + `image:\n  repository: ghcr.io/8lines/gauntlet\n  tag: "${version}"\n\n`
        + `Pull the exact \`${version}\` chart to a local immutable input.\n\n`
        + `helm pull oci://ghcr.io/8lines/charts/gauntlet --version ${version} --destination .\n`
        + `helm template gauntlet ./gauntlet-${version}.tgz \\\n  -f values.yaml\n`
        + `helm upgrade --install gauntlet ./gauntlet-${version}.tgz \\\n  -f values.yaml\n`
        + `helm pull oci://ghcr.io/8lines/charts/gauntlet --version ${version} --destination .\n`
        + `helm template gauntlet ./gauntlet-${version}.tgz \\\n  -f values.yaml\n`
        + `helm upgrade gauntlet ./gauntlet-${version}.tgz \\\n  -f values.yaml\n`,
    ],
    [
      "docs/releases/installing-packages.md",
      `${renderUnitVersionTable(new Map(RELEASE_UNITS.map(({ id }) => [id, version])))}\n`
        + `pnpm add @8lines/gauntlet-protocol@${version} \\\n  @8lines/gauntlet-typescript-core@${version} \\\n  @8lines/gauntlet-typescript-node@${version}\n`
        + `composer require 8lines/gauntlet-symfony-bundle:${version}\n`
        + `For a framework-neutral integration, require \`8lines/gauntlet-php-core:${version}\` alone.\n`
        + `dev.eightlines.gauntlet:core:${version}\ndev.eightlines.gauntlet:spring-boot-starter:${version}\n`
        + `docker pull ghcr.io/8lines/gauntlet:${version}\nhelm pull oci://ghcr.io/8lines/charts/gauntlet --version ${version}\n`
        + `Pull the Helm chart at exact version \`${version}\`, render that local archive, and install the same bytes.\n`,
    ],
    [
      "docs/integrations/index.md",
      `| Native Node.js 24–26 | \`@8lines/gauntlet-typescript-core@${version}\` and \`@8lines/gauntlet-typescript-node@${version}\` | Node |\n`
        + `| Next.js App Router on Node.js 24–26 | \`@8lines/gauntlet-typescript-core@${version}\` and \`@8lines/gauntlet-next-adapter@${version}\` | Next.js |\n`
        + `| PHP 8.3+ | \`8lines/gauntlet-php-core\` at \`${version}\` | PHP |\n`
        + `| Symfony 7.4 | PHP Core and \`8lines/gauntlet-symfony-bundle\` at \`${version}\` | Symfony |\n`
        + `| Java 21 | \`dev.eightlines.gauntlet:core:${version}\` | Java |\n`
        + `| Spring Boot on Java 21 | Core and \`dev.eightlines.gauntlet:spring-boot-starter:${version}\` | Spring |\n`,
    ],
    ["docs/integrations/widget.md", `npm install @8lines/gauntlet-widget@${version}\n`],
    [
      "conformance/runner/README.md",
      ["", "-fixture", "-extended"]
        .map((suffix) => `pnpm dlx --package @8lines/gauntlet-conformance-runner@${version} gauntlet-conformance${suffix} \\\n  --target local\n`)
        .join(""),
    ],
    [
      "packages/java/README.md",
      `- \`dev.eightlines.gauntlet:core:${version}\` — Java 21 protocol models\n`
        + `- \`dev.eightlines.gauntlet:spring-boot-starter:${version}\` — Spring Boot auto-configuration\n`
        + `    implementation("dev.eightlines.gauntlet:spring-boot-starter:${version}")\n`,
    ],
    [
      "packages/java/core/README.md",
      `\`dev.eightlines.gauntlet:core:${version}\` is the framework-neutral Java 21 core.\n`
        + `    implementation("dev.eightlines.gauntlet:core:${version}")\n`,
    ],
    [
      "packages/java/spring-boot-starter/README.md",
      `\`dev.eightlines.gauntlet:spring-boot-starter:${version}\` is the Java 21 and Spring Boot starter.\n`
        + `    implementation("dev.eightlines.gauntlet:spring-boot-starter:${version}")\n`,
    ],
    [
      "packages/php/symfony-bundle/README.md",
      `composer require 8lines/gauntlet-php-core:${version} \\\n  8lines/gauntlet-symfony-bundle:${version}\n`,
    ],
    [
      "packages/typescript/core/README.md",
      `pnpm add @8lines/gauntlet-protocol@${version} \\\n  @8lines/gauntlet-typescript-core@${version}\n`
        + `"@8lines/gauntlet-protocol": "file:/tmp/gauntlet-packages/8lines-gauntlet-protocol-${version}.tgz",\n`
        + `"@8lines/gauntlet-typescript-core": "file:/tmp/gauntlet-packages/8lines-gauntlet-typescript-core-${version}.tgz"\n`
        + `'@8lines/gauntlet-protocol': 'file:/tmp/gauntlet-packages/8lines-gauntlet-protocol-${version}.tgz'\n`,
    ],
```

`writeConsumerJsonFixtures(root, version)` keeps its two writes and adds:

```js
  writeFixtureFile(root, "examples/symfony/composer.json", `${JSON.stringify({
    name: "8lines/gauntlet-symfony-example",
    require: {
      "8lines/gauntlet-php-core": `^${version}`,
      "8lines/gauntlet-symfony-bundle": `^${version}`,
    },
  }, null, 2)}\n`);
```

- [ ] **Step 2: Write the failing tests** in `release-model.test.mjs` (add `RELEASE_TEXT_FILES`, `readReleaseTextSpans`, `renderUnitVersionTable` and, if missing, `readUnitVersions` to the `../release-model.mjs` import; `resolve` from `node:path` if missing):

```js
const REPOSITORY = resolve(import.meta.dirname, "../../..");

test("a counted slot must occur exactly its count of times", () => {
  withVersionFixture((root) => {
    const path = "deploy/helm/README.md";
    writeFixtureFile(root, path, `${readFileSync(join(root, path), "utf8")}helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.1.0 --destination .\n`);
    assert.deepEqual(collectVersionMismatches(root), [`${path}: release references are missing or malformed`]);
  });
});

test("release text spans are exposed for every slot file and only for slot files", () => {
  withVersionFixture((root) => {
    const spans = readReleaseTextSpans(root, "conformance/runner/README.md");
    assert.deepEqual(spans.map(({ unit, value }) => [unit, value]), [
      ["conformance-runner", "0.1.0"], ["conformance-runner", "0.1.0"], ["conformance-runner", "0.1.0"],
    ]);
    const source = readFileSync(join(root, "conformance/runner/README.md"), "utf8");
    assert.equal(source.slice(spans[0].start, spans[0].end), "0.1.0");
    assert.throws(() => readReleaseTextSpans(root, "README.md"), /not a release text file/u);
    assert.deepEqual(RELEASE_TEXT_FILES.map(({ path }) => path), RELEASE_TEXT_PATHS);
  });
});

test("the installation guide lists every unit at its current version in catalog order", () => {
  const source = readFileSync(join(REPOSITORY, "docs/releases/installing-packages.md"), "utf8");
  const start = "<!-- gauntlet:unit-versions:start -->\n";
  const end = "<!-- gauntlet:unit-versions:end -->";
  assert.equal(source.indexOf(start) >= 0 && source.indexOf(end) > source.indexOf(start), true);
  assert.equal(source.slice(source.indexOf(start) + start.length, source.indexOf(end)), renderUnitVersionTable(readUnitVersions(REPOSITORY)));
});
```

Update the existing expectations:

- "binds every version location to a release unit": add `assert.equal(owner("examples/symfony/composer.json", ["require", "8lines/gauntlet-symfony-bundle"]), "symfony-bundle");` and `assert.equal(VERSION_LOCATIONS.find(({ path }) => path === "examples/symfony/composer.json").type, "json-constraint");`.
- "reports every drifting slot against its own unit in fixed order": append after `"docs/ai-skills.md: release references must equal skills 0.1.0",`:

```js
      "deploy/helm/README.md: release references must equal gauntlet 0.1.0",
      "docs/releases/installing-packages.md: release references must equal java-core 0.1.0",
      "docs/releases/installing-packages.md: release references must equal spring-boot-starter 0.1.0",
      "docs/releases/installing-packages.md: release references must equal gauntlet 0.1.0",
      "docs/releases/installing-packages.md: release references must equal skills 0.1.0",
      "docs/integrations/index.md: release references must equal java-core 0.1.0",
      "docs/integrations/index.md: release references must equal spring-boot-starter 0.1.0",
      "packages/java/README.md: release references must equal java-core 0.1.0",
      "packages/java/README.md: release references must equal spring-boot-starter 0.1.0",
      "packages/java/core/README.md: release references must equal java-core 0.1.0",
      "packages/java/spring-boot-starter/README.md: release references must equal spring-boot-starter 0.1.0",
```

- "a slot is checked against its own unit" (php-core at 0.1.9): the expected list becomes

```js
      "packages/php/symfony-bundle/composer.json: require.8lines/gauntlet-php-core must equal ^0.1.9",
      "tests/consumers/php-core/composer.json: require.8lines/gauntlet-php-core must equal php-core 0.1.9",
      "tests/consumers/php-symfony/composer.json: require.8lines/gauntlet-php-core must equal php-core 0.1.9",
      "examples/symfony/composer.json: require.8lines/gauntlet-php-core must equal php-core ^0.1.9",
      "skills/gauntlet-app-integration/references/symfony.md: release references must equal php-core 0.1.9",
      "docs/releases/installing-packages.md: release references must equal php-core 0.1.9",
      "docs/integrations/index.md: release references must equal php-core 0.1.9",
      "packages/php/symfony-bundle/README.md: release references must equal php-core 0.1.9",
```

- "the Symfony reference names each PHP package's own exact version": `changedPaths` becomes `["packages/php/symfony-bundle/composer.json", "tests/consumers/php-symfony/composer.json", "examples/symfony/composer.json", "skills/gauntlet-app-integration/references/symfony.md", "docs/releases/installing-packages.md", "docs/integrations/index.md", "packages/php/symfony-bundle/README.md"]`.
- "a Java core move changes only the lockfile core slot, never the starter slots": rename to "a Java core move reports only java-core slots, never the starter slots"; expected `["tests/consumers/java/gradle.lockfile: release references must equal java-core 0.1.9", "docs/releases/installing-packages.md: release references must equal java-core 0.1.9", "docs/integrations/index.md: release references must equal java-core 0.1.9", "packages/java/README.md: release references must equal java-core 0.1.9", "packages/java/core/README.md: release references must equal java-core 0.1.9"]`.
- "a unit that moves alone reports only its own slots": expected `["docs/ai-skills.md: release references must equal skills 0.1.9", "docs/releases/installing-packages.md: release references must equal skills 0.1.9"]`.
- "setUnitVersions moves one unit…" (`php-core` to 0.2.0): `changedPaths` `["packages/php/core/composer.json", "packages/php/symfony-bundle/composer.json", "tests/consumers/php-core/composer.json", "tests/consumers/php-symfony/composer.json", "examples/symfony/composer.json", "skills/gauntlet-app-integration/references/symfony.md", "docs/releases/installing-packages.md", "docs/integrations/index.md", "packages/php/symfony-bundle/README.md"]`, and add `assert.deepEqual(JSON.parse(readFileSync(join(root, "examples/symfony/composer.json"), "utf8")).require, { "8lines/gauntlet-php-core": "^0.2.0", "8lines/gauntlet-symfony-bundle": "^0.1.8" });`.
- "setUnitVersions moves the application and the skills archive slots independently": gauntlet `changedPaths` gains `"deploy/helm/README.md", "docs/releases/installing-packages.md"` right before `"VERSION"`; skills becomes `["docs/ai-skills.md", "docs/releases/installing-packages.md", "skills/VERSION"]`.
- "the version CLI sets one unit": `changedPaths` `["packages/widget/package.json", "docs/releases/installing-packages.md", "docs/integrations/widget.md"]`.
- "sets every version span through bound descriptors…": add `assert.deepEqual(JSON.parse(readFileSync(join(root, "examples/symfony/composer.json"), "utf8")).require, { "8lines/gauntlet-php-core": "^0.1.1", "8lines/gauntlet-symfony-bundle": "^0.1.1" });`.

- [ ] **Step 3: Run to verify it fails**

Run: `node --test scripts/release/test/release-model.test.mjs`
Expected: FAIL: `readReleaseTextSpans` is not exported and the new fixture files are reported as unknown inputs.

- [ ] **Step 4: Implement in `release-model.mjs`**

1. Counted slots: in `releaseTextSpans`, destructure `{ unit, prefix, suffix, count = 1 }`, require `matches.length === count` (same error message), and `spans.push(...matches)` instead of `spans.push(matches[0])`.
2. The unit version table (function declarations, so `RELEASE_TEXT_FILES` can use them):

```js
export function unitVersionTableRowPrefix(unit) {
  return `| \`${unit.id}\` | ${unit.artifacts.map((name) => `\`${name}\``).join(", ")} | `;
}

export function renderUnitVersionTable(versions) {
  return `${[
    "| Unit | Published as | Version |",
    "| --- | --- | --- |",
    ...RELEASE_UNITS.map((unit) => `${unitVersionTableRowPrefix(unit)}${versions.get(unit.id)} |`),
  ].join("\n")}\n`;
}
```

3. Append to `RELEASE_TEXT_FILES`, after the `docs/ai-skills.md` entry:

```js
  {
    path: "deploy/helm/README.md",
    slots: [
      { unit: "gauntlet", prefix: "The example uses the exact `", suffix: "` application tag" },
      { unit: "gauntlet", prefix: "  repository: ghcr.io/8lines/gauntlet\n  tag: \"", suffix: "\"\n" },
      { unit: "gauntlet", prefix: "Pull the exact `", suffix: "` chart to a local immutable input" },
      { unit: "gauntlet", prefix: "helm pull oci://ghcr.io/8lines/charts/gauntlet --version ", suffix: " --destination .", count: 2 },
      { unit: "gauntlet", prefix: " ./gauntlet-", suffix: ".tgz \\\n", count: 4 },
    ],
  },
  {
    path: "docs/releases/installing-packages.md",
    slots: [
      { unit: "protocol", prefix: "pnpm add @8lines/gauntlet-protocol@", suffix: " \\\n" },
      { unit: "typescript-core", prefix: "  @8lines/gauntlet-typescript-core@", suffix: " \\\n" },
      { unit: "typescript-node", prefix: "  @8lines/gauntlet-typescript-node@", suffix: "\n" },
      { unit: "symfony-bundle", prefix: "composer require 8lines/gauntlet-symfony-bundle:", suffix: "\n" },
      { unit: "php-core", prefix: "`8lines/gauntlet-php-core:", suffix: "` alone" },
      { unit: "java-core", prefix: "dev.eightlines.gauntlet:core:", suffix: "\n" },
      { unit: "spring-boot-starter", prefix: "dev.eightlines.gauntlet:spring-boot-starter:", suffix: "\n" },
      { unit: "gauntlet", prefix: "docker pull ghcr.io/8lines/gauntlet:", suffix: "\n" },
      { unit: "gauntlet", prefix: "helm pull oci://ghcr.io/8lines/charts/gauntlet --version ", suffix: "\n" },
      { unit: "gauntlet", prefix: "at exact version `", suffix: "`, render that local archive" },
      ...RELEASE_UNITS.map((unit) => ({ unit: unit.id, prefix: unitVersionTableRowPrefix(unit), suffix: " |\n" })),
    ],
  },
  {
    path: "docs/integrations/index.md",
    slots: [
      { unit: "typescript-core", prefix: "| Native Node.js 24–26 | `@8lines/gauntlet-typescript-core@", suffix: "` and" },
      { unit: "typescript-node", prefix: "`@8lines/gauntlet-typescript-node@", suffix: "` |" },
      { unit: "typescript-core", prefix: "| Next.js App Router on Node.js 24–26 | `@8lines/gauntlet-typescript-core@", suffix: "` and" },
      { unit: "next-adapter", prefix: "`@8lines/gauntlet-next-adapter@", suffix: "` |" },
      { unit: "php-core", prefix: "`8lines/gauntlet-php-core` at `", suffix: "` |" },
      { unit: "symfony-bundle", prefix: "`8lines/gauntlet-symfony-bundle` at `", suffix: "` |" },
      { unit: "java-core", prefix: "| Java 21 | `dev.eightlines.gauntlet:core:", suffix: "` |" },
      { unit: "spring-boot-starter", prefix: "Core and `dev.eightlines.gauntlet:spring-boot-starter:", suffix: "` |" },
    ],
  },
  {
    path: "docs/integrations/widget.md",
    slots: [{ unit: "widget", prefix: "npm install @8lines/gauntlet-widget@", suffix: "\n" }],
  },
  {
    path: "conformance/runner/README.md",
    slots: [{ unit: "conformance-runner", prefix: "pnpm dlx --package @8lines/gauntlet-conformance-runner@", suffix: " gauntlet-conformance", count: 3 }],
  },
  {
    path: "packages/java/README.md",
    slots: [
      { unit: "java-core", prefix: "- `dev.eightlines.gauntlet:core:", suffix: "` —" },
      { unit: "spring-boot-starter", prefix: "- `dev.eightlines.gauntlet:spring-boot-starter:", suffix: "` —" },
      { unit: "spring-boot-starter", prefix: "implementation(\"dev.eightlines.gauntlet:spring-boot-starter:", suffix: "\")" },
    ],
  },
  {
    path: "packages/java/core/README.md",
    slots: [
      { unit: "java-core", prefix: "`dev.eightlines.gauntlet:core:", suffix: "` is the framework-neutral" },
      { unit: "java-core", prefix: "implementation(\"dev.eightlines.gauntlet:core:", suffix: "\")" },
    ],
  },
  {
    path: "packages/java/spring-boot-starter/README.md",
    slots: [
      { unit: "spring-boot-starter", prefix: "`dev.eightlines.gauntlet:spring-boot-starter:", suffix: "` is the Java 21" },
      { unit: "spring-boot-starter", prefix: "implementation(\"dev.eightlines.gauntlet:spring-boot-starter:", suffix: "\")" },
    ],
  },
  {
    path: "packages/php/symfony-bundle/README.md",
    slots: [
      { unit: "php-core", prefix: "composer require 8lines/gauntlet-php-core:", suffix: " \\\n" },
      { unit: "symfony-bundle", prefix: "  8lines/gauntlet-symfony-bundle:", suffix: "\n" },
    ],
  },
  {
    path: "packages/typescript/core/README.md",
    slots: [
      { unit: "protocol", prefix: "pnpm add @8lines/gauntlet-protocol@", suffix: " \\\n" },
      { unit: "typescript-core", prefix: "  @8lines/gauntlet-typescript-core@", suffix: "\n" },
      { unit: "protocol", prefix: "8lines-gauntlet-protocol-", suffix: ".tgz", count: 2 },
      { unit: "typescript-core", prefix: "8lines-gauntlet-typescript-core-", suffix: ".tgz" },
    ],
  },
```

Export it: change `const RELEASE_TEXT_FILES = deeplyFreeze([` to `export const RELEASE_TEXT_FILES = deeplyFreeze([`.

4. Add after `releaseTextSpans`:

```js
export function readReleaseTextSpans(root, path) {
  const file = RELEASE_TEXT_FILES.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error("Path is not a release text file");
  return Object.freeze(releaseTextSpans(readManifest(root, path).source, file.slots).map((span) => Object.freeze({ ...span })));
}
```

5. Constraint consumers: append to `RELEASE_CONSUMER_JSON_FILES`

```js
  {
    path: "examples/symfony/composer.json",
    keyPaths: [
      { keyPath: ["require", "8lines/gauntlet-php-core"], unit: "php-core", constraint: true },
      { keyPath: ["require", "8lines/gauntlet-symfony-bundle"], unit: "symfony-bundle", constraint: true },
    ],
  },
```

In `pushConsumerJsonChecks`, destructure `{ keyPath, unit, constraint = false }`, compare with `const expected = constraint ? \`^${version}\` : version;` and report `` `${path}: ${keyPath.join(".")} must equal ${unit} ${expected}` ``. In `prepareReleaseUpdate` map consumer edits with `({ keyPath, unit, constraint = false }) => edit(keyPath, unit, constraint)`. In `VERSION_LOCATIONS` map consumer key paths to `({ type: constraint ? "json-constraint" : "json", path, keyPath, unit })`, and the release-text `occurrences` become `slots.filter((slot) => slot.unit === unit).reduce((total, { count = 1 }) => total + count, 0)`.

- [ ] **Step 5: Fix the stale pins and add the table** (current versions come from `node scripts/release/version.mjs --check`; every unit is at `0.1.8` on `a198f58`):
  - `docs/integrations/index.md`: replace every `0.1.1` in the table rows (lines 12-17) with that row's unit version (`0.1.8`); rewrite row 15's cell to ``PHP Core and `8lines/gauntlet-symfony-bundle` at `0.1.8` ``; replace line 29 "2. Install exact `0.1.1` packages for one supported stack." with "2. Install the exact package versions listed above for one supported stack."
  - `conformance/runner/README.md`: the three `@8lines/gauntlet-conformance-runner@0.1.1` become `@0.1.8`.
  - `packages/java/core/README.md`: both `dev.eightlines.gauntlet:core:0.1.1` become `:0.1.8`.
  - `packages/java/README.md` line 11: "Release `0.1.8` publishes two Java 21 consumer artifacts:" becomes "The Java SDK publishes two Java 21 consumer artifacts, each with its own version:".
  - `docs/releases/installing-packages.md`: replace "each tagged\nwith an annotated `v0.1.8`." with "each tagged\nwith an annotated `v<version>` for that package's own version."; insert before `## npm`:

````markdown
## Current versions

Each release unit has its own version. `pnpm release:prepare` keeps this table
current.

<!-- gauntlet:unit-versions:start -->
<!-- gauntlet:unit-versions:end -->

````

  then fill the block: `node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; import { readUnitVersions, renderUnitVersionTable } from "./scripts/release/release-model.mjs"; const path = "docs/releases/installing-packages.md"; const marker = "<!-- gauntlet:unit-versions:start -->\n"; const source = readFileSync(path, "utf8"); writeFileSync(path, source.replace(marker, marker + renderUnitVersionTable(readUnitVersions(process.cwd()))));'`

- [ ] **Step 6: Run**

Run: `node --test scripts/release/test/release-model.test.mjs && pnpm release:test && node scripts/release/version.mjs --check && node scripts/docs/check-docs.mjs && pnpm test:helm`
Expected: PASS; `version.mjs --check` prints `"ok":true` with 13 unit lines.

- [ ] **Step 7: Re-bind** (`release-model.mjs` changed): `pnpm skills:rebind --reason "Release version slots now cover every documented package, image and chart pin." && pnpm skills:validate` → `"ok":true` twice.

- [ ] **Step 8: Commit**

```bash
git add scripts/release/release-model.mjs scripts/release/test/release-model.test.mjs scripts/release/test/version-fixture.mjs docs/releases/installing-packages.md docs/integrations/index.md conformance/runner/README.md packages/java/README.md packages/java/core/README.md skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring
git commit -m "feat(release): bind every documented package, image and chart pin to its unit

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Report every pin that no version slot covers

**Files:**
- Create: `scripts/release/pins.mjs`
- Test: `scripts/release/test/pins.test.mjs`
- Modify: `scripts/docs/check-docs.mjs` (`checkDocumentation` ~264-292, `main` ~294-303), `scripts/docs/test/check-docs.test.mjs`, `scripts/docs/test/release-runbooks.test.mjs` (lines 14 and 87)

**Interfaces:**
- Consumes: `RELEASE_TEXT_FILES`, `readReleaseTextSpans(root, path)`, `VERSION_LOCATIONS` (Task 2).
- Produces (exported from `pins.mjs`):
  - `PIN_PATTERNS: readonly string[]`: regular expression sources, each with one capture group around the version, for `@8lines/gauntlet-<name>@V`, `8lines/gauntlet-(php-core|symfony-bundle):V` and `"8lines/gauntlet-…": "^V"`, `dev.eightlines.gauntlet:(core|spring-boot-starter):V`, `ghcr.io/8lines/gauntlet:V`, `charts/gauntlet --version V`, `gauntlet-V.tgz`, `gauntlet-skills-V`, `8lines-gauntlet-<name>-V.tgz`.
  - `isScannedPath(path: string): boolean`: false for changelogs, `docs/superpowers/**`, `skill-evals/**`, `.changes/**`, test directories and `*.test.*` files, lockfiles, and every structured version location (JSON, YAML, dotenv, VERSION files) that `version.mjs --check` already validates.
  - `findUnboundPins(root: string, paths: readonly string[]): readonly string[]`: `"<path>:<line>: <match> is not a release version slot"` for each match whose version span is not a slot span, and `"<path>: release references are missing or malformed"` for a slot file that does not parse; files are visited in sorted order, matches in pattern order.
  - `listTrackedFiles(root: string): readonly string[]` (`git ls-files -z`).
  - `checkDocumentation({ root, trackedFiles? })`: when `trackedFiles` is given, its errors include `findUnboundPins(root, trackedFiles)`; `node scripts/docs/check-docs.mjs` passes `listTrackedFiles(root)`.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/pins.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { findUnboundPins, isScannedPath, listTrackedFiles } from "../pins.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

function scratch(t, files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-pins-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

test("every tracked pin of a released coordinate is a release version slot", () => {
  assert.deepEqual(findUnboundPins(ROOT, listTrackedFiles(ROOT)), []);
});

test("reports each unslotted coordinate with its line, in every published form", (t) => {
  const root = scratch(t, {
    "docs/guide.md": [
      "Intro.",
      "pnpm dlx --package @8lines/gauntlet-conformance-runner@0.1.1 gauntlet-conformance",
      "composer require 8lines/gauntlet-php-core:0.1.1",
      '"8lines/gauntlet-symfony-bundle": "^0.1.1"',
      'implementation("dev.eightlines.gauntlet:core:0.1.1")',
      "docker pull ghcr.io/8lines/gauntlet:0.1.1",
      "helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.1.1",
      "helm template gauntlet ./gauntlet-0.1.1.tgz",
      "tar -xzf gauntlet-skills-0.1.1.tgz",
      "file:/tmp/8lines-gauntlet-protocol-0.1.1.tgz",
      "",
    ].join("\n"),
  });
  assert.deepEqual(findUnboundPins(root, ["docs/guide.md"]), [
    "docs/guide.md:2: @8lines/gauntlet-conformance-runner@0.1.1 is not a release version slot",
    "docs/guide.md:3: 8lines/gauntlet-php-core:0.1.1 is not a release version slot",
    'docs/guide.md:4: 8lines/gauntlet-symfony-bundle": "^0.1.1 is not a release version slot',
    "docs/guide.md:5: dev.eightlines.gauntlet:core:0.1.1 is not a release version slot",
    "docs/guide.md:6: ghcr.io/8lines/gauntlet:0.1.1 is not a release version slot",
    "docs/guide.md:7: charts/gauntlet --version 0.1.1 is not a release version slot",
    "docs/guide.md:8: gauntlet-0.1.1.tgz is not a release version slot",
    "docs/guide.md:9: gauntlet-skills-0.1.1 is not a release version slot",
    "docs/guide.md:10: 8lines-gauntlet-protocol-0.1.1.tgz is not a release version slot",
  ]);
});

test("a slot-covered pin passes, an extra pin in a slot file and a malformed slot file are reported", (t) => {
  const root = scratch(t, {
    "docs/integrations/widget.md": "npm install @8lines/gauntlet-widget@0.1.8\n",
    "conformance/runner/README.md": "pnpm dlx --package @8lines/gauntlet-conformance-runner@0.1.8 gauntlet-conformance\n",
  });
  assert.deepEqual(findUnboundPins(root, ["docs/integrations/widget.md"]), []);
  writeFileSync(join(root, "docs/integrations/widget.md"), "npm install @8lines/gauntlet-widget@0.1.8\nSee `@8lines/gauntlet-widget@0.1.7`.\n");
  assert.deepEqual(findUnboundPins(root, ["docs/integrations/widget.md"]), [
    "docs/integrations/widget.md:2: @8lines/gauntlet-widget@0.1.7 is not a release version slot",
  ]);
  assert.deepEqual(findUnboundPins(root, ["conformance/runner/README.md"]), [
    "conformance/runner/README.md: release references are missing or malformed",
  ]);
});

test("history, evaluation records, tests, locks and structured manifests are not scanned", () => {
  for (const path of [
    "CHANGELOG.md", "packages/protocol/CHANGELOG.md", "docs/superpowers/plans/x.md", "skill-evals/a/results/b.jsonl",
    ".changes/x.md", "scripts/release/test/x.test.mjs", "tests/consumers/php-core/composer.json", "pnpm-lock.yaml",
    "examples/symfony/composer.lock", "deploy/compose/.env.example", "examples/symfony/composer.json", "VERSION",
  ]) assert.equal(isScannedPath(path), false, path);
  for (const path of ["README.md", "docs/releases/installing-packages.md", "deploy/helm/README.md"]) {
    assert.equal(isScannedPath(path), true, path);
  }
});
```

Add to `scripts/docs/test/check-docs.test.mjs` (add `mkdirSync`, `mkdtempSync`, `realpathSync`, `rmSync`, `writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path` to its imports where missing):

```js
test("reports a tracked pin that no release slot covers", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-docs-pins-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/documentation-manifest.json"), `${JSON.stringify({
    schemaVersion: 1, requiredFiles: ["README.md"], forbiddenPhrases: [], requiredPhrases: [],
  })}\n`);
  writeFileSync(join(root, "README.md"), "Run `pnpm dlx --package @8lines/gauntlet-conformance-runner@0.1.1 gauntlet-conformance`.\n");
  assert.deepEqual((await checkDocumentation({ root })).errors, []);
  assert.deepEqual((await checkDocumentation({ root, trackedFiles: ["README.md"] })).errors, [
    "README.md:1: @8lines/gauntlet-conformance-runner@0.1.1 is not a release version slot",
  ]);
});
```

In `scripts/docs/test/release-runbooks.test.mjs`, derive the two hard-coded versions from the manifests so a release does not break the test:

```js
import { readUnitVersion } from "../../release/release-model.mjs";

const versionPattern = (unit) => readUnitVersion(ROOT, unit).replaceAll(".", "\\.");
```

and replace `assert.match(source, /composer require 8lines\/gauntlet-symfony-bundle:0\.1\.8/u);` with `assert.match(source, new RegExp(\`composer require 8lines/gauntlet-symfony-bundle:${versionPattern("symfony-bundle")}\`, "u"));` and `assert.match(source, /gauntlet-skills-0\.1\.8\.tgz/u);` with `assert.match(source, new RegExp(\`gauntlet-skills-${versionPattern("skills")}\\.tgz\`, "u"));`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/pins.test.mjs scripts/docs/test/check-docs.test.mjs`
Expected: FAIL with `Cannot find module` for `../pins.mjs`, and the check-docs test reports `[]` for the tracked-file run.

- [ ] **Step 3: Implement `scripts/release/pins.mjs`**

```js
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { RELEASE_TEXT_FILES, VERSION_LOCATIONS, readReleaseTextSpans } from "./release-model.mjs";

const VERSION = String.raw`(\d+\.\d+\.\d+)`;
const MAX_SCANNED_BYTES = 4 * 1024 * 1024;

// Every form in which a released Gauntlet coordinate is pinned to an exact version.
export const PIN_PATTERNS = Object.freeze([
  String.raw`@8lines/gauntlet-[a-z0-9-]+@${VERSION}`,
  String.raw`8lines/gauntlet-(?:php-core|symfony-bundle)(?::|"\s*:\s*"\^?)${VERSION}`,
  String.raw`dev\.eightlines\.gauntlet:(?:core|spring-boot-starter):${VERSION}`,
  String.raw`ghcr\.io/8lines/gauntlet:${VERSION}`,
  String.raw`charts/gauntlet --version ${VERSION}`,
  String.raw`(?<![\w-])gauntlet-${VERSION}\.tgz`,
  String.raw`gauntlet-skills-${VERSION}`,
  String.raw`8lines-gauntlet-[a-z0-9-]+-${VERSION}\.tgz`,
]);

// Release history, frozen evaluation records, change prose, tests and lockfiles keep historical versions.
const UNSCANNED = Object.freeze([
  /(?:^|\/)CHANGELOG\.md$/u,
  /^docs\/superpowers\//u,
  /^skill-evals\//u,
  /^\.changes\//u,
  /(?:^|\/)(?:test|tests|__tests__)\//u,
  /\.test\.[cm]?[jt]sx?$/u,
  /(?:^|\/)(?:pnpm-lock\.yaml|composer\.lock|gradle\.lockfile)$/u,
]);
// Structured manifests are validated value by value by version.mjs --check.
const STRUCTURED = new Set(VERSION_LOCATIONS.filter(({ type }) => type !== "release-text").map(({ path }) => path));
const TEXT_FILES = new Set(RELEASE_TEXT_FILES.map(({ path }) => path));

export function isScannedPath(path) {
  return typeof path === "string" && !STRUCTURED.has(path) && !UNSCANNED.some((pattern) => pattern.test(path));
}

function readText(root, path) {
  const absolute = resolve(root, ...path.split("/"));
  if (!absolute.startsWith(`${root}${sep}`)) return null;
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) return null;
  const bytes = readFileSync(absolute);
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

export function findUnboundPins(root, paths) {
  const problems = [];
  for (const path of [...paths].sort()) {
    if (!isScannedPath(path)) continue;
    const source = readText(root, path);
    if (source === null) continue;
    let slots = [];
    if (TEXT_FILES.has(path)) {
      try {
        slots = readReleaseTextSpans(root, path);
      } catch {
        problems.push(`${path}: release references are missing or malformed`);
        continue;
      }
    }
    for (const pattern of PIN_PATTERNS) {
      for (const match of source.matchAll(new RegExp(pattern, "dgu"))) {
        const [start, end] = match.indices[1];
        if (slots.some((slot) => slot.start === start && slot.end === end)) continue;
        problems.push(`${path}:${source.slice(0, start).split("\n").length}: ${match[0]} is not a release version slot`);
      }
    }
  }
  return Object.freeze(problems);
}

export function listTrackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    env: {
      PATH: process.env.PATH, HOME: "/dev/null", LANG: "C", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return Object.freeze(output.split("\0").filter((path) => path !== ""));
}
```

In `scripts/docs/check-docs.mjs`: `import { findUnboundPins, listTrackedFiles } from "../release/pins.mjs";`; change the signature to `export async function checkDocumentation({ root: rawRoot, trackedFiles })` and, before the final `return`, add `if (trackedFiles !== undefined) errors.push(...findUnboundPins(root, trackedFiles));`; in `main`, call `checkDocumentation({ root, trackedFiles: listTrackedFiles(root) })`.

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/pins.test.mjs && node --test scripts/docs/test/*.test.mjs && node scripts/docs/check-docs.mjs && pnpm release:test`
Expected: PASS; `check-docs.mjs` prints `{"ok":true}`. If the repository scan reports a pin, it is either a stale pin to fix and slot (Task 2 pattern) or a historical file; do not widen `UNSCANNED` beyond history, records, tests and lockfiles.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/pins.mjs scripts/release/test/pins.test.mjs scripts/docs/check-docs.mjs scripts/docs/test/check-docs.test.mjs scripts/docs/test/release-runbooks.test.mjs
git commit -m "feat(release): report every pin that no release version slot covers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Change files, bumps and cascade

**Files:**
- Create: `scripts/release/changes.mjs` (parsing and computation; Task 5 adds the CLI)
- Test: `scripts/release/test/changes.test.mjs`
- Modify: `scripts/release/plan.mjs` (`createReleasePlan` ~94-104, `serializeReleasePlan` ~106-112, `parseReleasePlan` ~114-127; new export `CHANGE_FILE_NAME`), `scripts/release/test/plan.test.mjs`

**Interfaces:**
- Consumes: `parseReleaseVersion` (`release-model.mjs`), `RELEASE_UNITS`, `dependencyOrder`, `dependentsOf`, `unitById` (`units.mjs`), `RELEASE_TEXT_FILES` (Task 2), `parseDocument` (`yaml`).
- Produces:
  - `plan.mjs`: `CHANGE_FILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.md$/u`; `createReleasePlan(entries, { changes = [] } = {})` validates names (pattern, unique) and adds `changes` (sorted, frozen) only when non-empty; `serializeReleasePlan` writes `"changes"` after `"order"` only when present; `parseReleasePlan` accepts it and still requires canonical bytes (so `"changes": []`, unsorted or invalid names are refused with `Release plan is invalid`).
  - `changes.mjs`:
    - `CHANGES_DIRECTORY = ".changes"`, `CHANGE_TYPES = ["added","changed","fixed","removed","security"]`, `BUMPS = ["none","patch","minor","major"]`.
    - `ChangeFile = Readonly<{ name: string; type: string; units: Readonly<Record<string, Bump>>; body: string }>` (`units` keys in catalog order; `body` is the paragraph joined into one line).
    - `parseChangeFile(name: string, source: string): ChangeFile` (errors `Change file <name>: <reason>`; a bad name gives `Change file name <name> must match …`).
    - `readChangeFiles(root: string): readonly ChangeFile[]` (absent directory → `[]`; sorted by name; anything that is not a regular `*.md` change file → `.changes/<entry> is not a change file …`).
    - `nextVersion(version: string, bump: "patch"|"minor"|"major"): string`.
    - `computeRelease({ versions: ReadonlyMap<string,string>, changes: readonly ChangeFile[] }): Readonly<{ units: readonly Readonly<{ id, from, to, bump, cascaded: boolean, entries: readonly Readonly<{ type, text }>[] }>[]; consumed: readonly string[] }>`: units in dependency order; `consumed` is every change file name (including `none`-only ones), sorted. No change files → `Release preparation found no change files in .changes`; only `none` → `Release preparation found no change file that releases a unit (every change file says none)`.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/changes.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeRelease, nextVersion, parseChangeFile, readChangeFiles } from "../changes.mjs";
import { RELEASE_TEXT_FILES } from "../release-model.mjs";
import { RELEASE_UNITS, unitById } from "../units.mjs";

const SPEC_EXAMPLE = "---\ntype: added            # added | changed | fixed | removed | security\nunits:\n  protocol: minor\n  gauntlet: patch\n---\nRun requests accept an optional deadline.\n";
const BASE = new Map(RELEASE_UNITS.map(({ id }) => [id, "0.1.8"]));

function change(name, type, units, body = "A user-facing sentence.") {
  const lines = Object.entries(units).map(([id, bump]) => `  ${id}: ${bump}`);
  return parseChangeFile(name, `---\ntype: ${type}\nunits:\n${lines.join("\n")}\n---\n${body}\n`);
}

test("parses the documented change file format", () => {
  assert.deepEqual(parseChangeFile("deadline.md", SPEC_EXAMPLE), {
    name: "deadline.md", type: "added", units: { gauntlet: "patch", protocol: "minor" },
    body: "Run requests accept an optional deadline.",
  });
  assert.equal(
    parseChangeFile("wrapped.md", "---\ntype: fixed\nunits:\n  widget: patch\n---\nA sentence that\nwraps lines.\n").body,
    "A sentence that wraps lines.",
  );
});

test("rejects every malformed change file with the file name and the reason", () => {
  const body = (front, text = "Body.") => `---\n${front}\n---\n${text}\n`;
  const cases = [
    ["Deadline.md", SPEC_EXAMPLE, /Change file name Deadline\.md/u],
    ["a.md", SPEC_EXAMPLE.replaceAll("\n", "\r\n"), /LF-only/u],
    ["a.md", "type: added\n", /front matter/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor\nextra: 1"), /exactly type and units/u],
    ["a.md", body("type: improved\nunits:\n  protocol: minor"), /type must be one of/u],
    ["a.md", body("type: added\nunits: {}"), /at least one release unit/u],
    ["a.md", body("type: added\nunits:\n  nope: minor"), /unknown release unit nope/u],
    ["a.md", body("type: added\nunits:\n  protocol: huge"), /protocol bump must be one of/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor\n  protocol: patch"), /not valid YAML/u],
    ["a.md", "---\ntype: added\nunits:\n  protocol: minor\n---\n\n", /changelog sentence/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor", "One.\n\nTwo."), /one paragraph/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor", "Deadlines — optional."), /em dash/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor", "lower case."), /sentence case/u],
  ];
  for (const [name, source, pattern] of cases) {
    assert.throws(() => parseChangeFile(name, source), pattern, `${name}: ${JSON.stringify(source)}`);
  }
});

test("reads change files in name order and refuses anything else in .changes", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-changes-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readChangeFiles(root), []);
  mkdirSync(join(root, ".changes"));
  writeFileSync(join(root, ".changes/b-second.md"), SPEC_EXAMPLE);
  writeFileSync(join(root, ".changes/a-first.md"), SPEC_EXAMPLE);
  assert.deepEqual(readChangeFiles(root).map(({ name }) => name), ["a-first.md", "b-second.md"]);
  writeFileSync(join(root, ".changes/notes.txt"), "x\n");
  assert.throws(() => readChangeFiles(root), /\.changes\/notes\.txt is not a change file/u);
  rmSync(join(root, ".changes/notes.txt"));
  symlinkSync(join(root, ".changes/a-first.md"), join(root, ".changes/c-link.md"));
  assert.throws(() => readChangeFiles(root), /\.changes\/c-link\.md is not a change file/u);
});

test("bumps apply literally under semver", () => {
  assert.equal(nextVersion("0.1.8", "patch"), "0.1.9");
  assert.equal(nextVersion("0.1.9", "patch"), "0.1.10");
  assert.equal(nextVersion("0.1.8", "minor"), "0.2.0");
  assert.equal(nextVersion("0.9.3", "major"), "1.0.0");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.throws(() => nextVersion("0.1.8", "none"), /Unknown bump none/u);
});

test("a dashboard-only change releases the application and the skills archive", () => {
  const release = computeRelease({ versions: BASE, changes: [change("sidebar.md", "fixed", { gauntlet: "patch" }, "Sidebar keeps its width.")] });
  assert.deepEqual(release.units, [
    { id: "gauntlet", from: "0.1.8", to: "0.1.9", bump: "patch", cascaded: false, entries: [{ type: "fixed", text: "Sidebar keeps its width." }] },
    { id: "skills", from: "0.1.8", to: "0.1.9", bump: "patch", cascaded: true, entries: [{ type: "changed", text: "Updated `gauntlet` to 0.1.9." }] },
  ]);
  assert.deepEqual(release.consumed, ["sidebar.md"]);
});

test("a protocol minor release cascades a patch to every dependent with update entries", () => {
  const release = computeRelease({
    versions: BASE, changes: [change("deadline.md", "added", { protocol: "minor" }, "Run requests accept an optional deadline.")],
  });
  assert.deepEqual(release.units.map(({ id, to, bump, cascaded }) => [id, to, bump, cascaded]), [
    ["protocol", "0.2.0", "minor", false],
    ["dashboard-client", "0.1.9", "patch", true],
    ["gauntlet", "0.1.9", "patch", true],
    ["typescript-core", "0.1.9", "patch", true],
    ["typescript-node", "0.1.9", "patch", true],
    ["next-adapter", "0.1.9", "patch", true],
    ["conformance-runner", "0.1.9", "patch", true],
    ["skills", "0.1.9", "patch", true],
  ]);
  const texts = Object.fromEntries(release.units.map(({ id, entries }) => [id, entries.map(({ text }) => text)]));
  assert.deepEqual(texts.protocol, ["Run requests accept an optional deadline."]);
  assert.deepEqual(texts.gauntlet, ["Updated `protocol` to 0.2.0.", "Updated `dashboard-client` to 0.1.9."]);
  assert.deepEqual(texts["typescript-node"], ["Updated `protocol` to 0.2.0.", "Updated `typescript-core` to 0.1.9."]);
  assert.deepEqual(texts["next-adapter"], ["Updated `typescript-node` to 0.1.9."]);
  assert.deepEqual(texts.skills, [
    "Updated `protocol` to 0.2.0.", "Updated `gauntlet` to 0.1.9.", "Updated `typescript-core` to 0.1.9.",
    "Updated `typescript-node` to 0.1.9.", "Updated `next-adapter` to 0.1.9.",
  ]);
});

test("a php-core patch also releases symfony-bundle, whose constraint follows php-core, and the skills", () => {
  const release = computeRelease({ versions: BASE, changes: [change("php.md", "fixed", { "php-core": "patch" })] });
  assert.deepEqual(release.units.map(({ id, to, cascaded }) => [id, to, cascaded]), [
    ["php-core", "0.1.9", false], ["symfony-bundle", "0.1.9", true], ["skills", "0.1.9", true],
  ]);
  assert.deepEqual(release.units[1].entries, [{ type: "changed", text: "Updated `php-core` to 0.1.9." }]);
});

test("the highest bump wins across change files, none never releases, and none alone releases nothing", () => {
  const release = computeRelease({ versions: BASE, changes: [
    change("a.md", "fixed", { widget: "patch" }, "Fixed the button."),
    change("b.md", "added", { widget: "minor", protocol: "none" }, "Added a command."),
    change("c.md", "changed", { widget: "none" }, "Reformatted sources."),
  ] });
  assert.deepEqual(release.units, [{
    id: "widget", from: "0.1.8", to: "0.2.0", bump: "minor", cascaded: false,
    entries: [{ type: "fixed", text: "Fixed the button." }, { type: "added", text: "Added a command." }],
  }]);
  assert.deepEqual(release.consumed, ["a.md", "b.md", "c.md"]);
  assert.throws(
    () => computeRelease({ versions: BASE, changes: [change("c.md", "changed", { widget: "none" }, "Reformatted sources.")] }),
    /no change file that releases a unit/u,
  );
  assert.throws(() => computeRelease({ versions: BASE, changes: [] }), /found no change files/u);
});

test("every unit pinned by skill text cascades into the skills archive", () => {
  const dependencies = new Set(unitById("skills").dependsOn);
  for (const { path, slots } of RELEASE_TEXT_FILES.filter(({ path: file }) => file.startsWith("skills/"))) {
    for (const { unit } of slots) assert.equal(unit === "skills" || dependencies.has(unit), true, `${path} pins ${unit}`);
  }
});
```

Add to `scripts/release/test/plan.test.mjs`:

```js
test("a plan records the change files it consumed, sorted, only when there are any", () => {
  const units = [{ id: "gauntlet", from: "0.1.8", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }];
  const plan = createReleasePlan(units, { changes: ["sidebar.md", "colors.md"] });
  assert.deepEqual(plan.changes, ["colors.md", "sidebar.md"]);
  const source = serializeReleasePlan(plan);
  assert.equal(source, `${JSON.stringify({ schemaVersion: 1, units, order: ["gauntlet", "skills"], changes: ["colors.md", "sidebar.md"] }, null, 2)}\n`);
  assert.deepEqual(parseReleasePlan(source), plan);
  assert.equal(Object.hasOwn(createReleasePlan(units), "changes"), false);
  const toSource = (changes) => `${JSON.stringify({ schemaVersion: 1, units, order: ["gauntlet", "skills"], changes }, null, 2)}\n`;
  for (const changes of [[], ["sidebar.md", "colors.md"], ["../x.md"], ["a.md", "a.md"], "a.md"]) {
    assert.throws(() => parseReleasePlan(toSource(changes)), /Release plan is invalid/u, JSON.stringify(changes));
  }
  assert.throws(() => createReleasePlan(units, { changes: ["Upper.md"] }), /Release plan is invalid/u);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/changes.test.mjs scripts/release/test/plan.test.mjs`
Expected: FAIL with `Cannot find module` for `../changes.mjs` and `plan.changes` undefined.

- [ ] **Step 3: Implement**

`plan.mjs`:

```js
export const CHANGE_FILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.md$/u;

function planChanges(changes) {
  if (!Array.isArray(changes) || changes.some((name) => typeof name !== "string" || !CHANGE_FILE_NAME.test(name))
      || new Set(changes).size !== changes.length) throw new Error(PLAN_FAILURE);
  return Object.freeze([...changes].sort());
}

export function createReleasePlan(entries, { changes = [] } = {}) {
  const list = [...entries].map(planEntry);
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  if (byId.size !== list.length) throw new Error(PLAN_FAILURE);
  const order = dependencyOrder([...byId.keys()]);
  const consumed = planChanges(changes);
  return Object.freeze({
    schemaVersion: 1,
    units: Object.freeze(order.map((id) => byId.get(id))),
    order: Object.freeze([...order]),
    ...(consumed.length > 0 ? { changes: consumed } : {}),
  });
}

export function serializeReleasePlan(plan) {
  return `${JSON.stringify({
    schemaVersion: 1,
    units: plan.units.map(({ id, from, to }) => ({ id, from, to })),
    order: [...plan.order],
    ...(plan.changes?.length > 0 ? { changes: [...plan.changes] } : {}),
  }, null, 2)}\n`;
}
```

In `parseReleasePlan`, replace `const plan = createReleasePlan(value.units);` with `const plan = createReleasePlan(value.units, { changes: value.changes ?? [] });` (the canonical round trip already rejects `"changes": []`, unsorted names and unknown keys).

`scripts/release/changes.mjs`:

```js
#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import { CHANGE_FILE_NAME } from "./plan.mjs";
import { parseReleaseVersion } from "./release-model.mjs";
import { RELEASE_UNITS, dependencyOrder, dependentsOf, unitById } from "./units.mjs";

export const CHANGES_DIRECTORY = ".changes";
export const CHANGE_TYPES = Object.freeze(["added", "changed", "fixed", "removed", "security"]);
export const BUMPS = Object.freeze(["none", "patch", "minor", "major"]);
const RANK = Object.freeze({ none: 0, patch: 1, minor: 2, major: 3 });
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u;
const MAX_CHANGE_BYTES = 16 * 1024;
const UNIT_IDS = new Set(RELEASE_UNITS.map(({ id }) => id));

export function parseChangeFile(name, source) {
  if (typeof name !== "string" || !CHANGE_FILE_NAME.test(name)) {
    throw new Error(`Change file name ${String(name)} must match ${CHANGE_FILE_NAME.source}`);
  }
  const fail = (reason) => {
    throw new Error(`Change file ${name}: ${reason}`);
  };
  if (typeof source !== "string" || source.includes("\r") || source.includes("\0")) fail("must be LF-only UTF-8 text");
  const match = FRONT_MATTER.exec(source);
  if (match === null) fail("must start with --- front matter");
  const document = parseDocument(match[1], { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) fail("front matter is not valid YAML");
  const data = document.toJS({ maxAliasCount: 0 });
  if (data === null || typeof data !== "object" || Array.isArray(data)
      || Object.keys(data).sort().join(",") !== "type,units") fail("front matter must contain exactly type and units");
  if (!CHANGE_TYPES.includes(data.type)) fail(`type must be one of ${CHANGE_TYPES.join(", ")}`);
  const { units } = data;
  if (units === null || typeof units !== "object" || Array.isArray(units) || Object.keys(units).length === 0) {
    fail("units must map at least one release unit to a bump");
  }
  for (const [id, bump] of Object.entries(units)) {
    if (!UNIT_IDS.has(id)) fail(`unknown release unit ${id}`);
    if (!BUMPS.includes(bump)) fail(`unit ${id} bump must be one of ${BUMPS.join(", ")}`);
  }
  const body = match[2].trim();
  if (body === "") fail("the body must hold the changelog sentence");
  if (/\n\s*\n/u.test(body)) fail("the body must be one paragraph");
  if (body.includes("—")) fail("the body must not contain an em dash");
  if (!/^[A-Z`]/u.test(body)) fail("the body must start in sentence case");
  if (body.length > 1000) fail("the body is longer than 1000 characters");
  return Object.freeze({
    name,
    type: data.type,
    units: Object.freeze(Object.fromEntries(RELEASE_UNITS.filter(({ id }) => Object.hasOwn(units, id)).map(({ id }) => [id, units[id]]))),
    body: body.split("\n").map((line) => line.trim()).join(" "),
  });
}

export function readChangeFiles(root) {
  const directory = resolve(root, CHANGES_DIRECTORY);
  let entries;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${CHANGES_DIRECTORY} must be a directory`);
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const label = `${CHANGES_DIRECTORY}/${entry.name}`;
    if (!entry.isFile() || !CHANGE_FILE_NAME.test(entry.name)) {
      throw new Error(`${label} is not a change file (a regular lowercase-name.md file)`);
    }
    const path = resolve(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.nlink !== 1 || stat.size > MAX_CHANGE_BYTES) throw new Error(`${label} is not a change file (a regular lowercase-name.md file)`);
    files.push(parseChangeFile(entry.name, readFileSync(path, "utf8")));
  }
  return Object.freeze(files);
}

export function nextVersion(version, bump) {
  const [major, minor, patch] = parseReleaseVersion(`${version}\n`).split(".").map(BigInt);
  if (bump === "patch") return `${major}.${minor}.${patch + 1n}`;
  if (bump === "minor") return `${major}.${minor + 1n}.0`;
  if (bump === "major") return `${major + 1n}.0.0`;
  throw new Error(`Unknown bump ${bump}`);
}

export function computeRelease({ versions, changes }) {
  if (changes.length === 0) throw new Error("Release preparation found no change files in .changes");
  const bumps = new Map();
  const own = new Map();
  for (const change of changes) {
    for (const [id, bump] of Object.entries(change.units)) {
      if (bump === "none") continue;
      if (RANK[bump] > RANK[bumps.get(id) ?? "none"]) bumps.set(id, bump);
      own.set(id, [...(own.get(id) ?? []), Object.freeze({ type: change.type, text: change.body })]);
    }
  }
  if (bumps.size === 0) {
    throw new Error("Release preparation found no change file that releases a unit (every change file says none)");
  }
  for (const id of [...bumps.keys()]) {
    for (const dependent of dependentsOf(id)) if (!bumps.has(dependent)) bumps.set(dependent, "patch");
  }
  const targets = new Map([...bumps].map(([id, bump]) => {
    const from = versions.get(id);
    if (typeof from !== "string") throw new Error(`Release unit ${id} has no version`);
    return [id, nextVersion(from, bump)];
  }));
  const units = dependencyOrder([...bumps.keys()]).map((id) => {
    const updates = dependencyOrder(unitById(id).dependsOn.filter((dependency) => targets.has(dependency)))
      .map((dependency) => Object.freeze({ type: "changed", text: `Updated \`${dependency}\` to ${targets.get(dependency)}.` }));
    return Object.freeze({
      id,
      from: versions.get(id),
      to: targets.get(id),
      bump: bumps.get(id),
      cascaded: !own.has(id),
      entries: Object.freeze([...(own.get(id) ?? []), ...updates]),
    });
  });
  return Object.freeze({ units: Object.freeze(units), consumed: Object.freeze(changes.map(({ name }) => name).sort()) });
}
```

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/changes.test.mjs scripts/release/test/plan.test.mjs && pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit** (no bound input changed)

```bash
git add scripts/release/changes.mjs scripts/release/test/changes.test.mjs scripts/release/plan.mjs scripts/release/test/plan.test.mjs
git commit -m "feat(release): parse change files and compute bumps with cascade

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Owned paths and the required `changes` check

**Files:**
- Modify: `scripts/release/changes.mjs` (ownership, coverage, CLI), `scripts/release/units.mjs` (`skills.ownedPaths`, line ~103), `package.json` (`"release:changes": "node scripts/release/changes.mjs"` after `release:plan`), `.github/workflows/ci.yml` (new first job `changes`)
- Test: `scripts/release/test/changes.test.mjs`, `scripts/release/test/units.test.mjs`, `scripts/release/test/workflow-policy.test.mjs` (`JOBS` line 36, the CI test, the root-script test)
- Re-bind: `units.mjs` and `package.json` are bound

**Interfaces:**
- Consumes: `parseChangeFile`, `readChangeFiles`, `CHANGES_DIRECTORY` (Task 4); `RELEASE_PLAN_PATH`, `readReleasePlan` (`plan.mjs`); `RELEASE_UNITS`, `dependencyOrder`.
- Produces (exported from `changes.mjs`):
  - `isOwnedBy(unit, path: string): boolean`: a path is owned when it equals an exact owned path or starts with an owned `dir/**` prefix, unless it is a `README.md` or `CHANGELOG.md`, lies in a `test`, `tests` or `__tests__` directory, or is a `*.test.*`/`*.spec.*` file.
  - `parseNameStatus(output: string): readonly Readonly<{ status: "A"|"M"|"D"|"T"; path: string }>[]` (parses `git diff --name-status -z --no-renames`).
  - `evaluateChangeCoverage({ diff, changeFiles, plan = null }): Readonly<{ touched: string[]; covered: string[]; problems: string[] }>`: `touched` and `covered` in catalog/dependency order; a touched unit is covered by a change file added or modified in the diff (any bump, `none` included) or by the units of a `.release/plan.json` added or modified in the diff. Problem text: `<unit>: <first touched path> changed without a change file naming <unit>; add .changes/<name>.md (use "none" when no release is needed)`.
  - `parseChangesArguments(argv)`: `["--check"]` (base `origin/main`) or `["--check", "--base", REV]`.
  - `runChangesCli(argv, { root, git }): { exitCode, stdout, stderr }`: diff from `git merge-base <base> HEAD` to `HEAD`; stdout `{"base":…,"command":"check","covered":[…],"ok":…,"problems":[…],"touched":[…]}`; every change file present in `.changes` must parse (its error becomes a problem).
  - CI job `changes` (pull requests only): `pnpm release:changes --check --base "$BASE_SHA"` with `BASE_SHA: ${{ github.event.pull_request.base.sha }}`.

- [ ] **Step 1: Write the failing tests.** Add to `scripts/release/test/changes.test.mjs` (extend the imports with `spawnSync` from `node:child_process`, `readFileSync` from `node:fs`, `dirname` from `node:path`, `isOwnedBy` and `runChangesCli` from `../changes.mjs`, `createReleasePlan` and `serializeReleasePlan` from `../plan.mjs`):

```js
function git(root, ...args) {
  const result = spawnSync("git", [
    "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function changeSource(units, type = "fixed") {
  return `---\ntype: ${type}\nunits:\n${Object.entries(units).map(([id, bump]) => `  ${id}: ${bump}`).join("\n")}\n---\nA user-facing sentence.\n`;
}

function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-changes-check-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--initial-branch=main");
  write(root, "packages/protocol/src/index.ts", "export const a = 1;\n");
  write(root, "apps/server/package.json", "{}\n");
  write(root, ".changes/old.md", changeSource({ widget: "patch" }));
  git(root, "add", "-A");
  git(root, "commit", "-m", "base");
  git(root, "switch", "-c", "topic");
  return root;
}

function commit(root) {
  git(root, "add", "-A");
  git(root, "commit", "-m", "change");
}

function check(root) {
  const result = runChangesCli(["--check", "--base", "main"], { root });
  return { exitCode: result.exitCode, ...JSON.parse(result.stdout === "" ? result.stderr : result.stdout) };
}

test("ownership follows each unit's released paths and ignores READMEs, changelogs and tests", () => {
  const owners = (path) => RELEASE_UNITS.filter((unit) => isOwnedBy(unit, path)).map(({ id }) => id);
  assert.deepEqual(owners("packages/protocol/schemas/v1/run.json"), ["protocol"]);
  assert.deepEqual(owners("packages/typescript/core/src/index.ts"), ["typescript-core"]);
  assert.deepEqual(owners("packages/typescript/core/src/index.test.ts"), []);
  assert.deepEqual(owners("packages/java/core/src/test/java/X.java"), []);
  assert.deepEqual(owners("deploy/helm/gauntlet/values.yaml"), ["gauntlet"]);
  assert.deepEqual(owners("deploy/compose/test/wrapper.test.mjs"), []);
  assert.deepEqual(owners("deploy/compose/README.md"), []);
  assert.deepEqual(owners("skills/gauntlet-app-integration/references/node.md"), ["skills"]);
  assert.deepEqual(owners("skills/CHANGELOG.md"), []);
  assert.deepEqual(owners("skill-evals/gauntlet-app-integration/EVALUATING.md"), []);
  assert.deepEqual(owners("packages/protocol/srcx/a.ts"), []);
});

test("a pull request touching released paths needs a change file naming each touched unit", (t) => {
  const root = repository(t);
  write(root, "packages/protocol/src/index.ts", "export const a = 2;\n");
  commit(root);
  assert.deepEqual(check(root), {
    exitCode: 1, base: git(root, "rev-parse", "main"), command: "check", covered: [], ok: false, touched: ["protocol"],
    problems: ['protocol: packages/protocol/src/index.ts changed without a change file naming protocol; add .changes/<name>.md (use "none" when no release is needed)'],
  });
  write(root, ".changes/deadline.md", changeSource({ protocol: "minor" }, "added"));
  commit(root);
  const covered = check(root);
  assert.deepEqual([covered.exitCode, covered.covered, covered.problems], [0, ["protocol"], []]);
});

test("none covers a touched unit, and READMEs, changelogs and tests need no change file", (t) => {
  const root = repository(t);
  write(root, "packages/protocol/README.md", "# Protocol\n");
  write(root, "packages/protocol/CHANGELOG.md", "# Changelog\n");
  write(root, "packages/protocol/src/index.test.ts", "test\n");
  commit(root);
  assert.deepEqual([check(root).exitCode, check(root).touched], [0, []]);
  write(root, "packages/protocol/src/index.ts", "export const a = 3;\n");
  write(root, ".changes/refactor.md", changeSource({ protocol: "none" }, "changed"));
  commit(root);
  assert.equal(check(root).exitCode, 0);
});

test("a release pull request covers only its planned units, and deleting a change file covers nothing", (t) => {
  const deleting = repository(t);
  write(deleting, "packages/protocol/src/index.ts", "export const a = 4;\n");
  rmSync(join(deleting, ".changes/old.md"));
  commit(deleting);
  assert.deepEqual(check(deleting).touched, ["protocol"]);
  assert.equal(check(deleting).exitCode, 1);

  const release = repository(t);
  write(release, ".release/plan.json", serializeReleasePlan(createReleasePlan(
    [{ id: "gauntlet", from: "0.1.8", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }],
    { changes: ["old.md"] },
  )));
  write(release, "apps/server/package.json", '{"version":"0.1.9"}\n');
  rmSync(join(release, ".changes/old.md"));
  commit(release);
  assert.deepEqual([check(release).exitCode, check(release).covered], [0, ["gauntlet", "skills"]]);
  write(release, "packages/protocol/src/index.ts", "export const a = 5;\n");
  commit(release);
  const loophole = check(release);
  assert.equal(loophole.exitCode, 1);
  assert.deepEqual(loophole.problems.map((problem) => problem.split(":")[0]), ["protocol"]);
});

test("an invalid change file fails the check and arguments are closed", (t) => {
  const root = repository(t);
  write(root, ".changes/bad.md", "nonsense\n");
  commit(root);
  const result = check(root);
  assert.equal(result.exitCode, 1);
  assert.equal(result.problems.some((problem) => /Change file bad\.md/u.test(problem)), true);
  for (const argv of [[], ["--check", "--base"], ["--check", "--base", "-x"], ["--write"]]) {
    assert.equal(runChangesCli(argv, { root }).exitCode, 2, JSON.stringify(argv));
  }
  const missing = runChangesCli(["--check", "--base", "no-such-branch"], { root });
  assert.equal(missing.exitCode, 1);
  assert.match(JSON.parse(missing.stderr).error.message, /Cannot find the merge base of no-such-branch and HEAD/u);
});
```

Add to `scripts/release/test/units.test.mjs`:

```js
test("owned paths are exact files or whole directories, and skills owns only the released skill directories", () => {
  for (const unit of RELEASE_UNITS) {
    for (const path of unit.ownedPaths) {
      assert.match(path, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?:\/\*\*)?$/u, `${unit.id}: ${path}`);
    }
  }
  assert.deepEqual(unitById("skills").ownedPaths, ["skills/gauntlet-app-integration/**", "skills/gauntlet-extension-authoring/**"]);
});
```

In `scripts/release/test/workflow-policy.test.mjs`: add `"changes"` to `JOBS`; inside the CI test, after the runner/permission loop, add:

```js
  assert.equal(workflow.jobs.changes.if, "github.event_name == 'pull_request'");
  assert.equal(workflow.jobs.changes["timeout-minutes"], 10);
  const changesCheckout = workflow.jobs.changes.steps.find(({ uses }) => BLACKSMITH_CHECKOUT.test(uses ?? ""));
  assert.equal(changesCheckout.with["fetch-depth"], 0);
  const changesStep = workflow.jobs.changes.steps.find(
    ({ name }) => name === "Require a change file for every released unit a pull request touches",
  );
  assert.deepEqual(changesStep.env, { BASE_SHA: "${{ github.event.pull_request.base.sha }}" });
  assert.equal(changesStep.run, 'pnpm release:changes --check --base "$BASE_SHA"');
```

and in "every workflow-facing gate resolves to one exact local root script" add `"release:changes": "node scripts/release/changes.mjs",`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/changes.test.mjs scripts/release/test/units.test.mjs scripts/release/test/workflow-policy.test.mjs`
Expected: FAIL: `isOwnedBy` and `runChangesCli` are not exported, skills still owns `skill-evals/**`, the `changes` job is missing.

- [ ] **Step 3: Implement**

`units.mjs`: the `skills` entry's `ownedPaths` becomes `["skills/gauntlet-app-integration/**", "skills/gauntlet-extension-authoring/**"]` (skill evaluations are not released).

Append to `changes.mjs` (add `realpathSync` to the `node:fs` import, `spawnSync` from `node:child_process`, `fileURLToPath` from `node:url`, and `RELEASE_PLAN_PATH`, `readReleasePlan` to the `./plan.mjs` import):

```js
const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: changes.mjs --check [--base REV]";
const REVISION = /^(?!-)[A-Za-z0-9._/^~-]{1,200}$/u;
const UNRELEASED_PATHS = Object.freeze([
  /(?:^|\/)(?:README|CHANGELOG)\.md$/u,
  /(?:^|\/)(?:test|tests|__tests__)\//u,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
]);

export function isOwnedBy(unit, path) {
  if (UNRELEASED_PATHS.some((pattern) => pattern.test(path))) return false;
  return unit.ownedPaths.some((owned) => (owned.endsWith("/**") ? path.startsWith(owned.slice(0, -2)) : path === owned));
}

export function parseNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("git diff output is malformed");
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (!/^[ADMT]$/u.test(fields[index])) throw new Error(`Unsupported change status ${fields[index]}`);
    changes.push(Object.freeze({ status: fields[index], path: fields[index + 1] }));
  }
  return Object.freeze(changes);
}

export function evaluateChangeCoverage({ diff, changeFiles, plan = null }) {
  const touched = new Map();
  for (const unit of RELEASE_UNITS) {
    const owned = diff.find(({ path }) => isOwnedBy(unit, path));
    if (owned !== undefined) touched.set(unit.id, owned.path);
  }
  const covered = new Set(changeFiles.flatMap(({ units }) => Object.keys(units)));
  for (const { id } of plan?.units ?? []) covered.add(id);
  const problems = [...touched].filter(([id]) => !covered.has(id)).map(([id, path]) =>
    `${id}: ${path} changed without a change file naming ${id}; add .changes/<name>.md (use "none" when no release is needed)`);
  return Object.freeze({
    touched: Object.freeze([...touched.keys()]),
    covered: Object.freeze([...dependencyOrder([...covered])]),
    problems: Object.freeze(problems),
  });
}

export function parseChangesArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) throw new TypeError(USAGE);
  if (argv.length === 1 && argv[0] === "--check") return Object.freeze({ base: "origin/main" });
  if (argv.length === 3 && argv[0] === "--check" && argv[1] === "--base" && REVISION.test(argv[2])) {
    return Object.freeze({ base: argv[2] });
  }
  throw new TypeError(USAGE);
}

function defaultGit(root) {
  return (args) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/dev/null", LANG: "C", LC_ALL: "C" },
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function runChangesCli(argv, { root = ROOT, git = defaultGit(root) } = {}) {
  let options;
  try {
    options = parseChangesArguments(argv);
  } catch {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const mergeBase = git(["merge-base", options.base, "HEAD"]);
    const base = mergeBase.stdout.trim();
    if (mergeBase.status !== 0 || !/^[0-9a-f]{40}$/u.test(base)) {
      throw new Error(`Cannot find the merge base of ${options.base} and HEAD; fetch the base branch first`);
    }
    const listing = git(["diff", "--name-status", "-z", "--no-renames", base, "HEAD"]);
    if (listing.status !== 0) throw new Error("git diff failed");
    const diff = parseNameStatus(listing.stdout);
    const problems = [];
    try {
      readChangeFiles(root);
    } catch (error) {
      problems.push(error.message);
    }
    const changeFiles = [];
    for (const { status, path } of diff) {
      if (status === "D" || !path.startsWith(`${CHANGES_DIRECTORY}/`) || path.slice(CHANGES_DIRECTORY.length + 1).includes("/")) continue;
      const name = path.slice(CHANGES_DIRECTORY.length + 1);
      try {
        changeFiles.push(parseChangeFile(name, readFileSync(resolve(root, CHANGES_DIRECTORY, name), "utf8")));
      } catch (error) {
        if (!problems.includes(error.message)) problems.push(error.message);
      }
    }
    const planChanged = diff.some(({ status, path }) => path === RELEASE_PLAN_PATH && status !== "D");
    const coverage = evaluateChangeCoverage({ diff, changeFiles, plan: planChanged ? readReleasePlan(root) : null });
    problems.push(...coverage.problems);
    const ok = problems.length === 0;
    return {
      exitCode: ok ? 0 : 1,
      stdout: jsonLine({ base, command: "check", covered: coverage.covered, ok, problems, touched: coverage.touched }),
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "CHANGES_CHECK_FAILED", message: error instanceof Error ? error.message : String(error) }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runChangesCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
```

`.github/workflows/ci.yml`: insert as the first job under `jobs:`

```yaml
  changes:
    if: github.event_name == 'pull_request'
    runs-on: blacksmith-4vcpu-ubuntu-2404
    timeout-minutes: 10
    steps:
      - uses: useblacksmith/checkout@25227e61ff9dafe400e22fa487b673eac4e4409a # v1.8.1
        with:
          persist-credentials: false
          fetch-depth: 0
      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: "24.20.0"
          cache: pnpm
      - run: pnpm install --frozen-lockfile --package-import-method=copy
      - name: Require a change file for every released unit a pull request touches
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: pnpm release:changes --check --base "$BASE_SHA"
```

`package.json`: add `"release:changes": "node scripts/release/changes.mjs",` after `"release:plan"`.

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/changes.test.mjs scripts/release/test/units.test.mjs scripts/release/test/workflow-policy.test.mjs && pnpm release:test && pnpm release:changes --check --base origin/main`
Expected: PASS; the last command prints `"ok":true` with `"touched":[]` (this branch changes release tooling, docs, changelogs and evaluation records, none of which a unit releases). If it reports a touched unit, the branch changed released code: stop and report.

- [ ] **Step 5: Re-bind** (`units.mjs`, `package.json`): `pnpm skills:rebind --reason "Release units now declare only the paths they release, and the workspace gained release:changes." && pnpm skills:validate`.

- [ ] **Step 6: Commit**

```bash
git add scripts/release/changes.mjs scripts/release/units.mjs scripts/release/test/changes.test.mjs scripts/release/test/units.test.mjs scripts/release/test/workflow-policy.test.mjs package.json .github/workflows/ci.yml skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring
git commit -m "feat(release): require a change file for every touched unit in CI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Unit changelogs

**Files:**
- Create: `scripts/release/changelog.mjs`, the twelve unit `CHANGELOG.md` files listed in File Structure
- Test: `scripts/release/test/changelog.test.mjs`
- Modify: `scripts/release/release-set.mjs` (`changelogPath` ~127-130 and `changelogSection` ~132-139 move to `changelog.mjs`), `CHANGELOG.md` (intro, lines 1-4), `scripts/release/stage-composer.mjs` (`CONTRACTS` 38-47, `validateAllowedPath` 263-268), `scripts/release/test/stage-composer.test.mjs` (`createFixture` ~76-127)
- Re-bind: `stage-composer.mjs` and the bound package trees (`packages/protocol`, `packages/dashboard-client`, `packages/php/core`, `packages/php/symfony-bundle`, `packages/typescript/core`, `packages/typescript/node`) change

**Interfaces:**
- Consumes: `unitById`, `RELEASE_UNITS`.
- Produces (exported from `changelog.mjs`; `release-set.mjs` re-exports the first two so its callers keep working):
  - `changelogPath(unitId: string): string` (`gauntlet` → `CHANGELOG.md`; otherwise the version source's directory plus `/CHANGELOG.md`).
  - `changelogSection(source: string, version: string): string | null` (unchanged behaviour).
  - `CHANGE_SECTION_TITLES = { added: "Added", changed: "Changed", removed: "Removed", fixed: "Fixed", security: "Security" }`.
  - `renderChangelogSection({ version, date, entries }): string` (`## [version] - date`, then `### <Title>` groups in the order added, changed, removed, fixed, security, each `- <text>`; trailing LF; empty entries or a bad date → `Changelog section is invalid`).
  - `insertChangelogSection(source: string, section: string): string` (inserts below `## Unreleased`; errors `Changelog has no ## Unreleased heading`, `Changelog has entries under ## Unreleased; move them into change files`, `Changelog already has a section for <version>`).
  - `newUnitChangelog(unitId: string): string` (the initial text below; throws for `gauntlet`: `The gauntlet changelog is the root CHANGELOG.md`).
  - Composer staging accepts an optional `CHANGELOG.md` at a package root and ships it in the archive.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/changelog.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  changelogPath, changelogSection, insertChangelogSection, newUnitChangelog, renderChangelogSection,
} from "../changelog.mjs";
import { RELEASE_UNITS } from "../units.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

test("each unit has its own changelog path; the application keeps the root changelog", () => {
  assert.equal(changelogPath("gauntlet"), "CHANGELOG.md");
  assert.equal(changelogPath("typescript-core"), "packages/typescript/core/CHANGELOG.md");
  assert.equal(changelogPath("conformance-runner"), "conformance/runner/CHANGELOG.md");
  assert.equal(changelogPath("spring-boot-starter"), "packages/java/spring-boot-starter/CHANGELOG.md");
  assert.equal(changelogPath("skills"), "skills/CHANGELOG.md");
});

test("renders a Keep a Changelog section with types in the conventional order", () => {
  assert.equal(renderChangelogSection({ version: "0.2.0", date: "2026-10-04", entries: [
    { type: "fixed", text: "Fixed a thing." }, { type: "added", text: "Added a thing." },
    { type: "changed", text: "Updated `protocol` to 0.2.0." },
  ] }), "## [0.2.0] - 2026-10-04\n\n### Added\n\n- Added a thing.\n\n### Changed\n\n- Updated `protocol` to 0.2.0.\n\n### Fixed\n\n- Fixed a thing.\n");
  assert.throws(() => renderChangelogSection({ version: "0.2.0", date: "2026-10-04", entries: [] }), /Changelog section is invalid/u);
  assert.throws(() => renderChangelogSection({ version: "0.2.0", date: "04.10.2026", entries: [{ type: "fixed", text: "X." }] }), /Changelog section is invalid/u);
});

test("inserts the new section right below an empty Unreleased heading", () => {
  const section = renderChangelogSection({ version: "0.1.9", date: "2026-10-04", entries: [{ type: "fixed", text: "Fixed a thing." }] });
  const root = "# Changelog\n\nIntro.\n\n## Unreleased\n\n## [0.1.8] - 2026-10-03\n\n### Added\n\n- Old.\n";
  const next = insertChangelogSection(root, section);
  assert.equal(next, "# Changelog\n\nIntro.\n\n## Unreleased\n\n## [0.1.9] - 2026-10-04\n\n### Fixed\n\n- Fixed a thing.\n\n## [0.1.8] - 2026-10-03\n\n### Added\n\n- Old.\n");
  assert.equal(changelogSection(next, "0.1.9"), "### Fixed\n\n- Fixed a thing.");
  const fresh = newUnitChangelog("protocol");
  assert.equal(insertChangelogSection(fresh, section), `${fresh}\n${section}`);
});

test("refuses hand-written Unreleased entries, a missing Unreleased heading and an existing version section", () => {
  const section = renderChangelogSection({ version: "0.1.8", date: "2026-10-04", entries: [{ type: "fixed", text: "Fixed." }] });
  assert.throws(() => insertChangelogSection("# Changelog\n\n## Unreleased\n\n- Pending.\n", section), /entries under ## Unreleased; move them into change files/u);
  assert.throws(() => insertChangelogSection("# Changelog\n", section), /no ## Unreleased heading/u);
  assert.throws(() => insertChangelogSection("# Changelog\n\n## Unreleased\n\n## [0.1.8] - 2026-10-03\n\n- Old.\n", section), /already has a section for 0\.1\.8/u);
});

test("a new unit changelog names its artifacts and links the shared history", () => {
  assert.equal(newUnitChangelog("typescript-core"), [
    "# Changelog: `typescript-core`",
    "",
    "All notable changes to `@8lines/gauntlet-typescript-core` are recorded here in the",
    "[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow",
    "[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0 a breaking change is a minor",
    "release. Released versions are immutable; a correction is a new version.",
    "",
    "Releases up to 0.1.8 were published together with the application and are recorded in the",
    "[root changelog](../../../CHANGELOG.md).",
    "",
    "## Unreleased",
    "",
  ].join("\n"));
  assert.throws(() => newUnitChangelog("gauntlet"), /root CHANGELOG\.md/u);
});

test("every unit changelog exists with an Unreleased heading and is linked from the root changelog", () => {
  const root = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  assert.match(root, /^## Unreleased$/mu);
  for (const { id } of RELEASE_UNITS.filter(({ id: unit }) => unit !== "gauntlet")) {
    const path = changelogPath(id);
    const source = readFileSync(join(ROOT, path), "utf8");
    assert.equal(source.startsWith(newUnitChangelog(id).split("## Unreleased")[0]), true, path);
    assert.match(source, /^## Unreleased$/mu, path);
    assert.equal(root.includes(`[\`${id}\`](${path})`), true, `root changelog links ${path}`);
  }
});
```

In `scripts/release/test/stage-composer.test.mjs`, change `createFixture`'s signature to `function createFixture(version = "0.1.0", { bundleVersion = version, changelogs = false } = {})` and, before `runGit(root, ["init", …])`, add:

```js
  if (changelogs) {
    write(root, "packages/php/core/CHANGELOG.md", "# Changelog: 8lines/gauntlet-php-core\n\n## Unreleased\n");
    write(root, "packages/php/symfony-bundle/CHANGELOG.md", "# Changelog: 8lines/gauntlet-symfony-bundle\n\n## Unreleased\n");
  }
```

and add the test:

```js
test("stages the package changelog when the package has one", async () => {
  const fixture = createFixture("0.1.0", { changelogs: true });
  try {
    const artifacts = await stageComposerPackages({
      root: fixture.root, outputDirectory: fixture.output, sourceCommit: fixture.commit,
      versions: composerVersions("0.1.0"), include: COMPOSER_UNIT_IDS,
    });
    for (const artifact of artifacts) {
      assert.equal(readFileSync(resolve(artifact.path, "CHANGELOG.md"), "utf8"), `# Changelog: ${artifact.name}\n\n## Unreleased\n`);
    }
  } finally {
    fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/changelog.test.mjs scripts/release/test/stage-composer.test.mjs`
Expected: FAIL: `../changelog.mjs` is missing and Composer staging fails closed on `CHANGELOG.md`.

- [ ] **Step 3: Implement `scripts/release/changelog.mjs`**

```js
import { posix } from "node:path";

import { unitById } from "./units.mjs";

const UNRELEASED = "## Unreleased";
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
export const CHANGE_SECTION_TITLES = Object.freeze({
  added: "Added", changed: "Changed", removed: "Removed", fixed: "Fixed", security: "Security",
});
// Keep a Changelog order (Deprecated is not a change type).
const SECTION_ORDER = Object.freeze(["added", "changed", "removed", "fixed", "security"]);

export function changelogPath(unitId) {
  const unit = unitById(unitId);
  return unit.id === "gauntlet" ? "CHANGELOG.md" : `${posix.dirname(unit.version.path)}/CHANGELOG.md`;
}

export function changelogSection(source, version) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `## [${version}]` || line.startsWith(`## [${version}] `));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end).join("\n").trim();
  return body === "" ? null : body;
}

export function renderChangelogSection({ version, date, entries }) {
  if (typeof version !== "string" || typeof date !== "string" || !DATE.test(date) || !Array.isArray(entries)
      || entries.length === 0 || entries.some(({ type, text }) => !SECTION_ORDER.includes(type) || typeof text !== "string" || text === "")) {
    throw new Error("Changelog section is invalid");
  }
  const lines = [`## [${version}] - ${date}`];
  for (const type of SECTION_ORDER) {
    const texts = entries.filter((entry) => entry.type === type).map(({ text }) => text);
    if (texts.length > 0) lines.push("", `### ${CHANGE_SECTION_TITLES[type]}`, "", ...texts.map((text) => `- ${text}`));
  }
  return `${lines.join("\n")}\n`;
}

export function insertChangelogSection(source, section) {
  const lines = source.split("\n");
  const index = lines.indexOf(UNRELEASED);
  if (index < 0) throw new Error("Changelog has no ## Unreleased heading");
  const next = lines.findIndex((line, position) => position > index && line.startsWith("## "));
  if (lines.slice(index + 1, next < 0 ? lines.length : next).join("\n").trim() !== "") {
    throw new Error("Changelog has entries under ## Unreleased; move them into change files");
  }
  const version = /^## \[([^\]]+)\]/u.exec(section)?.[1];
  if (version === undefined) throw new Error("Changelog section is invalid");
  if (lines.some((line) => line === `## [${version}]` || line.startsWith(`## [${version}] `))) {
    throw new Error(`Changelog already has a section for ${version}`);
  }
  const head = lines.slice(0, index + 1).join("\n");
  const tail = next < 0 ? "" : lines.slice(next).join("\n");
  return `${head}\n\n${section}${tail === "" ? "" : `\n${tail}`}`;
}

export function newUnitChangelog(unitId) {
  const unit = unitById(unitId);
  if (unit.id === "gauntlet") throw new Error("The gauntlet changelog is the root CHANGELOG.md");
  const path = changelogPath(unit.id);
  return [
    `# Changelog: \`${unit.id}\``,
    "",
    `All notable changes to ${unit.artifacts.map((name) => `\`${name}\``).join(", ")} are recorded here in the`,
    "[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow",
    "[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0 a breaking change is a minor",
    "release. Released versions are immutable; a correction is a new version.",
    "",
    "Releases up to 0.1.8 were published together with the application and are recorded in the",
    `[root changelog](${posix.relative(posix.dirname(path), "CHANGELOG.md")}).`,
    "",
    UNRELEASED,
    "",
  ].join("\n");
}
```

`release-set.mjs`: delete the local `changelogPath` and `changelogSection`, add `import { changelogPath, changelogSection } from "./changelog.mjs";` and `export { changelogPath, changelogSection } from "./changelog.mjs";`, and drop `dirname` from the `node:path` import if nothing else uses it.

`stage-composer.mjs`: add `optional: Object.freeze(["CHANGELOG.md"])` to both `CONTRACTS` entries and make `validateAllowedPath` return `true` for `contract.optional.includes(path)` right after the `required` check.

Create the unit changelogs:

```bash
node --input-type=module -e 'import { writeFileSync } from "node:fs"; import { RELEASE_UNITS } from "./scripts/release/units.mjs"; import { changelogPath, newUnitChangelog } from "./scripts/release/changelog.mjs"; for (const { id } of RELEASE_UNITS) if (id !== "gauntlet") writeFileSync(changelogPath(id), newUnitChangelog(id), { flag: "wx" });'
```

Root `CHANGELOG.md`: after the line "All notable changes to this project are recorded here. Released artifacts are immutable; corrections receive a new semantic version." insert a blank line and:

```markdown
This is the changelog of the `gauntlet` application unit: the server, the
dashboard and widget panel, the container image, the Helm chart and the
Compose distribution. Up to 0.1.8 every package was released together with the
application and is recorded here. Each other release unit has its own
changelog: [`protocol`](packages/protocol/CHANGELOG.md),
[`dashboard-client`](packages/dashboard-client/CHANGELOG.md),
[`typescript-core`](packages/typescript/core/CHANGELOG.md),
[`typescript-node`](packages/typescript/node/CHANGELOG.md),
[`next-adapter`](packages/typescript/next/CHANGELOG.md),
[`conformance-runner`](conformance/runner/CHANGELOG.md),
[`widget`](packages/widget/CHANGELOG.md),
[`php-core`](packages/php/core/CHANGELOG.md),
[`symfony-bundle`](packages/php/symfony-bundle/CHANGELOG.md),
[`java-core`](packages/java/core/CHANGELOG.md),
[`spring-boot-starter`](packages/java/spring-boot-starter/CHANGELOG.md) and
[`skills`](skills/CHANGELOG.md).
```

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/changelog.test.mjs scripts/release/test/stage-composer.test.mjs scripts/release/test/release-set.test.mjs && pnpm release:test && node scripts/docs/check-docs.mjs && pnpm skills:test-install`
Expected: PASS; check-docs `{"ok":true}` (it verifies the root changelog's new links).

- [ ] **Step 5: Re-bind**: `pnpm skills:rebind --reason "Each release unit gained its own changelog, and Composer archives carry it." && pnpm skills:validate`.

- [ ] **Step 6: Commit**

```bash
git add scripts/release/changelog.mjs scripts/release/test/changelog.test.mjs scripts/release/release-set.mjs scripts/release/stage-composer.mjs scripts/release/test/stage-composer.test.mjs CHANGELOG.md packages/protocol/CHANGELOG.md packages/dashboard-client/CHANGELOG.md packages/typescript/core/CHANGELOG.md packages/typescript/node/CHANGELOG.md packages/typescript/next/CHANGELOG.md conformance/runner/CHANGELOG.md packages/widget/CHANGELOG.md packages/php/core/CHANGELOG.md packages/php/symfony-bundle/CHANGELOG.md packages/java/core/CHANGELOG.md packages/java/spring-boot-starter/CHANGELOG.md skills/CHANGELOG.md skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring
git commit -m "feat(release): give every release unit its own changelog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Compatibility ledger, plan rejection and the release-note line

**Files:**
- Create: `scripts/release/compatibility.mjs`, `docs/reference/compatibility.md` (generated)
- Test: `scripts/release/test/compatibility.test.mjs`
- Modify: `scripts/release/plan.mjs` (`runPlanCli` `--check` branch ~340-355), `scripts/release/test/plan.test.mjs` (the three `--check` calls at lines ~202, 209, 219, plus a new test), `scripts/release/release-set.mjs` (`releaseNotes` ~141-146, the `notes` branch of `runReleaseSetCli` ~293-300), `scripts/release/test/release-set.test.mjs` (`scratchDirectory` ~112-116, the notes tests ~84-93, ~184-201), `scripts/docs/check-docs.mjs` (`checkDocumentation`), `docs/documentation-manifest.json` (`requiredFiles`), `docs/README.md` (reference table ~54-57), `docs/releases/installing-packages.md` ("Current versions" section)

**Interfaces:**
- Consumes: `RELEASE_UNITS` and their `contracts` (`units.mjs`); `ReleasePlan` (`plan.mjs`).
- Produces (exported from `compatibility.mjs`, which imports only `units.mjs` and Node built-ins):
  - `COMPATIBILITY_PATH = "docs/reference/compatibility.md"`.
  - `CompatibilityEntry = Readonly<{ id: string; version: string; implements: Readonly<Record<string, number>>; supports: Readonly<Record<string, readonly number[]>> }>`.
  - `catalogEntry(unit, version): CompatibilityEntry`; `catalogEntries(versions: ReadonlyMap<string,string>, catalog = RELEASE_UNITS): readonly CompatibilityEntry[]`.
  - `renderCompatibilityDocument(entries): string`; `parseCompatibilityDocument(source): readonly CompatibilityEntry[]` (exact generated header, one row per catalog unit in catalog order, else `Compatibility document is invalid`); `readCompatibilityDocument(root): readonly CompatibilityEntry[]`.
  - `updateCompatibilityEntries(recorded, plan, catalog = RELEASE_UNITS)`: planned units take the catalog contracts at their `to` version; every other row is kept as recorded.
  - `compatibilityProblems(plan, recorded, catalog = RELEASE_UNITS): string[]`: the released application is `gauntlet` from the catalog when planned, else its recorded row; problems `gauntlet: its supported contracts changed without a gauntlet release`, `<unit>: its implemented contracts changed without a <unit> release`, `<unit>: implements <contract> <major>, which gauntlet <version> does not support` (every unit is checked: planned units with catalog contracts, the others with their recorded contracts).
  - `compatibilityLine(unitId, entries): string`.
  - `compatibilityDocumentProblems(source, versions): string[]` (`docs/reference/compatibility.md is not a generated compatibility document`, `docs/reference/compatibility.md: <unit> is recorded at <x> but its manifest version is <y>`).
  - `runPlanCli(argv, { root, readVersions, readTags, readCompatibility = readCompatibilityDocument })`: `--check` appends `compatibilityProblems(plan, readCompatibility(root))`, or `compatibility: docs/reference/compatibility.md is missing or invalid`.
  - `releaseNotes({ changelog, compatibility, releaseSet })`: text is `<changelog>\n\n<compatibility>\n\nRelease set \`<set>\`.\n` (mode `changelog`) or `<compatibility>\n\nRelease set \`<set>\`.\n` (mode `generated`); the `notes` command reads the line from the ledger at the release commit and fails with `Compatibility document records <unit> <x>, not the released <y>` when the row is stale.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/compatibility.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  COMPATIBILITY_PATH, catalogEntries, compatibilityDocumentProblems, compatibilityLine, compatibilityProblems,
  parseCompatibilityDocument, renderCompatibilityDocument, updateCompatibilityEntries,
} from "../compatibility.mjs";
import { createReleasePlan } from "../plan.mjs";
import { readUnitVersions } from "../release-model.mjs";
import { RELEASE_UNITS } from "../units.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const VERSIONS = new Map(RELEASE_UNITS.map(({ id }) => [id, "0.1.8"]));
const LEDGER = catalogEntries(VERSIONS);
const plan = (...units) => createReleasePlan(units.map(([id, to]) => ({ id, from: "0.1.8", to })));
const withContracts = (changes) => RELEASE_UNITS.map((unit) => (Object.hasOwn(changes, unit.id) ? { ...unit, contracts: changes[unit.id] } : unit));

test("renders and parses the generated ledger", () => {
  const source = renderCompatibilityDocument(LEDGER);
  assert.match(source, /^\| `gauntlet` \| 0\.1\.8 \| none \| protocol 1; widgetChannel 1 \|$/mu);
  assert.match(source, /^\| `protocol` \| 0\.1\.8 \| protocol 1 \| none \|$/mu);
  assert.match(source, /^\| `widget` \| 0\.1\.8 \| none \| none \|$/mu);
  assert.deepEqual(parseCompatibilityDocument(source), LEDGER);
  for (const broken of [
    source.replace("| `protocol` | 0.1.8 |", "| `protocol` | 0.1 |"),
    source.replace(/^\| `skills`.*\n/mu, ""),
    source.replace("# Compatibility", "# Compat"),
  ]) assert.throws(() => parseCompatibilityDocument(broken), /Compatibility document is invalid/u);
});

test("a planned unit takes the catalog contracts; unplanned rows keep what was released", () => {
  const recorded = LEDGER.map((entry) => (entry.id === "widget" ? { ...entry, implements: { widgetHost: 1 } } : entry));
  const next = updateCompatibilityEntries(recorded, plan(["protocol", "0.2.0"]));
  assert.equal(next.find(({ id }) => id === "protocol").version, "0.2.0");
  assert.deepEqual(next.find(({ id }) => id === "widget").implements, { widgetHost: 1 });
});

test("rejects a plan whose package implements a protocol major the released application does not support", () => {
  const protocolTwo = withContracts({ "typescript-core": { implements: { protocol: 2 } } });
  assert.deepEqual(compatibilityProblems(plan(["typescript-core", "0.2.0"]), LEDGER, protocolTwo), [
    "typescript-core: implements protocol 2, which gauntlet 0.1.8 does not support",
  ]);
  const both = withContracts({
    "typescript-core": { implements: { protocol: 2 } },
    gauntlet: { supports: { protocol: [1, 2], widgetChannel: [1] } },
  });
  assert.deepEqual(compatibilityProblems(plan(["gauntlet", "0.2.0"], ["typescript-core", "0.2.0"]), LEDGER, both), []);
  assert.deepEqual(compatibilityProblems(plan(["typescript-core", "0.2.0"]), LEDGER, both), [
    "gauntlet: its supported contracts changed without a gauntlet release",
    "typescript-core: implements protocol 2, which gauntlet 0.1.8 does not support",
  ]);
  assert.deepEqual(compatibilityProblems(plan(["widget", "0.1.9"]), LEDGER, protocolTwo), [
    "typescript-core: its implemented contracts changed without a typescript-core release",
  ]);
  const dropsOne = withContracts({ gauntlet: { supports: { protocol: [2], widgetChannel: [1] } } });
  assert.equal(compatibilityProblems(plan(["gauntlet", "1.0.0"]), LEDGER, dropsOne)
    .includes("php-core: implements protocol 1, which gauntlet 1.0.0 does not support"), true);
});

test("states one compatibility line per released unit", () => {
  const ledger = updateCompatibilityEntries(LEDGER, plan(["gauntlet", "0.1.9"], ["protocol", "0.2.0"]));
  assert.equal(compatibilityLine("gauntlet", ledger), "Compatibility: Gauntlet 0.1.9 supports adapter protocol 1 and widget channel 1.");
  assert.equal(compatibilityLine("protocol", ledger),
    "Compatibility: protocol 0.2.0 implements adapter protocol 1; Gauntlet 0.1.9 supports adapter protocol 1 and widget channel 1.");
  assert.equal(compatibilityLine("widget", ledger), "Compatibility: widget 0.1.8 has no versioned runtime contract with the application.");
});

test("the committed ledger must record every unit at its manifest version", () => {
  const source = renderCompatibilityDocument(LEDGER);
  assert.deepEqual(compatibilityDocumentProblems(source, VERSIONS), []);
  assert.deepEqual(compatibilityDocumentProblems(source, new Map([...VERSIONS, ["widget", "0.1.9"]])), [
    "docs/reference/compatibility.md: widget is recorded at 0.1.8 but its manifest version is 0.1.9",
  ]);
  assert.deepEqual(compatibilityDocumentProblems("# Other\n", VERSIONS), ["docs/reference/compatibility.md is not a generated compatibility document"]);
  assert.deepEqual(compatibilityDocumentProblems(readFileSync(join(ROOT, COMPATIBILITY_PATH), "utf8"), readUnitVersions(ROOT)), []);
});
```

In `scripts/release/test/plan.test.mjs`: import `catalogEntries` from `../compatibility.mjs`; in "the plan CLI writes the computed plan and checks a committed one" add `const readCompatibility = () => catalogEntries(versionsAt("0.1.8"));` and pass `readCompatibility` in its three `--check` calls (`checked`, `drifted`, `empty`; run `grep -n '"--check"' scripts/release/test/plan.test.mjs` and add it to any other call that expects exit 0 or a `problems` list). Add:

```js
test("plan --check rejects a plan the released application cannot serve, and a missing ledger", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-plan-compatibility-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".release"));
  writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(createReleasePlan([{ id: "typescript-core", from: "0.1.8", to: "0.1.9" }])));
  const options = { root, readVersions: () => versionsAt("0.1.8", { "typescript-core": "0.1.9" }), readTags: () => baselineTags() };
  const narrowed = () => catalogEntries(versionsAt("0.1.8")).map((entry) => (entry.id === "gauntlet"
    ? { ...entry, supports: { protocol: [2], widgetChannel: [1] } } : entry));
  const rejected = runPlanCli(["--check"], { ...options, readCompatibility: narrowed });
  assert.equal(rejected.exitCode, 1);
  // The released application (its recorded row, since gauntlet is not planned) supports only protocol 2,
  // so the planned typescript-core and every recorded protocol 1 package are rejected, in catalog order.
  assert.deepEqual(JSON.parse(rejected.stdout).problems, [
    "gauntlet: its supported contracts changed without a gauntlet release",
    ...["protocol", "dashboard-client", "typescript-core", "typescript-node", "next-adapter", "conformance-runner",
      "php-core", "symfony-bundle", "java-core", "spring-boot-starter"]
      .map((id) => `${id}: implements protocol 1, which gauntlet 0.1.8 does not support`),
  ]);
  const missing = runPlanCli(["--check"], { ...options, readCompatibility: () => { throw new Error("absent"); } });
  assert.deepEqual(JSON.parse(missing.stdout).problems, ["compatibility: docs/reference/compatibility.md is missing or invalid"]);
});
```

In `scripts/release/test/release-set.test.mjs`: import `COMPATIBILITY_PATH`, `catalogEntries`, `renderCompatibilityDocument` from `../compatibility.mjs` and `RELEASE_UNITS` from `../units.mjs`; `scratchDirectory` also writes the ledger:

```js
function scratchDirectory(t) {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-release-set-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(resolve(directory, "docs/reference"), { recursive: true });
  writeFileSync(resolve(directory, COMPATIBILITY_PATH),
    renderCompatibilityDocument(catalogEntries(new Map(RELEASE_UNITS.map(({ id }) => [id, "0.1.0"])))));
  return directory;
}

const SKILLS_LINE = "Compatibility: skills 0.1.0 has no versioned runtime contract with the application.";
```

Replace the `releaseNotes` assertions of "notes use the unit changelog section when present and name the release set" with:

```js
  const compatibility = "Compatibility: protocol 0.1.9 implements adapter protocol 1; Gauntlet 0.1.9 supports adapter protocol 1 and widget channel 1.";
  assert.deepEqual(releaseNotes({ changelog: "### Fixed\n\n- A thing.", compatibility, releaseSet: "release-2026-10-03.1" }), {
    mode: "changelog", text: `### Fixed\n\n- A thing.\n\n${compatibility}\n\nRelease set \`release-2026-10-03.1\`.\n`,
  });
  assert.deepEqual(releaseNotes({ changelog: null, compatibility, releaseSet: "release-2026-10-03.1" }), {
    mode: "generated", text: `${compatibility}\n\nRelease set \`release-2026-10-03.1\`.\n`,
  });
```

In "notes fall back to generated mode…", the two expected texts become `` `${SKILLS_LINE}\n\nRelease set \`${SET}\`.\n` `` and `` `- First.\n\n${SKILLS_LINE}\n\nRelease set \`${SET}\`.\n` ``. Add:

```js
test("notes refuse a ledger row that does not record the released version", (t) => {
  const { root } = releaseFixture(t, [{ id: "skills", version: "0.1.0" }]);
  const repository = scratchDirectory(t);
  writeFileSync(resolve(repository, COMPATIBILITY_PATH),
    renderCompatibilityDocument(catalogEntries(new Map(RELEASE_UNITS.map(({ id }) => [id, "0.0.9"])))));
  const result = runReleaseSetCli(["notes", "--release-directory", root, "--unit", "skills", "--output", resolve(repository, "n.md")], { root: repository });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.message, "Compatibility document records skills 0.0.9, not the released 0.1.0");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/compatibility.test.mjs scripts/release/test/plan.test.mjs scripts/release/test/release-set.test.mjs`
Expected: FAIL with `Cannot find module` for `../compatibility.mjs`.

- [ ] **Step 3: Implement `scripts/release/compatibility.mjs`**

```js
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { RELEASE_UNITS } from "./units.mjs";

export const COMPATIBILITY_PATH = "docs/reference/compatibility.md";
const INVALID = "Compatibility document is invalid";
const MAX_BYTES = 256 * 1024;
const CONTRACT_NAMES = Object.freeze({ protocol: "adapter protocol", widgetChannel: "widget channel" });
const HEADER = Object.freeze([
  "# Compatibility",
  "",
  "<!-- Generated by pnpm release:prepare from scripts/release/units.mjs. Do not edit by hand. -->",
  "",
  "The application and the packages agree on versioned runtime contracts: the",
  "adapter protocol major (`protocolVersion` 1.x, checked by `dashboard-client`)",
  "with its profiles and capabilities (`tc-*@1`), and the widget channel",
  "(`WIDGET_CHANNEL_VERSION`). Each row records a unit's current released version",
  "and the contract majors it implements; the `gauntlet` row records the majors",
  "the application supports. A package works with an application release that",
  "supports every major the package implements. Release preparation rewrites the",
  "rows of the units it releases and rejects a plan that would break this rule.",
  "",
  "| Unit | Version | Implements | Supports |",
  "| --- | --- | --- | --- |",
].join("\n"));
const ROW = /^\| `([a-z0-9-]+)` \| (\d+\.\d+\.\d+) \| ([^|]+) \| ([^|]+) \|$/u;

const freezeSupports = (supports) => Object.freeze(Object.fromEntries(
  Object.entries(supports).map(([contract, majors]) => [contract, Object.freeze([...majors])]),
));
const sameContracts = (left, right) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

export function catalogEntry(unit, version) {
  return Object.freeze({
    id: unit.id,
    version,
    implements: Object.freeze({ ...(unit.contracts.implements ?? {}) }),
    supports: freezeSupports(unit.contracts.supports ?? {}),
  });
}

export function catalogEntries(versions, catalog = RELEASE_UNITS) {
  return Object.freeze(catalog.map((unit) => catalogEntry(unit, versions.get(unit.id))));
}

const formatImplements = (map) => (Object.keys(map).length === 0 ? "none" : Object.entries(map).map(([key, major]) => `${key} ${major}`).join("; "));
const formatSupports = (map) => (Object.keys(map).length === 0 ? "none" : Object.entries(map).map(([key, majors]) => `${key} ${majors.join(", ")}`).join("; "));

function parseCell(cell, multiple) {
  if (cell === "none") return {};
  return Object.fromEntries(cell.split("; ").map((part) => {
    const match = (multiple ? /^([A-Za-z]+) ([1-9][0-9]*(?:, [1-9][0-9]*)*)$/u : /^([A-Za-z]+) ([1-9][0-9]*)$/u).exec(part);
    if (match === null) throw new Error(INVALID);
    return [match[1], multiple ? match[2].split(", ").map(Number) : Number(match[2])];
  }));
}

export function renderCompatibilityDocument(entries) {
  const rows = entries.map(({ id, version, implements: implemented, supports }) =>
    `| \`${id}\` | ${version} | ${formatImplements(implemented)} | ${formatSupports(supports)} |`);
  return `${HEADER}\n${rows.join("\n")}\n`;
}

export function parseCompatibilityDocument(source) {
  if (typeof source !== "string" || !source.startsWith(`${HEADER}\n`) || !source.endsWith("\n")) throw new Error(INVALID);
  const rows = source.slice(HEADER.length + 1, -1).split("\n");
  if (rows.length !== RELEASE_UNITS.length) throw new Error(INVALID);
  return Object.freeze(rows.map((row, index) => {
    const match = ROW.exec(row);
    if (match === null || match[1] !== RELEASE_UNITS[index].id) throw new Error(INVALID);
    return Object.freeze({
      id: match[1],
      version: match[2],
      implements: Object.freeze(parseCell(match[3], false)),
      supports: freezeSupports(parseCell(match[4], true)),
    });
  }));
}

export function readCompatibilityDocument(root) {
  const path = resolve(root, COMPATIBILITY_PATH);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(INVALID);
  return parseCompatibilityDocument(readFileSync(path, "utf8"));
}

export function updateCompatibilityEntries(recorded, plan, catalog = RELEASE_UNITS) {
  const planned = new Map(plan.units.map(({ id, to }) => [id, to]));
  return Object.freeze(catalog.map((unit) => {
    if (planned.has(unit.id)) return catalogEntry(unit, planned.get(unit.id));
    const row = recorded.find(({ id }) => id === unit.id);
    if (row === undefined) throw new Error(INVALID);
    return row;
  }));
}

export function compatibilityProblems(plan, recorded, catalog = RELEASE_UNITS) {
  const problems = [];
  const planned = new Map(plan.units.map(({ id, to }) => [id, to]));
  const rows = new Map(recorded.map((entry) => [entry.id, entry]));
  const application = catalog.find(({ id }) => id === "gauntlet");
  const releasedApplication = rows.get("gauntlet");
  if (application === undefined || releasedApplication === undefined) throw new Error(INVALID);
  let supports = releasedApplication.supports;
  let applicationVersion = releasedApplication.version;
  if (planned.has("gauntlet")) {
    supports = application.contracts.supports ?? {};
    applicationVersion = planned.get("gauntlet");
  } else if (!sameContracts(application.contracts.supports ?? {}, releasedApplication.supports)) {
    problems.push("gauntlet: its supported contracts changed without a gauntlet release");
  }
  for (const unit of catalog) {
    if (unit.id === "gauntlet") continue;
    const row = rows.get(unit.id);
    if (row === undefined) throw new Error(INVALID);
    let implemented = unit.contracts.implements ?? {};
    if (!planned.has(unit.id)) {
      if (!sameContracts(implemented, row.implements)) problems.push(`${unit.id}: its implemented contracts changed without a ${unit.id} release`);
      implemented = row.implements;
    }
    for (const [contract, major] of Object.entries(implemented)) {
      if (!(supports[contract] ?? []).includes(major)) {
        problems.push(`${unit.id}: implements ${contract} ${major}, which gauntlet ${applicationVersion} does not support`);
      }
    }
  }
  return problems;
}

const describe = (contract, majors) => `${CONTRACT_NAMES[contract] ?? contract} ${majors.join(", ")}`;

export function compatibilityLine(unitId, entries) {
  const entry = entries.find(({ id }) => id === unitId);
  const application = entries.find(({ id }) => id === "gauntlet");
  if (entry === undefined || application === undefined) throw new Error(INVALID);
  const supported = Object.entries(application.supports).map(([contract, majors]) => describe(contract, majors)).join(" and ");
  if (unitId === "gauntlet") return `Compatibility: Gauntlet ${entry.version} supports ${supported}.`;
  const implemented = Object.entries(entry.implements).map(([contract, major]) => describe(contract, [major]));
  if (implemented.length === 0) return `Compatibility: ${unitId} ${entry.version} has no versioned runtime contract with the application.`;
  return `Compatibility: ${unitId} ${entry.version} implements ${implemented.join(" and ")}; Gauntlet ${application.version} supports ${supported}.`;
}

export function compatibilityDocumentProblems(source, versions) {
  let entries;
  try {
    entries = parseCompatibilityDocument(source);
  } catch {
    return [`${COMPATIBILITY_PATH} is not a generated compatibility document`];
  }
  return entries.filter(({ id, version }) => versions.get(id) !== version)
    .map(({ id, version }) => `${COMPATIBILITY_PATH}: ${id} is recorded at ${version} but its manifest version is ${versions.get(id)}`);
}
```

`plan.mjs`: `import { COMPATIBILITY_PATH, compatibilityProblems, readCompatibilityDocument } from "./compatibility.mjs";`; add `readCompatibility = readCompatibilityDocument` to the `runPlanCli` options; in the `check` branch, after the tag problems:

```js
    let compatibility;
    try {
      compatibility = compatibilityProblems(plan, readCompatibility(root));
    } catch {
      compatibility = [`compatibility: ${COMPATIBILITY_PATH} is missing or invalid`];
    }
    const problems = [
      ...(plan.units.length === 0 ? ["release plan has no units"] : []),
      ...validatePlanAgainstManifests(plan, versions),
      ...validatePlanAgainstTags(plan, { versions, tags, commit: command.commit }),
      ...compatibility,
    ];
```

`release-set.mjs`: `import { compatibilityLine, readCompatibilityDocument } from "./compatibility.mjs";`

```js
export function releaseNotes({ changelog, compatibility, releaseSet }) {
  const tail = `${compatibility}\n\nRelease set \`${releaseSet}\`.\n`;
  return changelog === null
    ? Object.freeze({ mode: "generated", text: tail })
    : Object.freeze({ mode: "changelog", text: `${changelog}\n\n${tail}` });
}

function unitCompatibility(root, unitId, version) {
  let entries;
  try {
    entries = readCompatibilityDocument(root);
  } catch {
    throw new Error(READ_FAILURE);
  }
  const entry = entries.find(({ id }) => id === unitId);
  if (entry.version !== version) throw new Error(`Compatibility document records ${unitId} ${entry.version}, not the released ${version}`);
  return compatibilityLine(unitId, entries);
}
```

and the `notes` branch becomes:

```js
        const { version } = manifestUnit(manifest, unitId);
        const notes = releaseNotes({
          changelog: unitChangelog(root, unitId, version),
          compatibility: unitCompatibility(root, unitId, version),
          releaseSet: manifest.releaseSet,
        });
```

Generate the ledger, then wire the docs:

```bash
node --input-type=module -e 'import { writeFileSync } from "node:fs"; import { COMPATIBILITY_PATH, catalogEntries, renderCompatibilityDocument } from "./scripts/release/compatibility.mjs"; import { readUnitVersions } from "./scripts/release/release-model.mjs"; writeFileSync(COMPATIBILITY_PATH, renderCompatibilityDocument(catalogEntries(readUnitVersions(process.cwd()))), { flag: "wx" });'
```

- `docs/documentation-manifest.json`: add `"docs/reference/compatibility.md"` to `requiredFiles` after `"docs/reference/control-plane-api.md"`.
- `scripts/docs/check-docs.mjs`: `import { COMPATIBILITY_PATH, compatibilityDocumentProblems } from "../release/compatibility.mjs";` and, after the per-document loop, `if (versions !== undefined && versions.size === RELEASE_UNITS.length && documents.has(COMPATIBILITY_PATH)) errors.push(...compatibilityDocumentProblems(documents.get(COMPATIBILITY_PATH), versions));`.
- `docs/README.md` reference table: add the row `| Which package versions work with which application release | [Compatibility](reference/compatibility.md) |` after the protocol model row.
- `docs/releases/installing-packages.md`, "Current versions": after "`pnpm release:prepare` keeps this table\ncurrent." add the sentence "Which package versions work with which application release is listed in\n[compatibility](../reference/compatibility.md)."

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/compatibility.test.mjs scripts/release/test/plan.test.mjs scripts/release/test/release-set.test.mjs && pnpm release:test && node --test scripts/docs/test/*.test.mjs && node scripts/docs/check-docs.mjs`
Expected: PASS; check-docs `{"ok":true}`.

- [ ] **Step 5: Commit** (no bound input changed)

```bash
git add scripts/release/compatibility.mjs scripts/release/test/compatibility.test.mjs scripts/release/plan.mjs scripts/release/test/plan.test.mjs scripts/release/release-set.mjs scripts/release/test/release-set.test.mjs scripts/docs/check-docs.mjs docs/reference/compatibility.md docs/documentation-manifest.json docs/README.md docs/releases/installing-packages.md
git commit -m "feat(release): generate the compatibility ledger, reject incompatible plans and state compatibility in release notes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Composer lock re-pinning through the pinned image

**Files:**
- Create: `scripts/release/composer-locks.mjs`
- Test: `scripts/release/test/composer-locks.test.mjs`

**Interfaces:**
- Consumes: `COMPOSER_IMAGE` (`scripts/release/test-php-compatibility.mjs`).
- Produces (exported from `composer-locks.mjs`):
  - `COMPOSER_LOCKS`: frozen `[{ directory: "packages/php/core", units: ["php-core"], packages: [] }, { directory: "packages/php/symfony-bundle", units: ["php-core", "symfony-bundle"], packages: ["8lines/gauntlet-php-core"] }, { directory: "examples/symfony", units: ["php-core", "symfony-bundle"], packages: ["8lines/gauntlet-php-core", "8lines/gauntlet-symfony-bundle"] }]`. A lock is re-pinned when any of its `units` is released; its content hash covers the owner's `composer.json` (version and constraints), and the listed path packages are locked with a version and a dist reference.
  - `pathRepositoryReference(manifestBytes: Buffer): string`: Composer's path-repository reference, `sha1(composer.json bytes + 'a:2:{s:7:"symlink";b:0;s:8:"relative";b:1;}')` (the serialized `symlink: false` and `relative: true` options).
  - `composerUpdateArguments({ root, directory, packages, uid, gid }): string[]`: `docker run` arguments: read-only root file system, all capabilities dropped, `no-new-privileges`, bridge network (Packagist metadata), the caller's uid and gid, private `/tmp`, the repository bind-mounted at `/workspace`, working directory `/workspace/<directory>`, then `composer update <packages…>` (`--lock` when no package is listed) with `--no-install --no-scripts --no-plugins --no-audit --no-progress --ignore-platform-reqs`.
  - `verifyComposerLockUpdate({ before, after, expected }): void`: throws `Composer changed the lock beyond the Gauntlet path packages` unless only `content-hash` (32 hex) and, for each expected path package, its `version`, `dist.reference` and (bundle) `require["8lines/gauntlet-php-core"]` changed.
  - `repinComposerLocks({ root, versions: ReadonlyMap<string,string>, moved: readonly string[], run = runDocker }): string[]`: re-pins the locks of moved units in `COMPOSER_LOCKS` order and returns the changed lock paths; a failed run throws `Composer could not re-pin <directory>/composer.lock`.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/composer-locks.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { composerUpdateArguments, pathRepositoryReference, repinComposerLocks } from "../composer-locks.mjs";
import { COMPOSER_IMAGE } from "../test-php-compatibility.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const CORE = "8lines/gauntlet-php-core";
const BUNDLE = "8lines/gauntlet-symfony-bundle";
const THIRD_PARTY = Object.freeze({ name: "opis/json-schema", version: "2.6.0", dist: { type: "zip", url: "https://example.invalid/opis.zip", reference: "abc" } });
const json = (value) => `${JSON.stringify(value, null, 4)}\n`;

function lockFile(contentHash, packages) {
  return json({
    _readme: ["generated"], "content-hash": contentHash, packages, "packages-dev": [], aliases: [],
    "minimum-stability": "stable", "stability-flags": {}, "prefer-stable": false, "prefer-lowest": false,
    platform: { php: ">=8.3" }, "platform-dev": {}, "plugin-api-version": "2.6.0",
  });
}

function pathEntry(name, version, url, manifest, require = {}) {
  return { name, version, dist: { type: "path", url, reference: pathRepositoryReference(manifest) }, require, "transport-options": { symlink: false, relative: true } };
}

function writeManifests(root, version) {
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("packages/php/core/composer.json", json({ name: CORE, version }));
  write("packages/php/symfony-bundle/composer.json", json({ name: BUNDLE, version, require: { [CORE]: `^${version}` } }));
  write("examples/symfony/composer.json", json({ name: "8lines/gauntlet-symfony-example", require: { [CORE]: `^${version}`, [BUNDLE]: `^${version}` } }));
  return write;
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-composer-locks-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = writeManifests(root, "0.1.8");
  const core = readFileSync(join(root, "packages/php/core/composer.json"));
  const bundle = readFileSync(join(root, "packages/php/symfony-bundle/composer.json"));
  write("packages/php/core/composer.lock", lockFile("0".repeat(32), [THIRD_PARTY]));
  write("packages/php/symfony-bundle/composer.lock", lockFile("1".repeat(32), [pathEntry(CORE, "0.1.8", "../core", core), THIRD_PARTY]));
  write("examples/symfony/composer.lock", lockFile("2".repeat(32), [
    pathEntry(CORE, "0.1.8", "../../packages/php/core", core),
    pathEntry(BUNDLE, "0.1.8", "../../packages/php/symfony-bundle", bundle, { [CORE]: "^0.1.8" }),
    THIRD_PARTY,
  ]));
  writeManifests(root, "0.1.9");
  return root;
}

// Simulates `composer update` in the container: it relocks the path packages from their manifests.
function fakeComposer(root, { tamper = false, status = 0 } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (status !== 0) return { status, stdout: "", stderr: "network unreachable" };
    const directory = args[args.indexOf("--workdir") + 1].slice("/workspace/".length);
    const lockPath = join(root, directory, "composer.lock");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const manifest = (path) => readFileSync(join(root, path));
    const bundle = JSON.parse(manifest("packages/php/symfony-bundle/composer.json"));
    lock["content-hash"] = "f".repeat(32);
    for (const entry of lock.packages) {
      if (entry.name === CORE) {
        entry.version = JSON.parse(manifest("packages/php/core/composer.json")).version;
        entry.dist.reference = pathRepositoryReference(manifest("packages/php/core/composer.json"));
      }
      if (entry.name === BUNDLE) {
        entry.version = bundle.version;
        entry.dist.reference = pathRepositoryReference(manifest("packages/php/symfony-bundle/composer.json"));
        entry.require[CORE] = bundle.require[CORE];
      }
      if (tamper && entry.name === "opis/json-schema") entry.version = "2.7.0";
    }
    writeFileSync(lockPath, json(lock));
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const VERSIONS = new Map([["php-core", "0.1.9"], ["symfony-bundle", "0.1.9"]]);

test("the path-repository reference matches the one Composer recorded in the repository", () => {
  assert.equal(
    pathRepositoryReference(Buffer.from("{}\n")),
    createHash("sha1").update('{}\na:2:{s:7:"symlink";b:0;s:8:"relative";b:1;}').digest("hex"),
  );
  const lock = JSON.parse(readFileSync(join(ROOT, "packages/php/symfony-bundle/composer.lock"), "utf8"));
  assert.equal(
    lock.packages.find(({ name }) => name === CORE).dist.reference,
    pathRepositoryReference(readFileSync(join(ROOT, "packages/php/core/composer.json"))),
  );
});

test("Composer runs in the pinned image with a read-only root and writes only through the repository mount", () => {
  assert.deepEqual(composerUpdateArguments({ root: "/repo", directory: "examples/symfony", packages: [CORE, BUNDLE], uid: 501, gid: 20 }), [
    "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", "bridge", "--user", "501:20",
    "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
    "--env", "COMPOSER_CACHE_DIR=/tmp/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
    "--mount", "type=bind,src=/repo,dst=/workspace",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777",
    "--workdir", "/workspace/examples/symfony",
    COMPOSER_IMAGE,
    "composer", "update", CORE, BUNDLE,
    "--no-install", "--no-scripts", "--no-plugins", "--no-audit", "--no-progress", "--ignore-platform-reqs",
  ]);
  assert.deepEqual(
    composerUpdateArguments({ root: "/repo", directory: "packages/php/core", packages: [], uid: 0, gid: 0 }).slice(-9, -6),
    ["composer", "update", "--lock"],
  );
  for (const bad of [{ root: "relative", directory: "x" }, { root: "/repo,x", directory: "x" }, { root: "/repo", directory: "../x" }]) {
    assert.throws(() => composerUpdateArguments({ ...bad, packages: [], uid: 0, gid: 0 }), /Composer lock target is invalid/u);
  }
});

test("a php-core release re-pins all three locks and verifies them", (t) => {
  const root = fixture(t);
  const composer = fakeComposer(root);
  assert.deepEqual(repinComposerLocks({ root, versions: VERSIONS, moved: ["php-core", "symfony-bundle", "skills"], run: composer.run }), [
    "packages/php/core/composer.lock", "packages/php/symfony-bundle/composer.lock", "examples/symfony/composer.lock",
  ]);
  assert.deepEqual(composer.calls.map((args) => args[args.indexOf("--workdir") + 1]), [
    "/workspace/packages/php/core", "/workspace/packages/php/symfony-bundle", "/workspace/examples/symfony",
  ]);
  const example = JSON.parse(readFileSync(join(root, "examples/symfony/composer.lock"), "utf8"));
  assert.deepEqual(example.packages.map(({ name, version }) => [name, version]), [[CORE, "0.1.9"], [BUNDLE, "0.1.9"], ["opis/json-schema", "2.6.0"]]);
});

test("a release without PHP units runs no Composer, and a bundle-only release skips the core lock", (t) => {
  const root = fixture(t);
  assert.deepEqual(repinComposerLocks({ root, versions: VERSIONS, moved: ["gauntlet", "skills"], run: () => assert.fail("Composer must not run") }), []);
  const composer = fakeComposer(root);
  repinComposerLocks({ root, versions: VERSIONS, moved: ["symfony-bundle", "skills"], run: composer.run });
  assert.deepEqual(composer.calls.map((args) => args[args.indexOf("--workdir") + 1]), [
    "/workspace/packages/php/symfony-bundle", "/workspace/examples/symfony",
  ]);
});

test("a lock change beyond the Gauntlet path packages or a failed Composer run aborts", (t) => {
  const tampered = fixture(t);
  assert.throws(
    () => repinComposerLocks({ root: tampered, versions: VERSIONS, moved: ["php-core"], run: fakeComposer(tampered, { tamper: true }).run }),
    /Composer changed the lock beyond the Gauntlet path packages/u,
  );
  const offline = fixture(t);
  assert.throws(
    () => repinComposerLocks({ root: offline, versions: VERSIONS, moved: ["php-core"], run: fakeComposer(offline, { status: 1 }).run }),
    /Composer could not re-pin packages\/php\/core\/composer\.lock/u,
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/composer-locks.test.mjs`
Expected: FAIL with `Cannot find module` for `../composer-locks.mjs`.

- [ ] **Step 3: Implement `scripts/release/composer-locks.mjs`**

```js
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { COMPOSER_IMAGE } from "./test-php-compatibility.mjs";

const CORE = "8lines/gauntlet-php-core";
const BUNDLE = "8lines/gauntlet-symfony-bundle";
// PHP serialization of Composer's path-repository options { symlink: false, relative: true }.
const PATH_OPTIONS = 'a:2:{s:7:"symlink";b:0;s:8:"relative";b:1;}';
const LOCK_CHANGED = "Composer changed the lock beyond the Gauntlet path packages";
const DIRECTORY = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u;

export const COMPOSER_LOCKS = Object.freeze([
  Object.freeze({ directory: "packages/php/core", units: Object.freeze(["php-core"]), packages: Object.freeze([]) }),
  Object.freeze({ directory: "packages/php/symfony-bundle", units: Object.freeze(["php-core", "symfony-bundle"]), packages: Object.freeze([CORE]) }),
  Object.freeze({ directory: "examples/symfony", units: Object.freeze(["php-core", "symfony-bundle"]), packages: Object.freeze([CORE, BUNDLE]) }),
]);
const SOURCES = Object.freeze({
  [CORE]: Object.freeze({ unit: "php-core", manifest: "packages/php/core/composer.json" }),
  [BUNDLE]: Object.freeze({ unit: "symfony-bundle", manifest: "packages/php/symfony-bundle/composer.json" }),
});

export function pathRepositoryReference(manifestBytes) {
  return createHash("sha1").update(manifestBytes).update(PATH_OPTIONS, "latin1").digest("hex");
}

export function composerUpdateArguments({ root, directory, packages, uid, gid }) {
  if (typeof root !== "string" || !isAbsolute(root) || root.includes(",") || root.includes("\0")
      || typeof directory !== "string" || !DIRECTORY.test(directory)
      || !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("Composer lock target is invalid");
  }
  return [
    "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", "bridge", "--user", `${uid}:${gid}`,
    "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
    "--env", "COMPOSER_CACHE_DIR=/tmp/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
    "--mount", `type=bind,src=${root},dst=/workspace`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777",
    "--workdir", `/workspace/${directory}`,
    COMPOSER_IMAGE,
    "composer", "update", ...(packages.length === 0 ? ["--lock"] : packages),
    "--no-install", "--no-scripts", "--no-plugins", "--no-audit", "--no-progress", "--ignore-platform-reqs",
  ];
}

export function verifyComposerLockUpdate({ before, after, expected }) {
  let left;
  let right;
  try {
    left = JSON.parse(before);
    right = JSON.parse(after);
  } catch {
    throw new Error(LOCK_CHANGED);
  }
  if (JSON.stringify(Object.keys(left)) !== JSON.stringify(Object.keys(right))) throw new Error(LOCK_CHANGED);
  for (const key of Object.keys(left)) {
    if (key === "content-hash") {
      if (typeof right[key] !== "string" || !/^[0-9a-f]{32}$/u.test(right[key])) throw new Error(LOCK_CHANGED);
    } else if (key !== "packages" && key !== "packages-dev" && !isDeepStrictEqual(left[key], right[key])) {
      throw new Error(LOCK_CHANGED);
    }
  }
  for (const list of ["packages", "packages-dev"]) {
    const previous = left[list] ?? [];
    const next = right[list] ?? [];
    if (previous.length !== next.length) throw new Error(LOCK_CHANGED);
    previous.forEach((entry, index) => {
      if (entry?.name !== next[index]?.name) throw new Error(LOCK_CHANGED);
      const want = expected.get(entry.name);
      const projected = want === undefined ? entry : {
        ...entry,
        version: want.version,
        dist: { ...entry.dist, reference: want.reference },
        ...(want.require === undefined ? {} : { require: { ...entry.require, ...want.require } }),
      };
      if (!isDeepStrictEqual(projected, next[index])) throw new Error(LOCK_CHANGED);
    });
  }
  for (const name of expected.keys()) {
    if (!(left.packages ?? []).some((entry) => entry.name === name)) throw new Error(LOCK_CHANGED);
  }
}

function expectedPackages(root, versions, names) {
  return new Map(names.map((name) => {
    const { unit, manifest } = SOURCES[name];
    return [name, {
      version: versions.get(unit),
      reference: pathRepositoryReference(readFileSync(resolve(root, manifest))),
      ...(name === BUNDLE ? { require: { [CORE]: `^${versions.get("php-core")}` } } : {}),
    }];
  }));
}

function runDocker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? "/dev/null",
      ...(process.env.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: process.env.DOCKER_HOST }),
    },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function repinComposerLocks({ root, versions, moved, run = runDocker }) {
  const released = new Set(moved);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const changed = [];
  for (const target of COMPOSER_LOCKS.filter(({ units }) => units.some((unit) => released.has(unit)))) {
    const path = `${target.directory}/composer.lock`;
    const before = readFileSync(resolve(root, path), "utf8");
    const result = run(composerUpdateArguments({ root, directory: target.directory, packages: target.packages, uid, gid }));
    if (result.status !== 0) throw new Error(`Composer could not re-pin ${path}`);
    const after = readFileSync(resolve(root, path), "utf8");
    verifyComposerLockUpdate({ before, after, expected: expectedPackages(root, versions, target.packages) });
    if (after !== before) changed.push(path);
  }
  return changed;
}
```

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/composer-locks.test.mjs && pnpm release:test`
Expected: PASS. The real Docker path is exercised in Task 11 (PHP rehearsal).

- [ ] **Step 5: Commit**

```bash
git add scripts/release/composer-locks.mjs scripts/release/test/composer-locks.test.mjs
git commit -m "feat(release): re-pin Composer locks through the pinned composer:2 image

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `pnpm release:prepare`

**Files:**
- Create: `scripts/release/prepare.mjs`
- Test: `scripts/release/test/prepare.test.mjs`
- Modify: `package.json` (`"release:prepare": "node scripts/release/prepare.mjs"` after `release:plan`), `scripts/release/test/workflow-policy.test.mjs` (root-script test)
- Re-bind: `package.json` is bound

**Interfaces:**
- Consumes: `CHANGES_DIRECTORY`, `readChangeFiles`, `computeRelease` (Task 4); `changelogPath`, `insertChangelogSection`, `renderChangelogSection`, `newUnitChangelog` (Task 6); `COMPATIBILITY_PATH`, `readCompatibilityDocument`, `compatibilityProblems`, `updateCompatibilityEntries`, `renderCompatibilityDocument`, `catalogEntries` (Task 7); `repinComposerLocks` (Task 8); `rebindEvaluations` (Task 1); `RELEASE_PLAN_PATH`, `buildReleasePlan`, `createReleasePlan`, `latestUnitVersion`, `readRepositoryTags`, `serializeReleasePlan`, `writeReleasePlan`, `parseReleasePlan` (`plan.mjs`); `setUnitVersions`, `readUnitVersions`, `readUnitVersion`, `collectUnitVersionMismatches` (`release-model.mjs`); `createVersionFixture` (Task 2).
- Produces (exported from `prepare.mjs`):
  - `assertVersionsAtLatestTags(versions, tags): void` (error starts `Release preparation needs every unit at its latest tag; run git fetch --tags origin, and release an already prepared plan first:` followed by `<unit> has no release tag` / `<unit> is at X but its latest tag is Y` items).
  - `prepareRelease({ root, now, git, readTags, repinComposer, rebind }): Promise<PrepareSummary>` where `PrepareSummary = Readonly<{ command: "prepare"; ok: true; date: string; units: { id, from, to, bump, cascaded }[]; order: string[]; changes: string[]; composerLocks: string[] }>`. Refusals (nothing written): on `main` (`Prepare a release on a branch from main, not on main`), modified tracked files (`Tracked files have local modifications; …`), uncommitted change files (`Commit every change file before preparing a release`), inconsistent slots, units off their latest tag, no change files, only `none`, an incompatible plan (`Release plan is incompatible: …`). Any later failure restores every tracked file (`git restore --source=HEAD --worktree -- .`), removes the plan file and `.release` directory it created, and rethrows.
  - `runPrepareCli(argv, dependencies): Promise<{ exitCode, stdout, stderr }>`: `[]` only; stdout is the summary as one JSON line; failure exit 1 with `{"error":{"code":"PREPARE_FAILED","message":…},"ok":false}`.
  - The re-binding reason is `Release preparation moved <id> to <to>, <id> to <to>.` in plan order.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/prepare.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { changelogPath, newUnitChangelog } from "../changelog.mjs";
import { COMPATIBILITY_PATH, catalogEntries, renderCompatibilityDocument } from "../compatibility.mjs";
import { parseReleasePlan } from "../plan.mjs";
import { prepareRelease, runPrepareCli } from "../prepare.mjs";
import { readUnitVersion } from "../release-model.mjs";
import { RELEASE_UNITS, unitTag } from "../units.mjs";
import { createVersionFixture } from "./version-fixture.mjs";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const TAGGED = "e".repeat(40);

function git(root, ...args) {
  const result = spawnSync("git", [
    "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function baselineTags(version = "0.1.8", skip = []) {
  return new Map(RELEASE_UNITS.filter(({ id }) => !skip.includes(id)).map((unit) => [unitTag(unit, version), TAGGED]));
}

function change(units, type = "fixed", body = "Sidebar keeps its width.") {
  return `---\ntype: ${type}\nunits:\n${Object.entries(units).map(([id, bump]) => `  ${id}: ${bump}`).join("\n")}\n---\n${body}\n`;
}

function repository(t, changes) {
  const root = createVersionFixture("0.1.8");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## [0.1.8] - 2026-10-03\n\n### Fixed\n\n- Baseline.\n");
  for (const { id } of RELEASE_UNITS) if (id !== "gauntlet") writeFileSync(join(root, changelogPath(id)), newUnitChangelog(id));
  mkdirSync(join(root, "docs/reference"), { recursive: true });
  writeFileSync(join(root, COMPATIBILITY_PATH), renderCompatibilityDocument(catalogEntries(new Map(RELEASE_UNITS.map(({ id }) => [id, "0.1.8"])))));
  mkdirSync(join(root, ".changes"));
  for (const [name, source] of Object.entries(changes)) writeFileSync(join(root, ".changes", name), source);
  git(root, "init", "--initial-branch=main");
  git(root, "add", "-A");
  git(root, "commit", "-m", "baseline");
  git(root, "switch", "-c", "release/next");
  return root;
}

function recorder() {
  const calls = { repin: [], rebind: [] };
  return {
    calls,
    repinComposer: ({ moved, versions }) => {
      calls.repin.push({ moved: [...moved], versions: Object.fromEntries(versions) });
      return [];
    },
    rebind: async ({ reason, date }) => {
      calls.rebind.push({ reason, date });
      return { skills: [] };
    },
  };
}

function status(root) {
  return git(root, "status", "--porcelain=v1", "--untracked-files=all");
}

test("a dashboard-only change prepares the application and the skills archive with no hand edits", async (t) => {
  const root = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  const { calls, repinComposer, rebind } = recorder();
  const summary = await prepareRelease({ root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.deepEqual(summary, {
    command: "prepare", ok: true, date: "2026-10-04",
    units: [
      { id: "gauntlet", from: "0.1.8", to: "0.1.9", bump: "patch", cascaded: false },
      { id: "skills", from: "0.1.8", to: "0.1.9", bump: "patch", cascaded: true },
    ],
    order: ["gauntlet", "skills"], changes: ["sidebar.md"], composerLocks: [],
  });
  assert.equal(readUnitVersion(root, "gauntlet"), "0.1.9");
  assert.equal(readUnitVersion(root, "skills"), "0.1.9");
  assert.equal(readUnitVersion(root, "protocol"), "0.1.8");
  assert.match(readFileSync(join(root, "deploy/helm/README.md"), "utf8"), /--version 0\.1\.9 --destination/u);
  assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    /## Unreleased\n\n## \[0\.1\.9\] - 2026-10-04\n\n### Fixed\n\n- Sidebar keeps its width\.\n\n## \[0\.1\.8\]/u);
  assert.match(readFileSync(join(root, "skills/CHANGELOG.md"), "utf8"),
    /## \[0\.1\.9\] - 2026-10-04\n\n### Changed\n\n- Updated `gauntlet` to 0\.1\.9\.\n$/u);
  assert.equal(existsSync(join(root, ".changes/sidebar.md")), false);
  assert.deepEqual(parseReleasePlan(readFileSync(join(root, ".release/plan.json"), "utf8")), {
    schemaVersion: 1,
    units: [{ id: "gauntlet", from: "0.1.8", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }],
    order: ["gauntlet", "skills"],
    changes: ["sidebar.md"],
  });
  assert.match(readFileSync(join(root, COMPATIBILITY_PATH), "utf8"), /^\| `gauntlet` \| 0\.1\.9 \|/mu);
  assert.deepEqual(calls.repin.map(({ moved }) => moved), [["gauntlet", "skills"]]);
  assert.deepEqual(calls.rebind, [{ reason: "Release preparation moved gauntlet to 0.1.9, skills to 0.1.9.", date: "2026-10-04" }]);
});

test("a protocol minor release cascades through every dependent in one prepared plan", async (t) => {
  const root = repository(t, { "deadline.md": change({ protocol: "minor" }, "added", "Run requests accept an optional deadline.") });
  const { repinComposer, rebind } = recorder();
  const summary = await prepareRelease({ root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.deepEqual(summary.units.map(({ id, to }) => [id, to]), [
    ["protocol", "0.2.0"], ["dashboard-client", "0.1.9"], ["gauntlet", "0.1.9"], ["typescript-core", "0.1.9"],
    ["typescript-node", "0.1.9"], ["next-adapter", "0.1.9"], ["conformance-runner", "0.1.9"], ["skills", "0.1.9"],
  ]);
  assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    /### Changed\n\n- Updated `protocol` to 0\.2\.0\.\n- Updated `dashboard-client` to 0\.1\.9\.\n/u);
  assert.match(readFileSync(join(root, "packages/protocol/CHANGELOG.md"), "utf8"),
    /## \[0\.2\.0\] - 2026-10-04\n\n### Added\n\n- Run requests accept an optional deadline\.\n/u);
  assert.match(readFileSync(join(root, "docs/releases/installing-packages.md"), "utf8"), /pnpm add @8lines\/gauntlet-protocol@0\.2\.0 /u);
  assert.equal(readUnitVersion(root, "php-core"), "0.1.8");
});

test("a php-core release re-pins Composer and moves the bundle and its constraint", async (t) => {
  const root = repository(t, { "timeouts.md": change({ "php-core": "patch" }, "fixed", "PHP Core reports adapter timeouts with the request id.") });
  const { calls, repinComposer, rebind } = recorder();
  const summary = await prepareRelease({ root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.deepEqual(summary.order, ["php-core", "symfony-bundle", "skills"]);
  assert.deepEqual(calls.repin.map(({ moved }) => moved), [["php-core", "symfony-bundle", "skills"]]);
  assert.equal(calls.repin[0].versions["php-core"], "0.1.9");
  const bundle = JSON.parse(readFileSync(join(root, "packages/php/symfony-bundle/composer.json"), "utf8"));
  assert.deepEqual([bundle.version, bundle.require["8lines/gauntlet-php-core"]], ["0.1.9", "^0.1.9"]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "examples/symfony/composer.json"), "utf8")).require, {
    "8lines/gauntlet-php-core": "^0.1.9", "8lines/gauntlet-symfony-bundle": "^0.1.9",
  });
});

test("refuses unsafe starting points and leaves the tree untouched", async (t) => {
  const { repinComposer, rebind } = recorder();
  const prepare = (root, readTags = () => baselineTags()) => prepareRelease({ root, now: NOW, readTags, repinComposer, rebind });

  const empty = repository(t, {});
  await assert.rejects(prepare(empty), /found no change files in \.changes/u);
  assert.equal(status(empty), "");

  const noneOnly = repository(t, { "refactor.md": change({ protocol: "none" }, "changed", "Reformatted sources.") });
  await assert.rejects(prepare(noneOnly), /no change file that releases a unit/u);
  assert.equal(existsSync(join(noneOnly, ".changes/refactor.md")), true);

  const stale = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  await assert.rejects(prepare(stale, () => baselineTags("0.1.8", ["protocol"])), /run git fetch --tags origin.*protocol has no release tag/u);
  const behind = new Map([...baselineTags("0.1.8", ["gauntlet"]), ["v0.1.7", TAGGED]]);
  await assert.rejects(prepare(stale, () => behind), /gauntlet is at 0\.1\.8 but its latest tag is 0\.1\.7/u);
  assert.equal(status(stale), "");

  const dirty = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  writeFileSync(join(dirty, "deploy/helm/README.md"), "local edit\n");
  await assert.rejects(prepare(dirty), /Tracked files have local modifications/u);
  assert.equal(readFileSync(join(dirty, "deploy/helm/README.md"), "utf8"), "local edit\n");

  const uncommitted = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  writeFileSync(join(uncommitted, ".changes/late.md"), change({ widget: "patch" }));
  await assert.rejects(prepare(uncommitted), /Commit every change file/u);

  const onMain = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  git(onMain, "switch", "main");
  await assert.rejects(prepare(onMain), /on a branch from main/u);
});

test("a failure after the first write restores every tracked file and keeps the change files", async (t) => {
  const root = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  await assert.rejects(prepareRelease({
    root, now: NOW, readTags: () => baselineTags(), repinComposer: () => [],
    rebind: async () => {
      throw new Error("Evaluation receipts could not be re-bound: injected");
    },
  }), /injected/u);
  assert.equal(status(root), "");
  assert.equal(existsSync(join(root, ".changes/sidebar.md")), true);
  assert.equal(existsSync(join(root, ".release")), false);
  assert.equal(readUnitVersion(root, "gauntlet"), "0.1.8");
});

test("the CLI takes no arguments and prints one JSON summary", async (t) => {
  const root = repository(t, { "sidebar.md": change({ widget: "patch" }, "fixed", "The widget button keeps focus.") });
  const { repinComposer, rebind } = recorder();
  assert.equal((await runPrepareCli(["--dry-run"])).exitCode, 2);
  const result = await runPrepareCli([], { root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.split("\n").length, 2);
  assert.deepEqual(JSON.parse(result.stdout).order, ["widget"]);
});
```

In `workflow-policy.test.mjs`, "every workflow-facing gate resolves to one exact local root script": add `"release:prepare": "node scripts/release/prepare.mjs",`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/prepare.test.mjs`
Expected: FAIL with `Cannot find module` for `../prepare.mjs`.

- [ ] **Step 3: Implement `scripts/release/prepare.mjs`**

```js
#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rebindEvaluations } from "../skills/rebind.mjs";
import { CHANGES_DIRECTORY, computeRelease, readChangeFiles } from "./changes.mjs";
import { changelogPath, insertChangelogSection, renderChangelogSection } from "./changelog.mjs";
import {
  COMPATIBILITY_PATH, compatibilityProblems, readCompatibilityDocument, renderCompatibilityDocument, updateCompatibilityEntries,
} from "./compatibility.mjs";
import { repinComposerLocks } from "./composer-locks.mjs";
import {
  RELEASE_PLAN_PATH, buildReleasePlan, createReleasePlan, latestUnitVersion, readRepositoryTags, serializeReleasePlan,
  writeReleasePlan,
} from "./plan.mjs";
import { collectUnitVersionMismatches, readUnitVersions, setUnitVersions } from "./release-model.mjs";
import { RELEASE_UNITS } from "./units.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: prepare.mjs";

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function defaultGit(root) {
  return (args) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/dev/null", LANG: "C", LC_ALL: "C" },
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function assertPreparable(git) {
  const tracked = git(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (tracked.status !== 0 || tracked.stdout !== "") {
    throw new Error("Tracked files have local modifications; commit or stash them before preparing a release");
  }
  const changes = git(["status", "--porcelain=v1", "--untracked-files=all", "--", CHANGES_DIRECTORY]);
  if (changes.status !== 0 || changes.stdout !== "") throw new Error("Commit every change file before preparing a release");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status !== 0 || branch.stdout.trim() === "main") throw new Error("Prepare a release on a branch from main, not on main");
}

export function assertVersionsAtLatestTags(versions, tags) {
  const problems = [];
  for (const { id } of RELEASE_UNITS) {
    const latest = latestUnitVersion(id, tags);
    if (latest === null) problems.push(`${id} has no release tag`);
    else if (latest !== versions.get(id)) problems.push(`${id} is at ${versions.get(id)} but its latest tag is ${latest}`);
  }
  if (problems.length > 0) {
    throw new Error(`Release preparation needs every unit at its latest tag; run git fetch --tags origin, and release an already prepared plan first: ${problems.join("; ")}`);
  }
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function restore(git, root, created) {
  git(["restore", "--source=HEAD", "--worktree", "--", "."]);
  for (const path of [...created].reverse()) {
    try {
      const absolute = resolve(root, path);
      if (lstatSync(absolute).isDirectory()) rmdirSync(absolute);
      else unlinkSync(absolute);
    } catch {
      // Already absent.
    }
  }
}

function verifyPrepared(root, plan, tags) {
  const mismatches = collectUnitVersionMismatches(root);
  if (mismatches.length > 0) throw new Error(`Prepared version slots are inconsistent: ${mismatches.join("; ")}`);
  if (serializeReleasePlan(buildReleasePlan(readUnitVersions(root), tags)) !== serializeReleasePlan(createReleasePlan(plan.units))) {
    throw new Error("Prepared manifests do not match the release plan");
  }
  if (readChangeFiles(root).length > 0) throw new Error("Change files remain after preparation");
}

export async function prepareRelease({
  root = ROOT,
  now = new Date(),
  git = defaultGit(root),
  readTags = readRepositoryTags,
  repinComposer = repinComposerLocks,
  rebind = rebindEvaluations,
} = {}) {
  assertPreparable(git);
  const mismatches = collectUnitVersionMismatches(root);
  if (mismatches.length > 0) throw new Error(`Release version slots are inconsistent; fix them first: ${mismatches.join("; ")}`);
  const versions = readUnitVersions(root);
  const tags = readTags(root);
  assertVersionsAtLatestTags(versions, tags);
  const release = computeRelease({ versions, changes: readChangeFiles(root) });
  const plan = createReleasePlan(release.units.map(({ id, from, to }) => ({ id, from, to })), { changes: release.consumed });
  const recorded = readCompatibilityDocument(root);
  const incompatible = compatibilityProblems(plan, recorded);
  if (incompatible.length > 0) throw new Error(`Release plan is incompatible: ${incompatible.join("; ")}`);
  const date = now.toISOString().slice(0, 10);
  const created = [];
  try {
    setUnitVersions(root, new Map(release.units.map(({ id, to }) => [id, to])));
    const composerLocks = await repinComposer({ root, versions: readUnitVersions(root), moved: release.units.map(({ id }) => id) });
    for (const unit of release.units) {
      const path = resolve(root, changelogPath(unit.id));
      writeFileSync(path, insertChangelogSection(readFileSync(path, "utf8"),
        renderChangelogSection({ version: unit.to, date, entries: unit.entries })));
    }
    writeFileSync(resolve(root, COMPATIBILITY_PATH), renderCompatibilityDocument(updateCompatibilityEntries(recorded, plan)));
    for (const name of release.consumed) unlinkSync(resolve(root, CHANGES_DIRECTORY, name));
    if (!exists(resolve(root, ".release"))) created.push(".release");
    if (!exists(resolve(root, RELEASE_PLAN_PATH))) created.push(RELEASE_PLAN_PATH);
    writeReleasePlan(root, plan);
    await rebind({
      root,
      reason: `Release preparation moved ${plan.units.map(({ id, to }) => `${id} to ${to}`).join(", ")}.`,
      date,
    });
    verifyPrepared(root, plan, tags);
    return Object.freeze({
      command: "prepare",
      ok: true,
      date,
      units: release.units.map(({ id, from, to, bump, cascaded }) => ({ id, from, to, bump, cascaded })),
      order: [...plan.order],
      changes: [...release.consumed],
      composerLocks: [...composerLocks],
    });
  } catch (error) {
    restore(git, root, created);
    throw error;
  }
}

export async function runPrepareCli(argv, dependencies = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    return { exitCode: 0, stdout: jsonLine(await prepareRelease(dependencies)), stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "PREPARE_FAILED", message: error instanceof Error ? error.message : String(error) }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPrepareCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
```

`package.json`: add `"release:prepare": "node scripts/release/prepare.mjs",` after `"release:plan"`.

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/prepare.test.mjs && pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Re-bind** (`package.json`): `pnpm skills:rebind --reason "The workspace gained release:prepare." && pnpm skills:validate`.

- [ ] **Step 6: Commit**

```bash
git add scripts/release/prepare.mjs scripts/release/test/prepare.test.mjs scripts/release/test/workflow-policy.test.mjs package.json skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring
git commit -m "feat(release): prepare a release from change files with release:prepare

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Check the real refusal on this branch** (clean tree after the commit, not on `main`, no change files): `git fetch --tags origin && pnpm release:prepare` exits 1 with `"message":"Release preparation found no change files in .changes"`, and `git status --short --untracked-files=no` prints nothing.

---

### Task 10: Release pull requests rehearse their own plan in CI

**Files:**
- Modify: `.github/workflows/ci.yml` (`release-metadata` step "Reproduce the complete release without publishing", ~401-412)
- Test: `scripts/release/test/workflow-policy.test.mjs` (the rehearsal assertions ~160-170)

**Interfaces:**
- Consumes: `node scripts/release/plan.mjs --check` (now including compatibility, Task 7), `pnpm release:dry-run --plan PATH` (phase 2).
- Produces: in a pull request whose diff against `github.event.pull_request.base.sha` changes an existing `.release/plan.json` (a release pull request), `release-metadata` checks that plan against manifests, tags and the compatibility ledger and dry-runs exactly that plan; every other run keeps rehearsing every unit. This is how a specific plan (protocol cascade, php-core) is rehearsed in CI: a draft pull request that commits the prepared plan (Task 11). Locally, the same rehearsal is `pnpm build && PLAYWRIGHT_BROWSER_CHANNEL=chromium pnpm release:dry-run --plan .release/plan.json`.

- [ ] **Step 1: Write the failing test.** In the CI test of `workflow-policy.test.mjs`, replace the `rehearsal.run` assertion and the dry-run count with:

```js
  assert.deepEqual(rehearsal.env, {
    PLAYWRIGHT_BROWSER_CHANNEL: "chromium",
    EVENT_NAME: "${{ github.event_name }}",
    BASE_SHA: "${{ github.event.pull_request.base.sha }}",
  });
  assert.deepEqual(rehearsal.run.split("\n").filter((line) => line !== "" && !line.trimStart().startsWith("#")), [
    "set -euo pipefail",
    "node scripts/release/version.mjs --check",
    "if [ -e .release/plan.json ]; then node scripts/release/version.mjs --check --plan .release/plan.json; fi",
    'if [ "$EVENT_NAME" = "pull_request" ] && [ -e .release/plan.json ] && ! git diff --quiet "$BASE_SHA" HEAD -- .release/plan.json; then',
    "  node scripts/release/plan.mjs --check",
    "  pnpm release:dry-run --plan .release/plan.json",
    "else",
    "  node scripts/release/plan.mjs --write-all-units .artifacts/ci/all-units-plan.json",
    "  pnpm release:dry-run --plan .artifacts/ci/all-units-plan.json",
    "fi",
  ]);
  assert.equal(commands["release-metadata"].match(/pnpm release:dry-run/gu).length, 2);
```

(The surrounding comment line in the test becomes "// CI rehearses every unit, except that a release pull request rehearses exactly its committed plan.")

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/workflow-policy.test.mjs`
Expected: FAIL on the `rehearsal.env` and `rehearsal.run` assertions.

- [ ] **Step 3: Implement.** Replace the step in `ci.yml`:

```yaml
      - name: Reproduce the complete release without publishing
        shell: bash
        env:
          PLAYWRIGHT_BROWSER_CHANNEL: chromium
          EVENT_NAME: ${{ github.event_name }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: |
          set -euo pipefail
          node scripts/release/version.mjs --check
          if [ -e .release/plan.json ]; then node scripts/release/version.mjs --check --plan .release/plan.json; fi
          # A release pull request changes .release/plan.json: it rehearses exactly that plan and checks it
          # against the tags and the compatibility ledger. Every other run rehearses every unit, because the
          # committed plan of an earlier release may name only already released units.
          if [ "$EVENT_NAME" = "pull_request" ] && [ -e .release/plan.json ] && ! git diff --quiet "$BASE_SHA" HEAD -- .release/plan.json; then
            node scripts/release/plan.mjs --check
            pnpm release:dry-run --plan .release/plan.json
          else
            node scripts/release/plan.mjs --write-all-units .artifacts/ci/all-units-plan.json
            pnpm release:dry-run --plan .artifacts/ci/all-units-plan.json
          fi
```

(`release-metadata` already checks out with `fetch-depth: 0`, so the base commit and every unit tag are present.)

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/workflow-policy.test.mjs && pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml scripts/release/test/workflow-policy.test.mjs
git commit -m "ci(release): rehearse a release pull request's own plan

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Documentation and end-to-end rehearsal

**Files:**
- Modify: `docs/releases/releasing.md` (Preconditions 8-25, new sections after "Release units", Repository configuration ~63-101, Local rehearsal ~103-158, Trigger ~160-225), `docs/releases/upgrading.md` (line 22), `CONTRIBUTING.md` (new "Change files" section before "Review and history", and that section's changelog sentence)
- Test: `scripts/docs/test/release-runbooks.test.mjs`, `scripts/docs/test/policy-docs.test.mjs`

**Interfaces:**
- Consumes: every command of Tasks 1-10.
- Produces: the runbook, contributor guide and upgrade guide describing change files, `none`, `release:changes --check`, `release:prepare`, the release pull request rehearsal and the prerequisites found during 0.1.8; a recorded local preparation of three plans and two CI rehearsals.

- [ ] **Step 1: Write the failing documentation tests.** Add to `release-runbooks.test.mjs`:

```js
test("release runbook covers change files, preparation and its prerequisites", () => {
  const source = read("docs/releases/releasing.md");
  assert.match(source, /## Change files/u);
  assert.match(source, /pnpm release:changes --check/u);
  assert.match(source, /`changes` check/u);
  assert.match(source, /## Prepare a release/u);
  assert.match(source, /git fetch --tags origin\ngit switch -c release\/YYYY-MM-DD\npnpm install --frozen-lockfile --package-import-method=copy\npnpm release:prepare\n/u);
  assert.match(source, /Updated `<unit>` to X\.Y\.Z\./u);
  assert.match(source, /composer:2/u);
  assert.match(source, /Re-binding log/u);
  assert.match(source, /docs\/reference\/compatibility\.md/u);
  assert.match(source, /restores every tracked file/u);
  assert.match(source, /pnpm 11\.24/u);
  assert.match(source, /Run `pnpm build` before any dry run/u);
  assert.match(source, /builder that can export images/u);
  assert.match(source, /PLAYWRIGHT_BROWSER_CHANNEL=chromium pnpm release:dry-run --plan \.release\/plan\.json/u);
  assert.match(source, /compatibility line/u);
});

test("the upgrade guide no longer names a fixed release", () => {
  assert.doesNotMatch(read("docs/releases/upgrading.md"), /exact `0\.1\.1` artifacts/u);
  assert.match(read("docs/releases/upgrading.md"), /installing-packages\.md#current-versions/u);
});
```

and to the contribution test in `policy-docs.test.mjs`:

```js
  assert.match(contributing, /## Change files/u);
  assert.match(contributing, /\.changes\/<name>\.md/u);
  assert.match(contributing, /`none`/u);
  assert.match(contributing, /pnpm release:changes --check/u);
  assert.match(contributing, /breaking change is `minor`/u);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/docs/test/release-runbooks.test.mjs scripts/docs/test/policy-docs.test.mjs`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Write the documentation**

`docs/releases/releasing.md`:

1. Preconditions: replace the bullet "every unit's version slots agree … names exactly the units whose version moved;" with

```markdown
- the release pull request prepared by `pnpm release:prepare` is merged, so
  every unit's version slots agree with that unit's own manifest or `VERSION`
  file and `.release/plan.json` names exactly the units whose version moved;
- the release machine has pnpm 11.24 on `PATH` (`corepack enable` selects the
  version pinned in `package.json`), Docker with a builder that can export images
  (the docker-container Buildx builder CI configures), and network access for
  Composer when a PHP unit is released. Run `pnpm build` before any dry run,
  because the dry run packs the built packages;
```

   and replace "the release operator has reviewed `CHANGELOG.md`," with "the release operator has reviewed the changelog sections of every released unit,".

2. Insert after the "Release units" section:

````markdown
## Change files

Every pull request that changes what a unit releases carries a change file,
`.changes/<name>.md`, written as described in
[CONTRIBUTING.md](../../CONTRIBUTING.md#change-files). The required `changes`
check runs `pnpm release:changes --check --base <base commit>`: it maps the
changed paths to the units that release them (tests, READMEs and changelogs
excluded) and fails when a touched unit is not named by a change file added or
edited in the same pull request. A release pull request is covered by its
`.release/plan.json` for the units it plans, and only for those. Run the check
locally against `origin/main` with `pnpm release:changes --check`.

## Prepare a release

On a branch from an up-to-date `main`, with every change file merged:

```sh
git switch main
git pull --ff-only
git fetch --tags origin
git switch -c release/YYYY-MM-DD
pnpm install --frozen-lockfile --package-import-method=copy
pnpm release:prepare
```

`pnpm release:prepare` reads every change file, takes the highest bump per unit
and gives every unit that depends on a released unit at least a patch release,
whose changelog says "Updated `<unit>` to X.Y.Z." for each released dependency.
`none` change files release nothing. Then, all or nothing, it:

1. writes every version and version slot with the span-preserving rewriter of
   `version.mjs --set-unit`: manifests, the Symfony bundle's `^` constraint on
   PHP Core and the Symfony example's constraints, consumer manifests, the
   Gradle consumer build and lockfile, documentation, skill references and the
   [current versions](installing-packages.md#current-versions) table;
2. re-pins the Composer locks of `packages/php/core`,
   `packages/php/symfony-bundle` and `examples/symfony` with the pinned
   `composer:2` image when a PHP unit is released, and accepts the result only
   when Composer changed nothing but the Gauntlet path packages and the content
   hash;
3. inserts a dated section into each released unit's `CHANGELOG.md` below its
   empty `## Unreleased` heading;
4. records the released units' contracts in `docs/reference/compatibility.md`;
5. deletes the consumed change files and writes `.release/plan.json` with the
   units, their from and to versions, the dependency order and the consumed
   change files;
6. re-binds the skill evaluation receipts (`pnpm skills:rebind`) when a bound
   input changed and adds an entry to the Re-binding log of each affected
   `EVALUATING.md`: the hashes match the current bytes, without new model
   samples, which confirms content integrity, not behaviour;
7. checks the version slots, the plan against manifests and tags, and the skill
   receipts, and prints one JSON summary.

On any failure it restores every tracked file and removes the files it created,
so the branch is as it was. It refuses to start on `main`, with modified
tracked files, with uncommitted change files, without change files, with only
`none` change files, when a changelog has hand-written entries under
`## Unreleased`, when a unit is not at its latest tag (fetch the tags, or
release the plan that is already prepared), and when the plan would release a
package that implements a contract major the released application does not
support.

Review `git status`, the changelog sections and `.release/plan.json`, commit
everything as one release pull request and let CI rehearse it: for a pull
request that changes `.release/plan.json`, the `release-metadata` job runs
`node scripts/release/plan.mjs --check` and `pnpm release:dry-run --plan
.release/plan.json` instead of the all-units rehearsal. To rehearse the same
plan locally, run `pnpm build` and then
`PLAYWRIGHT_BROWSER_CHANNEL=chromium pnpm release:dry-run --plan .release/plan.json`.
````

3. Repository configuration: add the paragraph "Branch protection on `main` requires the `changes` check together with the other CI jobs, so a pull request that touches a unit's released paths cannot merge without a change file."

4. Trigger: replace the first paragraph ("`pnpm release:plan` compares every unit's version with its latest tag and writes `.release/plan.json`. It reads the local tag view, so fetch the remote tags first; it refuses to write an empty plan when no unit version moved:") with "`pnpm release:prepare` writes `.release/plan.json` (see [Prepare a release](#prepare-a-release)). `pnpm release:plan` remains for versions moved by hand with `version.mjs --set-unit`: it compares every unit's version with its latest tag and writes the plan. It reads the local tag view, so fetch the remote tags first; it refuses to write an empty plan when no unit version moved:" (keep the existing `git fetch --tags origin` / `pnpm release:plan` block), and after the paragraph "Only the application release (`v<version>`) is marked Latest. …" add "Each release's notes are the unit's changelog section (or generated notes for a unit without one), followed by its compatibility line from `docs/reference/compatibility.md` and the release set."

`docs/releases/upgrading.md` line 22: replace "6. Render or inspect the candidate deployment with exact `0.1.1` artifacts and" with "6. Render or inspect the candidate deployment with the exact artifacts of the\n   target release (see the [current versions](installing-packages.md#current-versions)) and".

`CONTRIBUTING.md`: insert before "## Review and history":

````markdown
## Change files

A pull request that changes what a release unit publishes adds a change file,
`.changes/<name>.md`, with a lowercase, hyphenated name:

```md
---
type: fixed            # added | changed | fixed | removed | security
units:
  gauntlet: patch      # patch | minor | major | none
---
The dashboard keeps the sidebar width after a reload.
```

The body is one changelog sentence for users, in sentence case, without em
dashes. Name every unit whose released paths the change touches, with the
semantic version bump it needs; the units are listed in the
[release runbook](docs/releases/releasing.md#release-units). Before 1.0 a
breaking change is `minor`. Several change files for one unit resolve to the
highest bump, and units that depend on a released unit are released with a
patch automatically.

Use `none`, with the reason as the body, when a change touches a unit's
released paths but needs no release, for example a refactor with identical
behaviour. The required `changes` CI check, also available as
`pnpm release:changes --check`, fails a pull request that touches a unit's
released paths without a change file naming that unit. Tests, READMEs and
changelogs never need one. Release preparation turns change files into
changelog entries, so do not edit `CHANGELOG.md` files by hand.
````

and in "Review and history" replace "Update `CHANGELOG.md` for user-visible behavior, security boundaries, public APIs, package requirements, or deployment changes." with "Describe user-visible behavior, security boundaries, public APIs, package requirements, or deployment changes in a [change file](#change-files)."

- [ ] **Step 4: Run the full verification**

Run: `node --test scripts/docs/test/*.test.mjs && node scripts/docs/check-docs.mjs && pnpm release:test && node scripts/release/version.mjs --check && pnpm skills:validate && pnpm skills:test-install && pnpm skills:test-evals && pnpm test:helm && pnpm check`
Expected: PASS; check-docs `{"ok":true}`; `version.mjs --check` `"ok":true`.

- [ ] **Step 5: Commit**

```bash
git add docs/releases/releasing.md docs/releases/upgrading.md CONTRIBUTING.md scripts/docs/test/release-runbooks.test.mjs scripts/docs/test/policy-docs.test.mjs
git commit -m "docs(release): document change files and release preparation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: End-to-end rehearsal of three plans** (needs Docker and network for the PHP plan; nothing here is committed to the feature branch). Run each scenario in its own worktree on a throwaway branch:

```bash
git fetch --tags origin
rehearse() {
  name="$1"; units="$2"; type="$3"; body="$4"
  REHEARSAL="$(mktemp -d "/tmp/gauntlet-rehearsal-$name.XXXXXX")"
  git worktree add -b "rehearsal/$name" "$REHEARSAL" HEAD
  (
    cd "$REHEARSAL"
    pnpm install --frozen-lockfile --package-import-method=copy
    mkdir -p .changes
    printf -- '---\ntype: %s\nunits:\n%s\n---\n%s\n' "$type" "$units" "$body" > ".changes/rehearsal-$name.md"
    git add .changes && git commit -m "rehearsal: $name change file"
    pnpm release:prepare
    git status --short
    node scripts/release/version.mjs --check --plan .release/plan.json
    node scripts/release/plan.mjs --check
    pnpm skills:validate
    pnpm docs:check
    git add -A && git commit -m "rehearsal: prepare $name release"
    pnpm release:changes --check --base main
  )
}
rehearse dashboard-only "  gauntlet: patch" fixed "The dashboard keeps the sidebar width after a reload."
rehearse protocol-cascade "  protocol: minor" added "Run requests accept an optional deadline."
rehearse php-core "  php-core: patch" fixed "PHP Core reports adapter timeouts with the request id."
```

Expected, per scenario: `release:prepare` prints `"ok":true` with
- dashboard-only: units `gauntlet` 0.1.8→0.1.9 (patch) and `skills` 0.1.8→0.1.9 (cascaded); changed files are `VERSION`, `skills/VERSION`, `apps/dashboard/package.json`, `apps/server/package.json`, `deploy/compose/.env.example`, `deploy/helm/gauntlet/Chart.yaml`, `deploy/helm/gauntlet/values.yaml`, `deploy/helm/README.md`, `docs/ai-skills.md`, `docs/releases/installing-packages.md`, `skills/gauntlet-app-integration/references/deployment.md`, `skills/gauntlet-app-integration/references/safety-gates.md`, `CHANGELOG.md`, `skills/CHANGELOG.md`, `docs/reference/compatibility.md`, `.release/plan.json`, the deleted change file and the `gauntlet-app-integration` receipts only (the extension-authoring evaluation binds nothing that moved, so its receipt is untouched); also run `pnpm test:helm` in this worktree;
- protocol-cascade: eight units in the order `protocol` (0.2.0), `dashboard-client`, `gauntlet`, `typescript-core`, `typescript-node`, `next-adapter`, `conformance-runner`, `skills` (0.1.9), both evaluations re-bound;
- php-core: units `php-core`, `symfony-bundle`, `skills` at 0.1.9, `composerLocks` listing `packages/php/core/composer.lock`, `packages/php/symfony-bundle/composer.lock`, `examples/symfony/composer.lock`.

Every follow-up command prints `"ok":true` (`docs:check` prints `{"ok":true}` and passes its tests), and `release:changes --check` reports the planned units as `covered`. No file needed a hand edit: record in the task report any file that a check reported, plus each scenario's `git diff --stat main...HEAD`.

- [ ] **Step 7: CI rehearsal of the cascade and php-core plans.** Requires the controller's confirmation before anything is pushed. If phase 3 is already merged, rebase both rehearsal branches on `origin/main` first. Then:

```bash
for name in protocol-cascade php-core; do
  git push origin "rehearsal/$name"
  gh pr create --draft --base main --head "rehearsal/$name" \
    --title "Rehearsal: $name release plan (do not merge)" \
    --body "Throwaway rehearsal of a prepared $name release plan for the independent release units work. CI must pass the changes check and dry-run exactly this plan. Never merge; it is closed after the run."
done
```

Watch both with `gh pr checks <number> --watch`. Expected: `changes` passes (the plan covers every touched unit); the `release-metadata` log shows `node scripts/release/plan.mjs --check` with `"ok":true` and a dry-run JSON line with `"releaseReady":true` whose `units` equal the plan (`php`, `java` records `skipped` for the cascade; `java`, the image and Helm phases `skipped` for php-core); every other job passes. Record the run URLs, each phase's duration and any phase within 15 minutes of its timeout. Then close and clean up:

```bash
for name in dashboard-only protocol-cascade php-core; do
  gh pr close "rehearsal/$name" --delete-branch 2>/dev/null || true
  git worktree remove --force "$(git worktree list --porcelain | awk -v b="refs/heads/rehearsal/$name" '$1=="worktree"{w=$2} $1=="branch" && $2==b {print w}')"
  git branch -D "rehearsal/$name"
done
```

If GitHub Actions cannot run (billing), state that the CI rehearsals were not run and keep the local results from Step 6.
