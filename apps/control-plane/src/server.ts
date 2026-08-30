import { buildApp } from "./app.js";
import { createContext } from "./context.js";
import { openDatabase } from "./db/client.js";
import { AesGcmCipher } from "./crypto/cipher.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.SECREFS_CP_DB_PATH ?? "./control-plane.sqlite3";
const CIPHER_KEY = process.env.SECREFS_CP_CIPHER_KEY;

if (!CIPHER_KEY) {
  console.error(
    "SECREFS_CP_CIPHER_KEY is not set. Generate one with:\n" +
      "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"\n" +
      "See src/crypto/cipher.ts - this is the local-dev cipher, not the KMS-backed " +
      "design in docs/control-plane-design.md §4.",
  );
  process.exit(1);
}

const db = openDatabase(DB_PATH);
const ctx = createContext(db, new AesGcmCipher(CIPHER_KEY));
const app = buildApp(ctx);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`secrefs control plane listening on :${PORT} (db: ${DB_PATH})`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
