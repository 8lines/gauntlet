import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(core, "../../..");
const protocol = resolve(root, "packages/protocol");
const run = (cwd, command, args) => execFileSync(command, args, {
  cwd,
  stdio: "pipe",
  encoding: "utf8",
});
rmSync(resolve(protocol, "dist"), { recursive: true, force: true });
rmSync(resolve(core, "dist"), { recursive: true, force: true });
run(root, "pnpm", ["--filter", "@8lines/gauntlet-protocol", "build"]);
run(root, "pnpm", ["--filter", "@8lines/gauntlet-typescript-core", "build"]);
const sandbox = mkdtempSync(resolve(tmpdir(), "gauntlet-core-package-"));
try {
  const packed = resolve(sandbox, "packed");
  mkdirSync(packed);
  const protocolOut = run(protocol, "pnpm", ["pack", "--pack-destination", packed]).trim();
  const coreOut = run(core, "pnpm", ["pack", "--pack-destination", packed]).trim();
  const archives = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 2, "expected exactly protocol and core tarballs");
  const protocolArchive = archives.find((name) => name.startsWith("8lines-gauntlet-protocol-"));
  const coreArchive = archives.find((name) => name.startsWith("8lines-gauntlet-typescript-core-"));
  assert.ok(protocolArchive && coreArchive, `${protocolOut}${coreOut}`);
  const shipped = run(sandbox, "tar", ["-tf", resolve(packed, coreArchive)]).split("\n");
  assert.ok(shipped.includes("package/dist/index.js"), "packed Core is missing public JavaScript");
  assert.ok(shipped.includes("package/dist/index.d.ts"), "packed Core is missing public declarations");
  const consumer = resolve(sandbox, "consumer");
  mkdirSync(consumer);
  writeFileSync(resolve(sandbox, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(resolve(consumer, "package.json"), JSON.stringify({ type: "module", dependencies: {
    "@8lines/gauntlet-protocol": `file:../packed/${protocolArchive}`,
    "@8lines/gauntlet-typescript-core": `file:../packed/${coreArchive}`,
  } }));
  writeFileSync(resolve(consumer, "pnpm-workspace.yaml"), `overrides:\n  '@8lines/gauntlet-protocol': 'file:../packed/${protocolArchive}'\n`);
  run(consumer, "pnpm", ["install", "--offline", "--ignore-scripts"]);
  writeFileSync(resolve(consumer, "check.mjs"), `import assert from "node:assert/strict";
import {
  CapabilityRegistry,
  DataSourceRegistry,
  InMemoryRunStore,
  OperationRegistry,
  RunManager,
  createAdapterCatalog,
  createAjvSchemaValidator,
} from "@8lines/gauntlet-typescript-core";
assert.equal(typeof createAjvSchemaValidator, "function");
const schemaValidator = createAjvSchemaValidator();
assert.deepEqual(schemaValidator.validate({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }, {}), []);
const operations = new OperationRegistry();
const runs = new RunManager(operations, new InMemoryRunStore(), {
  validateSchema: ({ schema, value }) => schemaValidator.validate(schema, value),
  validateFileReference: () => [],
  idempotencySecret: new Uint8Array(32).fill(7),
});
const catalog = createAdapterCatalog({
  application: { id: "packed-consumer", label: "Packed consumer", environment: { name: "packed-test", kind: "test" } },
  profiles: ["tc-schema-core@1"],
  capabilities: new CapabilityRegistry(),
  operations,
  dataSources: new DataSourceRegistry(),
  runs,
  schemaValidator,
});
assert.equal(catalog.manifest().application.id, "packed-consumer");
assert.ok(import.meta.resolve("@8lines/gauntlet-typescript-core").includes("node_modules"));\n`);
  run(consumer, process.execPath, ["check.mjs"]);
} finally { rmSync(sandbox, { recursive: true, force: true }); }
