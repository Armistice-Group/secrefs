import type { Migration } from "./types.js";

/**
 * Workload-identity federation (docs/control-plane-design.md §9): a
 * `ServiceIdentity` can be trusted via one or more OIDC issuer/subject
 * bindings instead of (or alongside) a bootstrap token - no static,
 * long-lived credential for a CI job to leak. `subject_pattern` uses the
 * same glob-lite matching as `Grant.path_pattern` (rbac/match.ts): exact
 * match, a trailing `/*` prefix match, or a bare `*`.
 *
 * Example: a GitHub Actions workflow's `sub` claim looks like
 * `repo:acme/api:ref:refs/heads/main` - a binding with that exact
 * `subject_pattern` trusts only that one repo+branch; ...`:ref:refs/*`
 * would trust any ref in that repo.
 */
export const migration_0002_oidc_bindings: Migration = {
  id: "0002_oidc_bindings",
  up: async (db) => {
    await db.exec(`
      CREATE TABLE oidc_bindings (
        id TEXT PRIMARY KEY,
        service_identity_id TEXT NOT NULL REFERENCES service_identities(id),
        issuer TEXT NOT NULL,
        subject_pattern TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_oidc_bindings_issuer ON oidc_bindings(issuer);
    `);
  },
};
