import { buildApp } from "./app.js";
import { createContext } from "./context.js";
import { openDatabase } from "./db/client.js";
import { CipherConfigError, selectCipher } from "./crypto/selectCipher.js";
import { buildOidcConfigFromEnv } from "./auth/oidcConfig.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.SECREFS_CP_DB_PATH ?? "./control-plane.sqlite3";

let cipher;
try {
  cipher = selectCipher(process.env);
} catch (err) {
  if (err instanceof CipherConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

let oidcConfig;
try {
  oidcConfig = buildOidcConfigFromEnv(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const db = openDatabase(DB_PATH);
const ctx = createContext(db, cipher, { oidcConfig });
const app = buildApp(ctx);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    const oidcNote = oidcConfig
      ? `, OIDC issuers: ${oidcConfig.trustedIssuers.map((t) => t.issuer).join(", ")}`
      : ", OIDC: not configured (bootstrap tokens only)";
    console.log(`secrefs control plane listening on :${PORT} (db: ${DB_PATH}${oidcNote})`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
