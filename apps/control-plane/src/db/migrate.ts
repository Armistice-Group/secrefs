import type { ControlPlaneDb } from "./client.js";
import type { Migration } from "./migrations/types.js";

const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/**
 * Applies every migration in `migrations` that isn't already recorded in
 * `_migrations`, in order, each inside its own transaction (so a failed
 * migration never leaves the schema half-applied and unrecorded - it
 * either fully lands and is marked applied, or the whole thing rolls
 * back and the process should not start).
 *
 * Idempotent and safe to call on every boot: an already-initialized
 * database just finds nothing new to apply. Returns the ids of whatever
 * ran this call (empty on a database that was already up to date).
 */
export function runMigrations(db: ControlPlaneDb, migrations: Migration[]): string[] {
  db.exec(MIGRATIONS_TABLE_SQL);

  const alreadyApplied = new Set(
    (db.prepare("SELECT id FROM _migrations").all() as { id: string }[]).map((row) => row.id),
  );

  const ran: string[] = [];
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.id)) continue;

    const applyAndRecord = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
    });
    applyAndRecord();
    ran.push(migration.id);
  }

  return ran;
}
