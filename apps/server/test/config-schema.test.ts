import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDocument } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { DEFAULT_CONFIG_FILE, MAX_CONFIG_BYTES } from "../src/config.js";

const root = new URL("../../../", import.meta.url);
const schemaUrl = new URL("config/gauntlet-config-v1.schema.json", root);
const mainRuntimeKeys = [
  "GAUNTLET_HOST",
  "GAUNTLET_PORT",
  "GAUNTLET_DASHBOARD_DIR",
  "GAUNTLET_WIDGET_DIR",
  "GAUNTLET_AUTH_SECRET",
] as const;
const configurationFileKey = "GAUNTLET_CONFIG_FILE";
const legacySourceKeys = [
  "GAUNTLET_TARGETS_JSON",
  "GAUNTLET_INSTANCE_NAME",
  "GAUNTLET_ENVIRONMENT_NAME",
  "GAUNTLET_ENVIRONMENT_KIND",
] as const;
const configurationSourceKeys = [
  configurationFileKey,
  ...legacySourceKeys,
] as const;

function literalPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function assertContainsLiterals(documentText: string, required: readonly string[]): void {
  for (const value of required) {
    assert.match(documentText, literalPattern(value), `missing documented contract: ${value}`);
  }
}

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

test("the YAML and JSON v1 examples have identical semantic values", async () => {
  const yaml = await document("config.valid.yaml");
  const json = await document("config.valid.json");
  assert.deepEqual(yaml, json);
});

test("the v1 schema rejects production, unknown fields, and empty targets", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  for (const fixture of [
    "config.production.invalid.yaml",
    "config.unknown-field.invalid.yaml",
    "config.empty-targets.invalid.yaml",
    "config.widget-origin.invalid.yaml",
  ]) {
    assert.equal(validate(await document(fixture)), false, fixture);
  }
});

test("the v1 schema accepts the widget switch and exact target origins only", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  const base = await document("config.valid.json") as Record<string, any>;
  const withWidget = (widget: unknown, targetWidget: unknown) => ({
    ...base,
    widget,
    targets: [{ ...base.targets[0], widget: targetWidget }],
  });
  assert.equal(validate(withWidget({ enabled: false }, { origins: ["https://shop.dev.example"] })), true);
  assert.equal(validate(withWidget({}, { origins: ["http://localhost:5173"] })), true);
  for (const [widget, targetWidget] of [
    [{ enabled: "yes" }, { origins: ["https://shop.dev.example"] }],
    [{ enabled: true, extra: 1 }, { origins: ["https://shop.dev.example"] }],
    [{ enabled: true }, {}],
    [{ enabled: true }, { origins: [] }],
    [{ enabled: true }, { origins: ["https://shop.dev.example/"] }],
    [{ enabled: true }, { origins: ["https://Shop.dev.example"] }],
    [{ enabled: true }, { origins: ["https://shop.dev.example", "https://shop.dev.example"] }],
  ] as const) {
    assert.equal(validate(withWidget(widget, targetWidget)), false, JSON.stringify([widget, targetWidget]));
  }
});

test("the v1 schema accepts password authentication and rejects unknown modes", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  const base = await document("config.valid.json") as Record<string, unknown>;
  const salt = Buffer.alloc(16, 1).toString("base64url");
  const hash = `scrypt$16384$8$1$${salt}$${Buffer.alloc(32, 2).toString("base64url")}`;
  const tokenHash = `sha256$${Buffer.alloc(32, 4).toString("base64url")}`;
  const accepted = [
    { mode: "none" },
    { mode: "password", publicUrl: "https://gauntlet.qa.internal", password: { shared: { hash } } },
    {
      mode: "password",
      publicUrl: "http://localhost:8080",
      sessionTtl: "12h",
      password: { users: [{ username: "anna", hash }] },
      tokens: [{ name: "ci-nightly", hash: tokenHash }],
    },
  ];
  for (const auth of accepted) assert.equal(validate({ ...base, auth }), true, JSON.stringify(validate.errors));
  const rejected = [
    { mode: "oidc" },
    { mode: "none", publicUrl: "https://gauntlet.qa.internal" },
    { mode: "password", password: { shared: { hash } } },
    { mode: "password", publicUrl: "https://gauntlet.qa.internal/base", password: { shared: { hash } } },
    { mode: "password", publicUrl: "https://gauntlet.qa.internal", password: { shared: { hash }, users: [{ username: "anna", hash }] } },
    { mode: "password", publicUrl: "https://gauntlet.qa.internal", password: { shared: { hash: "plain" } } },
    { mode: "password", publicUrl: "https://gauntlet.qa.internal", sessionTtl: "12s", password: { shared: { hash } } },
    { mode: "password", publicUrl: "https://gauntlet.qa.internal", password: { shared: { hash } }, tokens: [{ name: "ci", hash: "secret" }] },
  ];
  for (const auth of rejected) assert.equal(validate({ ...base, auth }), false, JSON.stringify(auth));
});

test("the Compose schema copy is identical to the canonical configuration schema", async () => {
  assert.equal(
    await readFile(new URL("deploy/compose/gauntlet-config-v1.schema.json", root), "utf8"),
    await readFile(schemaUrl, "utf8"),
  );
});

test("configuration documentation matches the implemented source, schema, and safety contract", async () => {
  const readme = await readFile(new URL("config/README.md", root), "utf8");
  assertContainsLiterals(readme, [
    "https://schemas.8lines.dev/gauntlet/config/v1.schema.json",
    "version: 1",
    "expectedEnvironment",
    "development",
    "test",
    "qa",
    "staging",
    "uat",
    "preview",
    "sandbox",
    "prod",
    "production",
    "live",
    ".yaml",
    ".yml",
    ".json",
    String(MAX_CONFIG_BYTES),
    "GAUNTLET_CONFIG_FILE",
    DEFAULT_CONFIG_FILE,
    "GAUNTLET_TARGETS_JSON",
    "GAUNTLET_INSTANCE_NAME",
    "GAUNTLET_ENVIRONMENT_NAME",
    "GAUNTLET_ENVIRONMENT_KIND",
    "GAUNTLET_TARGETS_JSON_DEPRECATED",
    "restart",
  ]);
});

test("server documentation matches runtime configuration and readiness semantics", async () => {
  const readme = await readFile(new URL("apps/server/README.md", root), "utf8");
  assertContainsLiterals(readme, [
    ...mainRuntimeKeys,
    "GAUNTLET_CONFIG_FILE",
    DEFAULT_CONFIG_FILE,
    "/health",
    "/ready",
    "node dist/main.js",
  ]);
});

test("documented environment keys remain bound to their runtime source", async () => {
  const [mainSource, configurationSource, serverReadme, configurationReadme] = await Promise.all([
    readFile(new URL("apps/server/src/main.ts", root), "utf8"),
    readFile(new URL("apps/server/src/config.ts", root), "utf8"),
    readFile(new URL("apps/server/README.md", root), "utf8"),
    readFile(new URL("config/README.md", root), "utf8"),
  ]);

  assertContainsLiterals(
    mainSource,
    mainRuntimeKeys.map((key) => `ownEnvironmentString(environment, ${JSON.stringify(key)})`),
  );
  assertContainsLiterals(serverReadme, mainRuntimeKeys);
  assertContainsLiterals(configurationSource, [
    `Object.getOwnPropertyDescriptor(environment, ${JSON.stringify(configurationFileKey)})`,
  ]);
  const legacyKeyDeclaration = /const LEGACY_ENVIRONMENT_KEYS = \[([\s\S]*?)\] as const;/.exec(configurationSource);
  assert.notEqual(legacyKeyDeclaration, null, "missing runtime legacy key declaration");
  assertContainsLiterals(legacyKeyDeclaration?.[1] ?? "", legacySourceKeys.map((key) => JSON.stringify(key)));
  assertContainsLiterals(configurationReadme, configurationSourceKeys);
});
