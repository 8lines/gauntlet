import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { applyMigrations, DATABASE_FILE_NAME, MIGRATIONS, openDatabase } from "../src/database.js";
import { createConfiguredApp } from "../src/main.js";
import { serverEnvironment } from "./support/environment.js";
import { createFakeAdapter, fakeTarget } from "./support/fake-adapter.js";

const firstClock = () => new Date("2026-10-07T10:00:00.000Z");
const laterClock = () => new Date("2026-10-08T10:00:00.000Z");

async function usingDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "gauntlet-data-"));
  try {
    return await action(directory);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

type Database = ReturnType<typeof openDatabase>;

function migrationRows(database: Database): unknown[] {
  return database.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => ({ ...row }));
}

function tableSql(database: Database, name: string): string | undefined {
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
  return row === undefined ? undefined : String(row.sql);
}

const configurationDocument = new TextEncoder().encode(JSON.stringify({
  version: 1,
  instance: { name: "qa", environment: { name: "qa", kind: "qa" } },
  targets: [{ id: "shop", label: "Shop", adapterUrl: "http://shop:8080", expectedEnvironment: { name: "qa", kind: "qa" } }],
}));
const readConfig = async (): Promise<Uint8Array> => configurationDocument;

// Runs first: the ephemeral warning is emitted once per process, and node:test gives each file its own process.
test("configured composition warns once that pins are ephemeral only when GAUNTLET_DATA_DIR is unset", async () => {
  const originalEmitWarning = process.emitWarning;
  const codes: unknown[] = [];
  process.emitWarning = ((_warning: unknown, options?: unknown) => {
    if (options !== null && typeof options === "object") codes.push((options as { readonly code?: unknown }).code);
  }) as typeof process.emitWarning;
  try {
    await usingDirectory(async (directory) => {
      const persistent = await createConfiguredApp({ GAUNTLET_CONFIG_FILE: "/c.json", GAUNTLET_DATA_DIR: directory }, { readConfig });
      await persistent.close();
      assert.equal(codes.includes("GAUNTLET_DATA_EPHEMERAL"), false);
      assert.equal((await stat(join(directory, DATABASE_FILE_NAME))).isFile(), true);
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ephemeral = await createConfiguredApp({ GAUNTLET_CONFIG_FILE: "/c.json" }, { readConfig });
      await ephemeral.close();
    }
    assert.equal(codes.filter((code) => code === "GAUNTLET_DATA_EPHEMERAL").length, 1);
  } finally {
    process.emitWarning = originalEmitWarning;
  }
});

test("migrations create the schema on a new database", () => {
  const database = openDatabase({ clock: firstClock });
  try {
    assert.deepEqual(migrationRows(database), MIGRATIONS.map(({ version }) => ({ version, applied_at: "2026-10-07T10:00:00.000Z" })));
    assert.equal(MIGRATIONS[0]?.version, 1);
    assert.match(tableSql(database, "pins") ?? "", /PRIMARY KEY \(principal_id, target_id, operation_id\)\s*\)\s*WITHOUT ROWID/);
    assert.match(tableSql(database, "schema_migrations") ?? "", /version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL/);
  } finally {
    database.close();
  }
});

test("re-applying the migrations to an up-to-date database changes nothing", () => {
  const database = openDatabase({ clock: firstClock });
  try {
    database.prepare("INSERT INTO pins VALUES ('shared', 'acme', 'seed', '2026-10-07T10:00:00.000Z')").run();
    const before = migrationRows(database);
    applyMigrations(database, laterClock);
    applyMigrations(database, laterClock);
    assert.deepEqual(migrationRows(database), before);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pins").get()?.count, 1);
  } finally {
    database.close();
  }
});

test("each migration runs in its own transaction and a failing one leaves no trace", () => {
  const database = openDatabase({ clock: firstClock });
  try {
    const failing = [
      ...MIGRATIONS,
      { version: MIGRATIONS.length + 1, sql: "CREATE TABLE extra (value TEXT NOT NULL)" },
      { version: MIGRATIONS.length + 2, sql: "CREATE TABLE broken (value TEXT); INSERT INTO missing VALUES (1)" },
    ];
    assert.throws(() => applyMigrations(database, laterClock, failing));
    assert.deepEqual(
      migrationRows(database).map((row) => (row as { readonly version: number }).version),
      [...MIGRATIONS.map(({ version }) => version), MIGRATIONS.length + 1],
    );
    assert.notEqual(tableSql(database, "extra"), undefined);
    assert.equal(tableSql(database, "broken"), undefined);
    assert.equal(database.isTransaction, false);
  } finally {
    database.close();
  }
});

test("a file database uses WAL and keeps its data after reopening", async () => {
  await usingDirectory(async (directory) => {
    const first = openDatabase({ dataDir: directory, clock: firstClock });
    try {
      assert.equal(first.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
      first.prepare("INSERT INTO pins VALUES ('user:anna', 'acme', 'reset-password', '2026-10-07T10:00:00.000Z')").run();
    } finally {
      first.close();
    }
    assert.equal((await stat(join(directory, "gauntlet.sqlite"))).isFile(), true);

    const second = openDatabase({ dataDir: directory, clock: laterClock });
    try {
      assert.deepEqual(
        second.prepare("SELECT principal_id, target_id, operation_id, pinned_at FROM pins").all().map((row) => ({ ...row })),
        [{ principal_id: "user:anna", target_id: "acme", operation_id: "reset-password", pinned_at: "2026-10-07T10:00:00.000Z" }],
      );
      assert.deepEqual(migrationRows(second), MIGRATIONS.map(({ version }) => ({ version, applied_at: "2026-10-07T10:00:00.000Z" })));
    } finally {
      second.close();
    }
  });
});

test("an in-memory database is used without a data directory", () => {
  const database = openDatabase();
  try {
    assert.equal(database.prepare("PRAGMA journal_mode").get()?.journal_mode, "memory");
  } finally {
    database.close();
  }
});

test("a missing, non-directory or read-only data directory fails startup with a generic error", async () => {
  await usingDirectory(async (directory) => {
    const missing = join(directory, "missing");
    const file = join(directory, "file");
    await writeFile(file, "not a directory");
    const generic = (error: unknown): boolean => error instanceof Error
      && /GAUNTLET_DATA_DIR/.test(error.message)
      && !error.message.includes(directory);

    assert.throws(() => openDatabase({ dataDir: missing }), generic);
    assert.throws(() => openDatabase({ dataDir: file }), generic);
    assert.throws(() => openDatabase({ dataDir: "" }), generic);
    if (process.getuid?.() !== 0) {
      const readOnly = join(directory, "read-only");
      await mkdtemp(readOnly).then(async (created) => {
        await chmod(created, 0o500);
        assert.throws(() => openDatabase({ dataDir: created }), generic);
        await chmod(created, 0o700);
      });
    }

    await assert.rejects(
      createApp({ environment: serverEnvironment, targets: [fakeTarget], fetch: createFakeAdapter().fetch, dataDir: missing }),
      generic,
    );
    await assert.rejects(
      createConfiguredApp({ GAUNTLET_CONFIG_FILE: "/c.json", GAUNTLET_DATA_DIR: missing }, { readConfig }),
      generic,
    );
  });
});
