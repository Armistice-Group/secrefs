import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts/decrypts the credential blob stored on a `VaultConnection`
 * (docs/control-plane-design.md §4). Pluggable so production can swap in
 * real envelope encryption via a cloud KMS without touching call sites -
 * every caller only ever sees this interface.
 */
export interface CredentialCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * AES-256-GCM with a single static key from the environment. This is the
 * *local-dev / self-hosted* implementation - it proves the interface and
 * is genuinely at-rest-encrypted, but it is NOT the v1 production design
 * from docs §4 (per-org data keys, envelope-encrypted under a cloud KMS
 * key, decryptable only by the control plane's own runtime role). Swap in
 * a `KmsEnvelopeCipher` implementing the same interface before handling
 * real org credentials.
 */
export class AesGcmCipher implements CredentialCipher {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) {
      throw new Error(
        `AesGcmCipher key must decode to exactly 32 bytes (got ${key.length}). ` +
          `Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // iv || authTag || ciphertext, base64-encoded as one opaque blob.
    return Buffer.concat([iv, authTag, encrypted]).toString("base64");
  }

  decrypt(ciphertext: string): string {
    const raw = Buffer.from(ciphertext, "base64");
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
    const encrypted = raw.subarray(IV_LENGTH + 16);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}
