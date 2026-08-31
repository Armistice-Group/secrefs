import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";

export type ControlPlaneDb = Database.Database;

/**
 * Opens the control plane's SQLite database and brings it up to the
 * latest schema via `runMigrations` (see migrations/). Pass `:memory:`
 * (the default) for tests/dev; pass a file path for anything that needs
 * to survive a restart.
 */
export function openDatabase(path = ":memory:"): ControlPlaneDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  adoptPreMigrationSchema(db);
  runMigrations(db, MIGRATIONS);
  return db;
}

/**
 * One-time compatibility shim for a database file created by the
 * original v1 scaffold (PR #3, before migrations existed - schema.ts's
 * raw `db.exec(SCHEMA_SQL)`). Such a database already has every table
 * `0001_init` would create, but no `_migrations` record of it - without
 * this, `runMigrations` would try to `CREATE TABLE organizations` over
 * one that already exists and crash the server on startup for anyone
 * who deployed before this migration framework shipped.
 *
 * Detects exactly that one case (the `organizations` table exists, but
 * `_migrations` doesn't yet) and marks `0001_init` applied without
 * re-running it. A brand-new database has neither table, so this is a
 * no-op there and `0001_init` runs normally via `runMigrations`.
 */
function adoptPreMigrationSchema(db: ControlPlaneDb): void {
  const hasOrganizationsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='organizations'")
    .get();
  const hasMigrationsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
    .get();
  if (!hasOrganizationsTable || hasMigrationsTable) return;

  db.exec(`
    CREATE TABLE _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO _migrations (id) VALUES (?)").run("0001_init");
}
