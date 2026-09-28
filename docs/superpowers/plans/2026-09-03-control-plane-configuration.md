# Versioned Control-Plane Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load one closed, versioned YAML or JSON Gauntlet configuration before opening the HTTP listener, while preserving a constrained legacy environment-variable migration path and exposing truthful liveness and readiness endpoints.

**Architecture:** A standalone JSON Schema documents the deployment contract, while a small server-owned loader parses a bounded file and feeds the existing static target registry. Environment safety is not reimplemented here: the loader consumes `EnvironmentDescriptor` and `assertNonProductionEnvironment(value): EnvironmentDescriptor` from `@8lines/gauntlet-protocol`, and the server composition passes the validated instance and expected target environments to the safety-aware control plane.

**Tech Stack:** Node.js 24 LTS baseline, pnpm 11.24.0, TypeScript 7.0.2, Fastify 5.12.1, YAML 2.8.1, JSON Schema Draft 2020-12, Ajv 8.20.0 in tests, native `node:test` through tsx 4.23.12.

**Spec:** `docs/superpowers/specs/2026-09-02-release-standalone-safety-skills-design.md`

## Global Constraints

- The configuration format is exactly version `1`; unsupported versions fail before the server listens.
- `EnvironmentDescriptor` and `assertNonProductionEnvironment(value): EnvironmentDescriptor` come from the safety implementation in `@8lines/gauntlet-protocol`; this plan must not define a competing environment type or production-name heuristic.
- Allowed environment kinds are exactly `development`, `test`, `qa`, `staging`, `uat`, `preview`, and `sandbox`; there is no production override.
- Every protocol-owned configuration object is closed; unknown fields fail validation.
- A configuration contains at least one target, each target has `expectedEnvironment`, and duplicate target IDs fail validation.
- Target URLs are deployment-owned HTTP(S) origins without credentials, path, query, fragment, backslash, whitespace, or control characters.
- `GAUNTLET_CONFIG_FILE` selects the file; the container default is `/etc/gauntlet/config.yaml`.
- Configuration reload is outside v0.1; changing configuration restarts the single process.
- `GAUNTLET_TARGETS_JSON` is deprecated and only accepted with explicit instance environment variables and target expectations.
- Diagnostics are bounded and never echo configuration source text, credentials, secrets, or target URLs.
- Runtime support remains Node.js `>=24 <27`; all dependency versions remain exact in package manifests.

---

### Task 1: Canonical v1 Configuration Schema and Fixtures

**Files:**
- Create: `config/gauntlet-config-v1.schema.json`
- Create: `config/fixtures/config.valid.yaml`
- Create: `config/fixtures/config.valid.json`
- Create: `config/fixtures/config.production.invalid.yaml`
- Create: `config/fixtures/config.unknown-field.invalid.yaml`
- Create: `config/fixtures/config.empty-targets.invalid.yaml`
- Create: `apps/server/test/config-schema.test.ts`
- Modify: `apps/server/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the protocol ID pattern `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` and the seven non-production environment kinds from the approved spec.
- Produces: self-contained JSON Schema `$id` `https://schemas.8lines.dev/gauntlet/config/v1.schema.json` for the safety plan's `ServerConfiguration` wire shape.
- Produces: one YAML and one JSON fixture with identical semantic content for reuse by the loader, image, Compose, and Helm verification.

- [ ] **Step 1: Add the failing schema contract test**

```ts
// apps/server/test/config-schema.test.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDocument } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = new URL("../../../", import.meta.url);
const schemaUrl = new URL("config/gauntlet-config-v1.schema.json", root);

async function document(name: string): Promise<unknown> {
  const text = await readFile(new URL(`config/fixtures/${name}`, root), "utf8");
  if (name.endsWith(".json")) return JSON.parse(text) as unknown;
  const parsed = parseDocument(text, { maxAliasCount: 0, strict: true, uniqueKeys: true });
  assert.equal(parsed.errors.length, 0, parsed.errors.map(({ message }) => message).join("\n"));
  return parsed.toJS({ maxAliasCount: 0 }) as unknown;
}

test("the YAML and JSON v1 examples satisfy one closed configuration schema", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  for (const fixture of ["config.valid.yaml", "config.valid.json"]) {
    assert.equal(validate(await document(fixture)), true, `${fixture}: ${JSON.stringify(validate.errors)}`);
  }
});

test("the v1 schema rejects production, unknown fields, and empty targets", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  for (const fixture of [
    "config.production.invalid.yaml",
    "config.unknown-field.invalid.yaml",
    "config.empty-targets.invalid.yaml",
  ]) {
    assert.equal(validate(await document(fixture)), false, fixture);
  }
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm exec tsx --test apps/server/test/config-schema.test.ts`

Expected: FAIL because `config/gauntlet-config-v1.schema.json` and its fixtures do not exist.

- [ ] **Step 3: Add exact test dependencies**

```json
// apps/server/package.json additions
{
  "dependencies": {
    "yaml": "2.8.1"
  },
  "devDependencies": {
    "ajv": "8.20.0"
  }
}
```

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` records the direct server dependencies without changing unrelated versions.

- [ ] **Step 4: Create the closed Draft 2020-12 schema**

The schema root and environment definition must be structurally equivalent to this content:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.8lines.dev/gauntlet/config/v1.schema.json",
  "type": "object",
  "required": ["version", "instance", "targets"],
  "properties": {
    "version": { "const": 1 },
    "instance": {
      "type": "object",
      "required": ["name", "environment"],
      "properties": {
        "name": { "$ref": "#/$defs/id" },
        "environment": { "$ref": "#/$defs/environment" }
      },
      "additionalProperties": false
    },
    "targets": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/target" }
    }
  },
  "additionalProperties": false,
  "$defs": {
    "id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    },
    "environment": {
      "type": "object",
      "required": ["name", "kind"],
      "properties": {
        "name": { "type": "string", "minLength": 1, "maxLength": 128 },
        "kind": {
          "enum": ["development", "test", "qa", "staging", "uat", "preview", "sandbox"]
        }
      },
      "additionalProperties": false
    },
    "origin": {
      "type": "string",
      "pattern": "^https?://(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?/?$"
    },
    "target": {
      "type": "object",
      "required": ["id", "label", "adapterUrl", "expectedEnvironment"],
      "properties": {
        "id": { "$ref": "#/$defs/id" },
        "label": { "type": "string", "minLength": 1, "maxLength": 256 },
        "adapterUrl": { "$ref": "#/$defs/origin" },
        "publicUrl": { "$ref": "#/$defs/origin" },
        "expectedEnvironment": { "$ref": "#/$defs/environment" },
        "tags": {
          "type": "array",
          "items": { "type": "string", "minLength": 1, "maxLength": 128 },
          "uniqueItems": true
        }
      },
      "additionalProperties": false
    }
  }
}
```

The runtime origin parser remains authoritative for IPv6, default ports, and lexical rejection. Add a valid IPv6 case to the fixtures so the runtime test prevents the schema from becoming narrower than the parser.

- [ ] **Step 5: Add semantically identical YAML and JSON fixtures**

```yaml
# config/fixtures/config.valid.yaml
version: 1
instance:
  name: small-apps-dev
  environment:
    name: dev
    kind: development
targets:
  - id: billing
    label: Billing
    adapterUrl: http://billing:8080
    publicUrl: https://dev.billing.example
    expectedEnvironment:
      name: dev
      kind: development
    tags: [node, payments]
  - id: portal
    label: Portal
    adapterUrl: http://portal:8080
    expectedEnvironment:
      name: dev
      kind: development
    tags: [symfony]
  - id: ipv6-worker
    label: IPv6 worker
    adapterUrl: "http://[fd00::12]:8080"
    expectedEnvironment:
      name: dev
      kind: development
    tags: [java]
```

The JSON fixture contains the same object and property values. The three invalid fixtures each make only the named violation so the failure signal remains specific.

- [ ] **Step 6: Run schema tests and confirm GREEN**

Run: `pnpm exec tsx --test apps/server/test/config-schema.test.ts`

Expected: PASS with 2 tests and no Ajv strict-mode warning.

- [ ] **Step 7: Commit the schema contract**

```bash
git add config apps/server/test/config-schema.test.ts apps/server/package.json pnpm-lock.yaml
git commit -m "feat(server): define versioned control-plane configuration"
```

### Task 2: Bounded YAML and JSON Loader

**Files:**
- Rewrite: `apps/server/src/config.ts`
- Modify: `apps/server/src/static-target-provider.ts`
- Create: `apps/server/test/config.test.ts`
- Modify: `apps/server/test/static-target-provider.test.ts`

**Interfaces:**
- Consumes: `EnvironmentDescriptor` and `assertNonProductionEnvironment(value): EnvironmentDescriptor` from `@8lines/gauntlet-protocol`.
- Consumes: `validateStaticTargets(value): readonly StaticTargetConfig[]` from `apps/server/src/static-target-provider.ts`.
- Produces: `DEFAULT_CONFIG_FILE`, `MAX_CONFIG_BYTES`, `ConfigurationErrorCode`, `GauntletConfigurationError`, `GauntletInstanceConfiguration`, `ServerConfiguration`, and `loadServerConfiguration(environment, read?)` from `apps/server/src/config.ts`.
- Produces: `StaticTargetConfig.expectedEnvironment: EnvironmentDescriptor`.

- [ ] **Step 1: Write loader tests for valid files and owned immutable output**

```ts
// apps/server/test/config.test.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DEFAULT_CONFIG_FILE,
  loadServerConfiguration,
} from "../src/config.js";

const fixture = (name: string) => readFile(new URL(`../../../config/fixtures/${name}`, import.meta.url));

test("loads equivalent immutable YAML and JSON v1 documents", async () => {
  const yaml = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/config.yaml" },
    async (path) => {
      assert.equal(path, "/config.yaml");
      return await fixture("config.valid.yaml");
    },
  );
  const json = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/config.json" },
    async () => await fixture("config.valid.json"),
  );
  assert.deepEqual(yaml, json);
  assert.equal(Object.isFrozen(yaml), true);
  assert.equal(Object.isFrozen(yaml.targets), true);
  assert.equal(Object.isFrozen(yaml.targets[0]?.expectedEnvironment), true);
});

test("uses the container default when no explicit source is supplied", async () => {
  let requested = "";
  await loadServerConfiguration({}, async (path) => {
    requested = path;
    return await fixture("config.valid.yaml");
  });
  assert.equal(requested, DEFAULT_CONFIG_FILE);
});
```

- [ ] **Step 2: Run the loader tests and confirm RED**

Run: `pnpm exec tsx --test apps/server/test/config.test.ts`

Expected: FAIL because the safety plan's declared `loadServerConfiguration` implementation and exported supporting types do not exist yet.

- [ ] **Step 3: Define the loader's exact public types and safe error codes**

```ts
export const DEFAULT_CONFIG_FILE = "/etc/gauntlet/config.yaml";
export const MAX_CONFIG_BYTES = 1024 * 1024;

export type ConfigurationErrorCode =
  | "source-conflict"
  | "file-unreadable"
  | "file-too-large"
  | "unsupported-extension"
  | "invalid-syntax"
  | "invalid-document"
  | "legacy-environment-missing";

export class GauntletConfigurationError extends TypeError {
  constructor(readonly code: ConfigurationErrorCode) {
    super(`Invalid Gauntlet configuration (${code})`);
    this.name = "GauntletConfigurationError";
  }
}

export interface GauntletInstanceConfiguration {
  readonly name: ProtocolId;
  readonly environment: EnvironmentDescriptor;
}

export interface ServerConfiguration {
  readonly version: 1;
  readonly instance: GauntletInstanceConfiguration;
  readonly targets: readonly StaticTargetConfig[];
}
```

- [ ] **Step 4: Implement bounded format selection and parsing**

Use `readFile` as the default dependency. Reject an empty explicit path. Read into `Uint8Array`, reject more than `MAX_CONFIG_BYTES`, decode with a fatal UTF-8 `TextDecoder`, then parse strictly by suffix:

```ts
function parseConfigurationText(path: string, bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_CONFIG_BYTES) throw configurationError("file-too-large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configurationError("invalid-syntax");
  }
  try {
    if (path.endsWith(".json")) return JSON.parse(text) as unknown;
    if (!path.endsWith(".yaml") && !path.endsWith(".yml")) {
      throw configurationError("unsupported-extension");
    }
    const parsed = parseDocument(text, { maxAliasCount: 0, strict: true, uniqueKeys: true });
    if (parsed.errors.length !== 0 || parsed.contents === null) {
      throw configurationError("invalid-syntax");
    }
    return parsed.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    if (error instanceof GauntletConfigurationError) throw error;
    throw configurationError("invalid-syntax");
  }
}
```

Use `parseAllDocuments` or an equivalent AST check to reject more than one YAML document before calling `toJS`; the accepted document may not contain aliases.

- [ ] **Step 5: Validate the closed document through existing ownership-safe helpers**

Add `expectedEnvironment` to `TARGET_KEYS` and to `StaticTargetConfig`, and call `assertNonProductionEnvironment(record.expectedEnvironment)` inside `validateTarget`. The configuration validator must require exactly `version`, `instance`, and `targets`, validate `instance.name` with `isProtocolId`, validate the instance environment with `assertNonProductionEnvironment`, call `validateStaticTargets`, reject zero targets, and reject duplicate IDs before freezing the result.

```ts
export async function loadServerConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<ServerConfiguration> {
  const path = environment.GAUNTLET_CONFIG_FILE ?? DEFAULT_CONFIG_FILE;
  let bytes: Uint8Array;
  try {
    bytes = await read(path);
  } catch {
    throw configurationError("file-unreadable");
  }
  return validateConfigurationV1(parseConfigurationText(path, bytes));
}
```

- [ ] **Step 6: Add negative tests for every parsing and validation boundary**

Add table-driven cases for an unsupported suffix, invalid UTF-8, oversized bytes, duplicate YAML key, two YAML documents, YAML alias, unknown root/instance/target/environment property, zero targets, duplicate target IDs, credential-bearing URL, URL path/query/fragment, invalid environment kind, and production-like environment name. For each case assert `GauntletConfigurationError.code` and assert that a sentinel secret and URL are absent from `String(error)`.

- [ ] **Step 7: Run focused server tests and confirm GREEN**

Run: `pnpm exec tsx --test apps/server/test/config.test.ts apps/server/test/static-target-provider.test.ts`

Expected: PASS; the previous static target normalization and exotic-object tests remain green after `expectedEnvironment` is added to their valid fixtures.

- [ ] **Step 8: Commit the loader**

```bash
git add apps/server/src/config.ts apps/server/src/static-target-provider.ts \
  apps/server/test/config.test.ts apps/server/test/static-target-provider.test.ts
git commit -m "feat(server): load validated YAML and JSON configuration"
```

### Task 3: Constrained Legacy Environment Migration

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/test/config.test.ts`

**Interfaces:**
- Consumes: `validateConfigurationV1(value): ServerConfiguration`, kept private inside `config.ts`.
- Produces: support for `GAUNTLET_TARGETS_JSON` only together with `GAUNTLET_INSTANCE_NAME`, `GAUNTLET_ENVIRONMENT_NAME`, and `GAUNTLET_ENVIRONMENT_KIND`.
- Preserves: deprecated `parseStaticTargetsJson(value)` export for source compatibility in server tests, with target `expectedEnvironment` now mandatory.

- [ ] **Step 1: Write failing precedence and fail-closed legacy tests**

```ts
test("file and legacy configuration cannot be combined", async () => {
  await assert.rejects(
    loadServerConfiguration({
      GAUNTLET_CONFIG_FILE: "/config.yaml",
      GAUNTLET_TARGETS_JSON: "[]",
    }),
    (error: unknown) => error instanceof GauntletConfigurationError
      && error.code === "source-conflict",
  );
});

test("legacy targets cannot omit instance or expected target environment", async () => {
  await assert.rejects(
    loadServerConfiguration({
      GAUNTLET_TARGETS_JSON: JSON.stringify([{
        id: "portal",
        label: "Portal",
        adapterUrl: "http://portal:8080",
      }]),
    }),
    (error: unknown) => error instanceof GauntletConfigurationError
      && error.code === "legacy-environment-missing",
  );
});
```

- [ ] **Step 2: Run the legacy tests and confirm RED**

Run: `pnpm exec tsx --test apps/server/test/config.test.ts`

Expected: FAIL because the loader still always selects a file.

- [ ] **Step 3: Build one synthetic v1 document for the legacy path**

```ts
function legacyDocument(environment: Readonly<Record<string, string | undefined>>): unknown {
  const instanceName = environment.GAUNTLET_INSTANCE_NAME;
  const environmentName = environment.GAUNTLET_ENVIRONMENT_NAME;
  const environmentKind = environment.GAUNTLET_ENVIRONMENT_KIND;
  if (instanceName === undefined || environmentName === undefined || environmentKind === undefined) {
    throw configurationError("legacy-environment-missing");
  }
  let targets: unknown;
  try {
    targets = JSON.parse(environment.GAUNTLET_TARGETS_JSON ?? "") as unknown;
  } catch {
    throw configurationError("invalid-syntax");
  }
  return {
    version: 1,
    instance: {
      name: instanceName,
      environment: { name: environmentName, kind: environmentKind },
    },
    targets,
  };
}
```

The loader checks the source conflict first, then validates the synthetic document through the same `validateConfigurationV1` path as a file. It emits one process deprecation warning with code `GAUNTLET_TARGETS_JSON_DEPRECATED`; tests intercept `process.emitWarning` so no test output is polluted.

- [ ] **Step 4: Run all configuration tests and confirm GREEN**

Run: `pnpm exec tsx --test apps/server/test/config.test.ts apps/server/test/config-schema.test.ts apps/server/test/static-target-provider.test.ts`

Expected: PASS; valid file and legacy inputs produce deeply equal `ServerConfiguration` values.

- [ ] **Step 5: Commit the migration path**

```bash
git add apps/server/src/config.ts apps/server/test/config.test.ts
git commit -m "feat(server): constrain legacy environment configuration"
```

### Task 4: Configured Composition and Truthful Readiness

**Files:**
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/problem-response.ts`
- Create: `apps/server/test/main.test.ts`
- Modify: `apps/server/test/routes.integration.test.ts`

**Interfaces:**
- Consumes: `loadServerConfiguration(environment, read?)` from Task 2 and the safety plan's required `CreateAppOptions.environment: EnvironmentDescriptor` contract.
- Produces: `createConfiguredApp(environment, dependencies?): Promise<FastifyInstance>`.
- Produces: `GET /ready` returning `{ "status": "ready" }` only after configuration validation and `app.ready()` complete.
- Preserves: `GET /health` as process liveness without probing targets.

- [ ] **Step 1: Write failing composition and readiness tests**

```ts
// apps/server/test/main.test.ts
test("configured composition loads the document before constructing the app", async () => {
  const app = await createConfiguredApp(
    { GAUNTLET_CONFIG_FILE: "/config.yaml" },
    { readConfig: async () => await fixture("config.valid.yaml") },
  );
  try {
    assert.deepEqual((await app.inject("/health")).json(), { status: "ok" });
    assert.deepEqual((await app.inject("/ready")).json(), { status: "ready" });
  } finally {
    await app.close();
  }
});

test("invalid configuration rejects before an HTTP app can be returned", async () => {
  await assert.rejects(createConfiguredApp(
    { GAUNTLET_CONFIG_FILE: "/config.yaml" },
    { readConfig: async () => Buffer.from("version: 1\ninstance: {}\ntargets: []\n") },
  ));
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm exec tsx --test apps/server/test/main.test.ts`

Expected: FAIL because `createConfiguredApp` and `/ready` do not exist.

- [ ] **Step 3: Add configured composition without opening a listener**

```ts
export interface ConfiguredAppDependencies {
  readonly readConfig?: (path: string) => Promise<Uint8Array>;
}

export async function createConfiguredApp(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: ConfiguredAppDependencies = {},
): Promise<FastifyInstance> {
  const configuration = await loadServerConfiguration(
    environment,
    dependencies.readConfig ?? readFile,
  );
  return await createApp({
    environment: configuration.instance.environment,
    targets: configuration.targets,
    ...(environment.GAUNTLET_DASHBOARD_DIR === undefined
      ? {}
      : { dashboardDir: environment.GAUNTLET_DASHBOARD_DIR }),
  });
}
```

`main()` calls `createConfiguredApp`, validates the listen address, then calls `listen`. It retains the existing SIGINT/SIGTERM close behavior and its generic stderr message.

- [ ] **Step 4: Register readiness and protect it from SPA fallback**

Add `/ready` to `knownRoutes`, return a fixed JSON document from `registerRoutes`, and change the SPA exclusion predicate so both exact `/api` and prefixes `/api/`, plus `/health` and `/ready`, always retain Problem/JSON behavior.

```ts
app.get("/health", async (_request, reply) => reply.code(200).send({ status: "ok" }));
app.get("/ready", async (_request, reply) => reply.code(200).send({ status: "ready" }));
```

- [ ] **Step 5: Add negative routing assertions**

Extend integration tests to assert `POST /ready` is a 405 RFC 9457 response with `allow: GET`, `/ready/extra` is a 404 Problem, and target unavailability does not change `/ready` or `/health`.

- [ ] **Step 6: Run server tests and confirm GREEN**

Run: `pnpm exec tsx --test apps/server/test/main.test.ts apps/server/test/routes.integration.test.ts`

Expected: PASS with configuration loading occurring before listener construction.

Run: `pnpm --filter @8lines/gauntlet-server typecheck`

Expected: PASS.

- [ ] **Step 7: Commit configured startup**

```bash
git add apps/server/src/main.ts apps/server/src/app.ts apps/server/src/routes.ts \
  apps/server/src/problem-response.ts apps/server/test/main.test.ts \
  apps/server/test/routes.integration.test.ts
git commit -m "feat(server): gate startup on configuration readiness"
```

### Task 5: Configuration Documentation and Cross-Format Verification

**Files:**
- Create: `config/README.md`
- Modify: `apps/server/README.md`
- Modify: `apps/server/test/config-schema.test.ts`

**Interfaces:**
- Consumes: the exact file and legacy contracts from Tasks 1-4.
- Produces: operator documentation for source selection, schema-aware editing, restart semantics, safe diagnostics, and legacy migration.
- Produces: a documentation test proving every named environment variable and default path matches the implementation.

- [ ] **Step 1: Add a failing documentation contract assertion**

```ts
test("configuration documentation names every supported source and the container default", async () => {
  const readme = await readFile(new URL("config/README.md", root), "utf8");
  for (const required of [
    "GAUNTLET_CONFIG_FILE",
    "/etc/gauntlet/config.yaml",
    "GAUNTLET_TARGETS_JSON",
    "GAUNTLET_INSTANCE_NAME",
    "GAUNTLET_ENVIRONMENT_NAME",
    "GAUNTLET_ENVIRONMENT_KIND",
    "restart",
  ]) assert.match(readme, new RegExp(required.replaceAll("/", "\\/")));
});
```

- [ ] **Step 2: Run the documentation test and confirm RED**

Run: `pnpm exec tsx --test apps/server/test/config-schema.test.ts`

Expected: FAIL because `config/README.md` does not exist.

- [ ] **Step 3: Document the exact supported behavior**

The README includes the valid YAML fixture, IDE schema association comment, source precedence, 1 MiB bound, supported extensions, no reload behavior, the four legacy variables, removal intent after migration, safe startup diagnostics, exact restart requirement, and a warning that valid metadata cannot prove physical infrastructure identity.

- [ ] **Step 4: Run the complete configuration slice and confirm GREEN**

Run: `pnpm exec tsx --test apps/server/test/config-schema.test.ts apps/server/test/config.test.ts apps/server/test/main.test.ts apps/server/test/static-target-provider.test.ts apps/server/test/routes.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit configuration documentation**

```bash
git add config/README.md apps/server/README.md apps/server/test/config-schema.test.ts
git commit -m "docs(server): explain configuration sources and restart semantics"
```
