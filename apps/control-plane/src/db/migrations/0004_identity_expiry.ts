import type { Migration } from "./types.js";

/**
 * Expiry and last-use tracking for service identity bootstrap tokens.
 *
 * Before this, a bootstrap token never expired. A long-lived static
 * credential with no expiry is exactly the thing SecRefs argues against,
 * so shipping one in our own auth layer was an awkward look - and the
 * only way to retire one was to delete the identity, which also destroys
 * its role bindings and its audit trail.
 *
 * `expires_at` is nullable and defaults to NULL, so every existing
 * identity keeps working exactly as before. Expiry is opt-in per
 * identity rather than a global default, because a forced expiry on
 * upgrade would silently break every deployed workload at once.
 *
 * `last_used_at` is the more useful half in practice. It answers "which
 * identities has nobody used in six months", which is where the real
 * risk sits: not the token someone rotates on schedule, but the one
 * everybody forgot exists.
 */
export const migration_0004_identity_expiry: Migration = {
  id: "0004_identity_expiry",
  up: async (db) => {
    // Separate ALTER statements, not one multi-column form: SQLite's
    // ALTER TABLE accepts exactly one ADD COLUMN per statement.
    await db.exec(`
      ALTER TABLE service_identities ADD COLUMN expires_at TEXT;
    `);
    await db.exec(`
      ALTER TABLE service_identities ADD COLUMN last_used_at TEXT;
    `);
    // Finding the stale identities is a listing operation per org, and
    // NULL sorts as "never used", which is exactly what we want first.
    await db.exec(`
      CREATE INDEX idx_service_identities_last_used
        ON service_identities(org_id, last_used_at);
    `);
  },
};
