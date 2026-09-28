# Shared Protocol Semantic Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` and execute this plan task-by-task
> with an independent review after every commit.

**Goal:** Make the accepted protocol and TypeScript runtime a safe, portable
authority for PHP/Symfony, Node/Next, and Java/Spring adapters before building
the conformance runner or any language SDK.

**Architecture:** `@8lines/gauntlet-protocol` remains the dependency root.
It owns wire types, canonical fixtures, revision vectors, the portable JSON
Schema profile, and pure document semantics. The dashboard client owns only
transport/envelope validation. TypeScript core consumes protocol semantics and
exposes request context to handlers through a short-lived memory lease that is
never persisted.

**Execution base:** Task 5 accepted at
`b975696ff7ab90d33299c6afd59df30dfa54fbd2`.

**Tech stack:** Node.js 24, pnpm 11, TypeScript 7, native `node:test`, Ajv
Draft 2020-12, RFC 8785/JCS plus SHA-256.

## Global constraints

- Do not change endpoint paths, wire envelopes, protocol version, OpenAPI, or
  the frozen Task 6 IDs `agency-applications.finalize` and
  `pending-applications`.
- The checked-in OpenAPI 3.1.0 document is authoritative. The older architecture
  sentence naming OpenAPI 3.2 is an erratum and is not a reason to regenerate it.
- Operation and data-source `contextSchema` validate the complete raw optional
  `InvocationContext`, never a projection selected by `contextPointers`.
- Data-source `dependencySchema` validates the complete raw object whose keys
  are JSON Pointers, never leaf names or a projected object.
- A definition with no context restriction omits `contextSchema`; it must not
  publish an empty closed object that rejects canonical context fields.
- `protocol` may not import `dashboard-client`, TypeScript core, server, or
  conformance packages. Downstream packages import protocol public APIs.
- All fixture expectations and revision hashes are hand-authored constants.
  Tests must not generate their own expected values with the implementation
  under test.
- Use TDD, one commit per task, and keep the worktree clean between tasks.

---

## Task 1: Correct raw context/dependency fixture semantics

**Files:**

- Create: `packages/protocol/test/fixture-semantics.test.ts`
- Modify: `packages/protocol/fixtures/v1/operation.valid.json`
- Modify: `packages/protocol/fixtures/v1/manifest.valid.json`
- Modify: `packages/protocol/fixtures/v1/manifest.minor-forward.valid.json`
- Modify: `packages/protocol/fixtures/v1/create-run-request.valid.json`
- Modify: `packages/protocol/fixtures/v1/run.queued.valid.json`
- Modify: `packages/protocol/fixtures/v1/run.succeeded.valid.json`
- Modify: `packages/protocol/fixtures/v1/run.failed.valid.json`
- Modify: `packages/protocol/fixtures/v1/run-event.valid.json`

**Expected revisions for the exact corrected documents:**

- operation:
  `sha256:2e301a636fb48d2bec64fc7e91b62d8a45e47af3a28f665b6b809f6a4b19d9e8`
- protocol 1.0 manifest:
  `sha256:bfc62da9f591ed7292c1db5e11c975301a08f06e2c31119998d61aa6e7e5a2d8`
- protocol 1.1 manifest:
  `sha256:0f10f6f1403e8073204a67300531bfcc2b25b6e4f0f0e39108c0d81944fbe94f`

- [ ] **Step 1: Add failing semantic fixture tests**

  Compile the declared schemas locally with Ajv. Prove that:

  - complete context from `create-run-request.valid.json` passes the operation
    `contextSchema`;
  - complete context/dependencies from both data-source request fixtures pass
    their manifest schemas;
  - projected `{ "targetId": ... }` and `{ "includeInactive": ... }` fail;
  - dependency key `/options/includeInactive` is required and is boolean;
  - operation revision recomputes and matches every summary/request/Run/Event
    reference;
  - both manifest revisions recompute exactly.

  Run:
  `pnpm --filter @8lines/gauntlet-protocol test`

  Expected: RED against the current projected schemas.

- [ ] **Step 2: Correct only fixture schemas and dependent hashes**

  The context root requires `requestId` and `target`, permits canonical
  `requestId`, `locale`, `timeZone`, `actor`, `target`, and `extensions`, and is
  closed. Nested actor/target objects are closed and use portable ID/string
  constraints. The dependency root requires literal property
  `/options/includeInactive`, is closed, and accepts a boolean value.

- [ ] **Step 3: Run focused and downstream gates**

  ```sh
  pnpm --filter @8lines/gauntlet-protocol test
  pnpm --filter @8lines/gauntlet-dashboard-client test
  ! rg -n '12b4c682f614e57a6cabf5e5dbb69d7492657db96577284c70a7022b6a01abf1' packages
  git diff --check
  ```

- [ ] **Step 4: Commit**

  `fix(protocol): align raw context fixture semantics`

---

## Task 2: Freeze portable pattern and JCS revision vectors

**Files:**

- Create: `packages/protocol/fixtures/v1/tc-schema-core-pattern-vectors.json`
- Create: `packages/protocol/fixtures/v1/jcs-revision-vectors.json`
- Create: `packages/protocol/README.md`
- Modify: `packages/protocol/src/schema-profile.ts`
- Modify: `packages/protocol/test/schema-profile.test.ts`
- Modify: `packages/protocol/test/revision.test.ts`

### Normative pattern contract

- Matching is case-sensitive ECMAScript Unicode search semantics unless the
  pattern is anchored. In non-multiline Unicode mode `$` is absolute-end: it
  does not match before a final LF, CR, U+2028, or U+2029.
- The portable instance domain is Unicode scalar sequences. Adapter and
  control-plane protocol boundaries must reject every candidate string with a
  lone surrogate before pattern evaluation; this is an enforcement rule, not
  a wire-schema shape change. Although a negated ECMAScript `/u` class can
  match lone surrogates, it does not broaden the cross-language domain because
  those candidates never reach the matcher and complements are analyzed over
  Unicode scalar values only.
- A decoded pattern is at most 512 UTF-16 code units.
- Allow anchors, alternation, capturing and noncapturing groups, ordinary
  classes/ranges/negation, raw Unicode scalar literals, and greedy `?`, `*`,
  `+`, `{m}`, `{m,}`, `{m,n}` quantifiers. A class range may not span the
  surrogate block: reject `start <= U+D7FF && end >= U+E000`. Numeric bounds
  are ASCII decimal, at most 1000, and `m <= n`.
- Outside a class, only escapes of regex syntax from `\\^$.*+?()[]{}|/` are
  allowed. Inside a class, only `\\]^-` escapes are allowed. Compile with
  `new RegExp(pattern, "u")` after the lexical check.
- Reject lone surrogates; C0/C1 controls (`U+0000..001F`, `U+007F..009F`);
  wildcard; shorthand/boundary, backreference, Unicode property/code-point,
  hex, and control escapes; lookaround; named groups; inline flags; lazy or
  possessive/repeated quantifier suffixes; nested classes; and `&&`/`--` class
  set operators. Reject every ordinary class range spanning
  `U+D800..U+DFFF`; splitting such a range would disagree with unchanged
  ECMAScript `/u` matching on WTF-16 strings and break cross-language
  determinism.
- Build a regex AST and accept only one-pass deterministic expressions. Give
  every consuming literal/class occurrence a position with a normalized set of
  Unicode-scalar intervals; compute nullable-derivation multiplicity, `FIRST`,
  `LAST`, and a multiset of `FOLLOW` transitions. Alternation adds nullable
  derivations, concatenation multiplies them, and every combinator producing
  more than one is rejected. An optional quantifier rejects a nullable body;
  exact `{0}` has one empty derivation. A repeat with maximum greater than one
  retains the non-nullable-body requirement and adds
  `LAST(body) -> FIRST(body)`. Concatenation adds
  `LAST(left) -> FIRST(right)`. At the start and for every consuming position,
  all outgoing target character sets must be pairwise disjoint. Do not
  deduplicate parallel identical transitions: this is what rejects `(a+)+`,
  while the same rule also rejects `(a|aa)*` and `(a*)*`.
- A pattern containing an unbounded quantifier (`*`, `+`, or `{m,}`) must have
  an unescaped `^` as the first source code unit and no top-level root
  alternation. Nested alternation after the common root anchor is allowed.
  Bounded unanchored search remains portable. This prevents native search from
  restarting an otherwise deterministic unbounded expression such as `a*b` at
  every candidate position and becoming quadratic.
- The analysis is structural, not an allow-list exception. It must accept the
  existing deterministic JSON Pointer expression
  `^(?:/(?:[^~/]|~[01])*)*$`: `/`, `[^~/]`, and `~` select disjoint paths.
  Together with the 512-code-unit ceiling, one-pass matching provides a
  portable linear-time profile; a broader grammar requires a new profile.
- Apply the same scanner to `pattern` values and `patternProperties` keys.

### Vector shapes

The outer pattern fixture stays ASCII-safe. Each row contains literal JSON text
`sourceJson`, `valid`, and, when valid, `matches` and `nonMatches`. Tests parse
`sourceJson` to obtain the actual pattern, allowing normative lone-surrogate and
control cases without embedding them in the outer document.

Each JCS row contains literal `inputJson` and exactly one of:

- `expectedCanonicalJson` plus `expectedRevision`; or
- `expectedError`.

Inputs are parsed as JSON binary64. Freeze root-only revision removal, nested
same-name retention, own `__proto__`, UTF-16 key ordering, supplementary Unicode,
lone surrogates in names and values, `-0`, `1e-7`, `1e-6`, `1e21`, `1e-27`,
`5e-324`, `1e-320`, and `2.2250738585072014e-308`. Preserve the current numeric
boundary exactly: reject an integer-valued unsafe binary64 number when its
ECMAScript serialization is non-exponential, while retaining accepted
exponential values such as `1e21`.

- [ ] **Step 1: Check in complete hand-authored vectors and RED tests**

  Include every allowed/rejected syntax category, quantifier bounds, final
  absolute-end `$` (including non-matches for all four final line terminators),
  the surrogate-overlap backtracking regression and its spanning-range root,
  nullable-derivation and unanchored-unbounded-search regressions plus anchored
  and bounded counterexamples, the explicit
  `instanceDomain: unicode-scalar-sequences` metadata,
  known repository patterns, the known own-`__proto__` revision
  `sha256:acb9124c160bde29f1302ed9ea8d241871f4ee6f634b8368cc11c9d09afe837a`,
  and all numeric boundaries above. Prove RED before scanner changes.

- [ ] **Step 2: Implement a deterministic lexical scanner**

  Do not translate or silently normalize patterns. Fail with fixed diagnostics
  that identify the schema pointer but do not echo hostile pattern text.

- [ ] **Step 3: Document the portable profile and revision algorithm**

  The README is normative for SDK authors and points to the vectors as the
  executable source of truth.

- [ ] **Step 4: Gate and commit**

  ```sh
  pnpm --filter @8lines/gauntlet-protocol test
  pnpm --filter @8lines/gauntlet-protocol typecheck
  pnpm --filter @8lines/gauntlet-protocol build
  git diff --check
  ```

  Commit: `feat(protocol): freeze portable pattern and revision vectors`

---

## Task 3: Centralize pure adapter semantic validation

**Files:**

- Create: `packages/protocol/src/semantic-validation.ts`
- Create: `packages/protocol/src/preset-secrets.ts`
- Create/move: protocol semantic tests and all three preset-secret stress fixtures
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/dashboard-client/src/protocol-validator.ts`
- Delete: `packages/dashboard-client/src/preset-secrets.ts`
- Reduce: dashboard tests to transport/schema and 502 mapping coverage

**Public API:**

```ts
manifestSemanticsAreValid(manifest: AdapterManifest): boolean;
operationSemanticsAreValid(operation: OperationDefinition): boolean;
resolveSemanticsAreValid(
  request: DataSourceResolveRequest,
  response: DataSourceResolveResponse,
): boolean;
```

- [ ] **Step 1: Add RED public API and dependency-direction tests**

  Protocol tests cover revisions, feature graph, uniqueness, requirements,
  diagnostics, limits, embedded schemas, UI/data-source references,
  secret-free presets, and exact resolve order/value identity. Move the complete
  bounded preset analyzer and all deep/wide/mutual stress fixtures without
  simplification. Protocol support uses relative protocol imports and contains
  no dashboard-client import.

  Manifest envelope validation remains the earlier boundary for the closed
  Problem/diagnostic shapes and portable IDs. Shared semantics require complete
  requirement closure only for an `available` summary. An `unavailable`
  summary retains all declared requirements, including unmet ones, together
  with its schema-valid safe Problem. A diagnostic may carry a safely parsed
  operation ID even when the invalid binding was omitted from `operations`;
  membership in the summary list is not required. Tests recompute revisions for
  every intended semantic case and keep stale-revision rejection separate.

- [ ] **Step 2: Move implementation and make dashboard consume it**

  Keep Ajv endpoint validators and the public `validateCreateRunRequest` in the
  dashboard client. Remove duplicate pure semantics. Preserve focused tests that
  invalid adapter semantics become a safe 502/protocol mismatch. The dashboard
  acceptance path proves an unavailable summary with unmet requirements and an
  omitted-operation diagnostic survives both envelope and shared semantic
  validation, while a malformed unavailable Problem remains a fixed safe 502.

- [ ] **Step 3: Clean build and package import gate**

  Build protocol before downstream typechecks because package exports resolve
  through generated `dist`. Pack protocol, install/import it from a clean
  `mktemp -d` directory, and verify all three functions are public.

  ```sh
  pnpm --filter @8lines/gauntlet-protocol build
  pnpm --filter @8lines/gauntlet-protocol test
  pnpm --filter @8lines/gauntlet-dashboard-client typecheck
  pnpm --filter @8lines/gauntlet-dashboard-client test
  git diff --check
  ```

- [ ] **Step 4: Commit**

  `refactor(protocol): centralize adapter semantic validation`

---

## Task 4: Enforce shared semantics in TypeScript authoring

**Files:**

- Modify: `packages/typescript/core/src/operation.ts`
- Modify: `packages/typescript/core/test/operation-registry.test.ts`
- Modify: `packages/typescript/core/test/support/operation.ts`
- Modify: `packages/typescript/core/test/run-manager.test.ts`

- [ ] **Step 1: Add RED authoring tests**

  Reject duplicate data-source/preset IDs, a secret-bearing preset, an
  undeclared UI data source, and an invalid output schema profile. Remove empty
  default `contextSchema` helpers. In `run-manager.test.ts`, correct the runtime
  instance test: use a canonical `{ requestId }` that fails a declared schema
  requiring nested `target`, plus a passing complete raw `InvocationContext`.
  `defineOperation` validates schema documents, not context instances, and
  `{ context: {} }` tests only the canonical envelope.

- [ ] **Step 2: Validate in diagnostic order**

  In `defineOperation`, own/freeze the draft, call `assertTcSchemaCore` for input,
  optional context, and output, derive the revision, call
  `operationSemanticsAreValid`, and brand/register only after success.

- [ ] **Step 3: Gate and commit**

  ```sh
  pnpm --filter @8lines/gauntlet-protocol build
  pnpm --filter @8lines/gauntlet-typescript-core test
  pnpm --filter @8lines/gauntlet-typescript-core typecheck
  pnpm --filter @8lines/gauntlet-dashboard-client test
  ```

  Commit: `fix(ts-core): enforce shared operation semantics`

---

## Task 5: Expose InvocationContext through an ephemeral lease

**Files:**

- Modify: `packages/typescript/core/src/run-context.ts`
- Modify: `packages/typescript/core/src/run-manager.ts`
- Modify: `packages/typescript/core/test/run-manager.test.ts`

**Public API:**

```ts
readonly invocationContext?: InvocationContext;
```

- [ ] **Step 1: Add lifecycle RED tests**

  Prove the handler sees the full deeply frozen owned context; caller mutation
  cannot affect it; absent context remains absent; and a retained RunContext
  returns `undefined` after success or handler throw. Prove clearing happens
  before terminal persistence finishes and the non-enumerable property cannot
  be overwritten/reconfigured. Pre-handler failures expose no RunContext by
  design, so assert no dispatch, no rejected task, no context history, and
  verify the explicit early clear in review rather than adding a test seam.
  Exercise output/progress/log/artifact/action/Problem surfaces with unrelated
  safe values and prove the runtime never automatically persists the context
  sentinel. This is not a DLP promise for values deliberately copied by a
  handler, nor can JavaScript revoke a raw object a handler/validator retained.

- [ ] **Step 2: Implement a real clearing lease**

  Use an internal class whose private field is the only runtime-owned raw
  context reference; a closure factory can retain its original parameter even
  after a local alias is cleared. Define a non-enumerable, non-configurable
  getter using the class prototype method bound only to the lease. Clear its
  private field:

  - immediately after handler settlement in `finally`;
  - again in the outer execution `finally`;
  - on scheduler rejection;
  - on failed or duplicate persistence no-op paths; and
  - on failure before handler dispatch, including queued-to-running update.

  Create scheduled work in a separate private task-factory method that receives
  only operation, owned input, secret guard, execution gate, and lease. A
  callback declared inside `create()` could retain that complete lexical
  environment, so it is not sufficient merely to avoid reading
  `validatedRequest`. Never persist context. If a scheduler accepts work and
  never runs it, the pending execution necessarily owns its lease; clearing it
  would make later legitimate dispatch lose context and is outside this task.

- [ ] **Step 3: Gate and commit**

  ```sh
  pnpm --filter @8lines/gauntlet-typescript-core test
  pnpm --filter @8lines/gauntlet-typescript-core typecheck
  pnpm check
  ```

  Commit: `feat(ts-core): expose ephemeral invocation context`

---

## Aggregate acceptance

- [ ] Run a clean full workspace build before downstream tests.
- [ ] Run the deployment smoke again because the fake adapter serves the changed
  golden manifest.
- [ ] Confirm the old revision occurs nowhere.

```sh
pnpm build
pnpm check
! rg -n '12b4c682f614e57a6cabf5e5dbb69d7492657db96577284c70a7022b6a01abf1' packages
docker compose -f compose.example.yml config -q
docker build --check --target runtime -f Dockerfile .
```

Use a uniquely named Compose project with a cleanup trap for the real smoke.

## Downstream handoff

- Task 6 imports all three semantic validators. It validates canonical envelopes
  first and then every declared raw operation/data-source context/dependency
  schema against the complete wire object; this supersedes the earlier stale
  ruling that skipped data-source context schemas.
- PHP and Java must pass the exact checked-in pattern/JCS vectors. Java remains
  blocked until its canonicalizer passes subnormal cases including `1e-320`.
- PHP/Java RunContext APIs mirror the ephemeral invocation-context lifetime and
  the accepted TypeScript handler surface.
- No SDK implementation begins until this plan and Task 6 are independently
  accepted.
