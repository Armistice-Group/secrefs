import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BaseSecretProvider,
  type ProviderHealth,
  type SecretFetchRequest,
  extractField,
} from "./base.js";

const DEFAULT_FILENAME = ".secrefs.local.json";

export interface LocalProviderOptions {
  /** Overrides the file path. Defaults to $SECREFS_LOCAL_FILE or ./.secrefs.local.json */
  filePath?: string;
  /** Keep the parsed file in memory instead of re-reading per fetch.
   * Off by default so edits take effect immediately. */
  cacheFile?: boolean;
}

/**
 * Reads secrets from a gitignored, developer-local JSON file. Intended for
 * local development only - never point this at anything checked into
 * version control. Each top-level key is a secret path; its value is either
 * a plain string (returned as-is when no `#field` is requested) or an
 * object (JSON-stringified, then field-extracted as needed).
 *
 * Example `.secrefs.local.json`:
 * ```json
 * { "mock-db": { "password": "hunter2", "user": "postgres" } }
 * ```
 */
export class LocalProvider extends BaseSecretProvider {
  readonly name = "local";

  private readonly filePath: string;
  /** Re-read on every fetch. The file is local and tiny, and caching
   * it meant editing it mid-session silently did nothing. */
  private cache: Record<string, unknown> | null = null;
  private readonly cacheFile: boolean;

  constructor(options: LocalProviderOptions = {}) {
    super();
    this.filePath =
      options.filePath ??
      process.env.SECREFS_LOCAL_FILE ??
      path.join(process.cwd(), DEFAULT_FILENAME);
    this.cacheFile = options.cacheFile ?? false;
  }

  private async load(): Promise<Record<string, unknown>> {
    if (this.cache && this.cacheFile) return this.cache;

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      throw new Error(
        `[local] could not read local secrets file at "${this.filePath}": ${
          err instanceof Error ? err.message : String(err)
        }. This file is gitignored by convention - see .secrefs.local.json in .gitignore.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `[local] "${this.filePath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`[local] "${this.filePath}" must contain a top-level JSON object`);
    }

    this.cache = parsed as Record<string, unknown>;
    return this.cache;
  }

  async fetchOne(request: SecretFetchRequest): Promise<string> {
    const data = await this.load();
    if (!(request.path in data)) {
      throw new Error(`[local] no entry for path "${request.path}" in ${this.filePath}`);
    }

    const entry = data[request.path];
    const raw = typeof entry === "string" ? entry : JSON.stringify(entry);
    return extractField(raw, request.field, { provider: this.name, path: request.path });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.load();
      return { provider: this.name, ok: true, message: this.filePath };
    } catch (err) {
      return {
        provider: this.name,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
