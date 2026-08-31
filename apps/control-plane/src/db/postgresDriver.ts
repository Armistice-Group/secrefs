import pg from "pg";
import { toPostgresPlaceholders, type DbDriver } from "./driver.js";

export interface PostgresDriverOptions {
  connectionString: string;
  /** Verify the server's TLS certificate. Defaults on, and should stay on
   * against RDS - the only reason to turn it off is a local container
   * with a self-signed cert. */
  ssl?: boolean;
  max?: number;
}

/**
 * Postgres backend, for hosted deployments. Uses a pool rather than a
 * single connection so concurrent requests don't serialize behind each
 * other, with `transaction()` checking out one dedicated client for the
 * duration so BEGIN/COMMIT can't land on different connections.
 */
export class PostgresDriver implements DbDriver {
  readonly dialect = "postgres" as const;
  private readonly pool: pg.Pool;
  /** Set while a transaction holds a client, so queries made inside `fn`
   * run on that same connection rather than a different pooled one. */
  private transactionClient: pg.PoolClient | undefined;

  constructor(options: PostgresDriverOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      ssl: options.ssl === false ? undefined : { rejectUnauthorized: true },
    });
  }

  private async query<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<pg.QueryResult<T>> {
    const text = toPostgresPlaceholders(sql);
    if (this.transactionClient) return this.transactionClient.query<T>(text, params);
    return this.pool.query<T>(text, params);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.query<pg.QueryResultRow>(sql, params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.query<pg.QueryResultRow>(sql, params);
    return result.rows[0] as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }

  async exec(sql: string): Promise<void> {
    // Multi-statement DDL, no parameters - so no placeholder rewriting,
    // which matters because migration SQL can legitimately contain a `?`
    // inside a comment or a CHECK constraint's string literal.
    if (this.transactionClient) {
      await this.transactionClient.query(sql);
      return;
    }
    await this.pool.query(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.transactionClient) {
      throw new Error("nested transactions are not supported");
    }
    const client = await this.pool.connect();
    this.transactionClient = client;
    try {
      await client.query("BEGIN");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        // A rollback failure means the connection is already broken;
        // surfacing it would mask the original error, which is the one
        // worth seeing.
      });
      throw err;
    } finally {
      this.transactionClient = undefined;
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
