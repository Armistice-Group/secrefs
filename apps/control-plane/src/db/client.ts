import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export type ControlPlaneDb = Database.Database;

/**
 * Opens (and idempotently schema-initializes) the control plane's SQLite
 * database. Pass `:memory:` (the default) for tests/dev; pass a file path
 * for anything that needs to survive a restart.
 */
export function openDatabase(path = ":memory:"): ControlPlaneDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}
