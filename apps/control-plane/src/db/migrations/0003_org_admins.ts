import type { Migration } from "./types.js";

/**
 * Human admin accounts (WorkOS-authenticated, `auth/workos.ts`) and the
 * org-level plan/tier they're gated by. Every management endpoint
 * (connections, roles, grants, service identities) now requires the
 * caller to be an admin of the target org - see routes/*.ts. Before this
 * migration, those endpoints had no authentication at all.
 *
 * `organizations.plan` defaults to `'free'`: the connection-count limit
 * enforced in routes/connections.ts. `'paid'` orgs are unlimited today -
 * no separate limit-per-plan table yet, add one if/when there's more
 * than two tiers to express.
 */
export const migration_0003_org_admins: Migration = {
  id: "0003_org_admins",
  up: (db) => {
    db.exec(`
      ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'paid'));

      CREATE TABLE org_admins (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        workos_user_id TEXT NOT NULL,
        email TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (org_id, workos_user_id)
      );

      CREATE INDEX idx_org_admins_workos_user_id ON org_admins(workos_user_id);
    `);
  },
};
