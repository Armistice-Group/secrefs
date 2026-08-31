import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialCipher } from "./cipher.js";

const DATA_KEY_SPEC = "AES_256";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface KmsEnvelopeCipherOptions {
  /** KMS key id, ARN, or alias (e.g. `alias/secrefs-control-plane`). */
  keyId: string;
  region?: string;
  /** Injected for testing - defaults to a real KMSClient in `region`. */
  client?: Pick<KMSClient, "send">;
}

/**
 * Real envelope encryption via AWS KMS - the v1 production custody model
 * from docs/control-plane-design.md §4:
 *
 *   1. `encrypt()`: ask KMS to `GenerateDataKey` under `keyId` - returns
 *      both a plaintext 256-bit data key and that same key encrypted
 *      ("wrapped") under the KMS key. The plaintext data key encrypts the
 *      credential locally (AES-256-GCM) and is discarded immediately -
 *      only the *wrapped* data key is ever stored, alongside the
 *      ciphertext, inside one self-describing envelope.
 *   2. `decrypt()`: ask KMS to `Decrypt` the wrapped data key back to
 *      plaintext - this only succeeds if the caller's IAM identity has
 *      `kms:Decrypt` on this key, which is the actual access-control
 *      boundary - then uses it to decrypt the ciphertext and discards it
 *      again.
 *
 * A fresh data key is minted on every `encrypt()` call rather than
 * reused/cached per org - standard envelope-encryption practice, and it
 * means a single leaked wrapped data key only ever exposes the one blob
 * it belongs to. `context` (e.g. `{ orgId }`) passes through as KMS's
 * `EncryptionContext` - authenticated, tamper-evident, and logged on
 * every KMS API call in CloudTrail; decrypting with a different context
 * than what was used to encrypt fails at the KMS API itself, before any
 * local crypto runs at all.
 */
export class KmsEnvelopeCipher implements CredentialCipher {
  private readonly client: Pick<KMSClient, "send">;
  private readonly keyId: string;

  constructor(options: KmsEnvelopeCipherOptions) {
    this.keyId = options.keyId;
    this.client = options.client ?? new KMSClient({ region: options.region });
  }

  async encrypt(plaintext: string, context?: Record<string, string>): Promise<string> {
    const response = await this.client.send(
      new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: DATA_KEY_SPEC, EncryptionContext: context }),
    );
    if (!response.Plaintext || !response.CiphertextBlob) {
      throw new Error("KMS GenerateDataKey returned no key material");
    }

    const dataKey = Buffer.from(response.Plaintext);
    try {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, dataKey, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const wrappedDataKey = Buffer.from(response.CiphertextBlob);

      // Self-describing envelope so decrypt() needs no side-channel:
      // [4-byte wrapped-key length][wrapped data key][iv][authTag][ciphertext].
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(wrappedDataKey.length);
      return Buffer.concat([lengthPrefix, wrappedDataKey, iv, authTag, encrypted]).toString("base64");
    } finally {
      dataKey.fill(0); // best-effort: don't let the plaintext data key linger in memory
    }
  }

  async decrypt(ciphertext: string, context?: Record<string, string>): Promise<string> {
    const raw = Buffer.from(ciphertext, "base64");
    const wrappedKeyLength = raw.readUInt32BE(0);
    let offset = 4;
    const wrappedDataKey = raw.subarray(offset, offset + wrappedKeyLength);
    offset += wrappedKeyLength;
    const iv = raw.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const authTag = raw.subarray(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;
    const encrypted = raw.subarray(offset);

    const response = await this.client.send(
      // Specifying KeyId here (technically optional in the KMS API) is
      // deliberate defense-in-depth: Decrypt only succeeds if the
      // ciphertext was actually wrapped by *this* key, not just any key
      // this caller happens to have kms:Decrypt on.
      new DecryptCommand({ CiphertextBlob: wrappedDataKey, KeyId: this.keyId, EncryptionContext: context }),
    );
    if (!response.Plaintext) {
      throw new Error("KMS Decrypt returned no key material");
    }

    const dataKey = Buffer.from(response.Plaintext);
    try {
      const decipher = createDecipheriv(ALGORITHM, dataKey, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } finally {
      dataKey.fill(0);
    }
  }
}
