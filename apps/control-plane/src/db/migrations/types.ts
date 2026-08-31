import type { ControlPlaneDb } from "../client.js";

export interface Migration {
  /**
   * Sorted lexicographically to determine run order - zero-pad the
   * numeric prefix (`0001_`, `0002_`, ...) so that ordering survives past
   * migration 9. Never rename or renumber a migration once it has shipped
   * - `id` is the primary key `runMigrations` uses to know it already ran.
   */
  id: string;
  /** Applied inside a transaction - either the whole migration lands and
   * gets recorded as applied, or none of it does. Never write raw DDL/DML
   * outside this function for a migration; `runMigrations` won't see it. */
  up: (db: ControlPlaneDb) => void;
}
