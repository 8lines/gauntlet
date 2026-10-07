import { accessSync, constants, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

/** The database file inside `GAUNTLET_DATA_DIR`. */
export const DATABASE_FILE_NAME = "gauntlet.sqlite";

/** Numbered, append-only schema changes. A released migration is never edited. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    sql: `CREATE TABLE pins (
  principal_id TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  pinned_at    TEXT NOT NULL,
  PRIMARY KEY (principal_id, target_id, operation_id)
) WITHOUT ROWID;`,
  }),
]);

export interface OpenDatabaseOptions {
  /** Existing, writable directory for `gauntlet.sqlite`. Omitted ⇒ the database lives in memory. */
  readonly dataDir?: string;
  /** Records when each migration was applied. */
  readonly clock?: () => Date;
}

function dataDirError(): TypeError {
  return new TypeError("GAUNTLET_DATA_DIR must name an existing, writable directory");
}

function databaseFile(dataDir: string): string {
  if (dataDir.length === 0) throw dataDirError();
  try {
    const directory = resolve(dataDir);
    if (!statSync(directory).isDirectory()) throw dataDirError();
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return join(directory, DATABASE_FILE_NAME);
  } catch {
    throw dataDirError();
  }
}

/**
 * Opens Gauntlet's database and brings its schema up to date. Failures are generic so that
 * startup never reveals the configured path or SQLite internals.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): Database {
  const file = options.dataDir === undefined ? ":memory:" : databaseFile(options.dataDir);
  let database: Database | undefined;
  try {
    database = new DatabaseSync(file);
    if (file !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
    applyMigrations(database, options.clock ?? (() => new Date()));
    return database;
  } catch {
    try {
      database?.close();
    } catch {
      // Keep the generic startup failure.
    }
    throw new TypeError(file === ":memory:"
      ? "Gauntlet could not open its database"
      : "Gauntlet could not open its database in GAUNTLET_DATA_DIR");
  }
}

/** Applies every migration newer than the recorded version, each in its own transaction. */
export function applyMigrations(database: Database, clock: () => Date, migrations: readonly Migration[] = MIGRATIONS): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)),
  );
  const record = database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      record.run(migration.version, clock().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
