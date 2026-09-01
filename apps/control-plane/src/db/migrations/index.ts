import type { Migration } from "./types.js";
import { migration_0001_init } from "./0001_init.js";
import { migration_0002_oidc_bindings } from "./0002_oidc_bindings.js";
import { migration_0003_org_admins } from "./0003_org_admins.js";
import { migration_0004_identity_expiry } from "./0004_identity_expiry.js";

/** Applied in this exact order - append new migrations to the end, never
 * reorder or edit a shipped one. See types.ts for the contract. */
export const MIGRATIONS: Migration[] = [
  migration_0001_init,
  migration_0002_oidc_bindings,
  migration_0003_org_admins,
  migration_0004_identity_expiry,
];
