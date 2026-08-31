import { runMigrations } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import type { DbDriver } from "./driver.js";
import { SqliteDriver } from "./sqliteDriver.js";
import { PostgresDriver } from "./postgresDriver.js";

/** Kept as the name the rest of the codebase already imports; it's the
 * driver interface now rather than a better-sqlite3 handle. */
export type ControlPlaneDb = DbDriver;

export interface OpenDatabaseOptions {
  /** Postgres connection string. Takes precedence over `sqlitePath` - a
   * deployment that has provisioned a database means to use it. */
  databaseUrl?: string;
  /** SQLite file path. `:memory:` (the default) for tests. */
  sqlitePath?: string;
  /** Verify the Postgres server's TLS certificate. Turn off only for a
   * local container with a self-signed cert; leave on against RDS. */
  ssl?: boolean;
}

/**
 * Opens the control plane's database and brings it up to the latest
 * schema via `runMigrations` (see migrations/). Which backend you get is
 * decided by what's configured rather than a mode flag: `databaseUrl`
 * means Postgres, otherwise SQLite at `sqlitePath`.
 */
export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<DbDriver> {
  const db: DbDriver = options.databaseUrl
    ? new PostgresDriver({ connectionString: options.databaseUrl, ssl: options.ssl })
    : new SqliteDriver(options.sqlitePath ?? ":memory:");

  await adoptPreMigrationSchema(db);
  await runMigrations(db, MIGRATIONS);
  return db;
}

/**
 * One-time compatibility shim for a SQLite file created by the original
 * v1 scaffold (PR #3, before migrations existed - schema.ts's raw
 * `db.exec(SCHEMA_SQL)`). Such a database already has every table
 * `0001_init` would create, but no `_migrations` record of it - without
 * this, `runMigrations` would try to `CREATE TABLE organizations` over
 * one that already exists and crash the server on startup for anyone who
 * deployed before the migration framework shipped.
 *
 * Detects exactly that one case and marks `0001_init` applied without
 * re-running it. A brand-new database has neither table, so this is a
 * no-op there and `0001_init` runs normally.
 *
 * Postgres can't be in that state: Postgres support arrived after
 * migrations did, so there is no pre-migration Postgres database to
 * adopt anywhere.
 */
async function adoptPreMigrationSchema(db: DbDriver): Promise<void> {
  if (db.dialect !== "sqlite") return;

  const hasOrganizationsTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='organizations'",
  );
  const hasMigrationsTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'",
  );
  if (!hasOrganizationsTable || hasMigrationsTable) return;

  await db.exec(`
    CREATE TABLE _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.run("INSERT INTO _migrations (id) VALUES (?)", ["0001_init"]);
}
