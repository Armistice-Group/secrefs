import { AesGcmCipher, type CredentialCipher } from "./cipher.js";
import { KmsEnvelopeCipher } from "./kmsCipher.js";

export interface CipherEnv {
  SECREFS_CP_KMS_KEY_ID?: string;
  SECREFS_CP_KMS_REGION?: string;
  SECREFS_CP_CIPHER_KEY?: string;
}

export class CipherConfigError extends Error {
  constructor() {
    super(
      "No credential cipher configured. Set either:\n" +
        "  SECREFS_CP_KMS_KEY_ID (+ optionally SECREFS_CP_KMS_REGION) for real AWS KMS " +
        "envelope encryption (production - see docs/control-plane-design.md §4), or\n" +
        "  SECREFS_CP_CIPHER_KEY for the local-dev static-key cipher (see cipher.ts). Generate " +
        "one with:\n" +
        '    node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
}

/**
 * Chooses the credential cipher from environment configuration:
 * `SECREFS_CP_KMS_KEY_ID` set -> real AWS KMS envelope encryption (the v1
 * production model, docs/control-plane-design.md §4); otherwise
 * `SECREFS_CP_CIPHER_KEY` -> the local-dev static-key AES-GCM cipher, a
 * legitimate choice for a self-hoster whose own infra's disk encryption
 * is their trust boundary (see apps/control-plane/README.md). Throws
 * `CipherConfigError` - never a bare stack trace - if neither is set.
 */
export function selectCipher(env: CipherEnv): CredentialCipher {
  if (env.SECREFS_CP_KMS_KEY_ID) {
    return new KmsEnvelopeCipher({ keyId: env.SECREFS_CP_KMS_KEY_ID, region: env.SECREFS_CP_KMS_REGION });
  }
  if (env.SECREFS_CP_CIPHER_KEY) {
    return new AesGcmCipher(env.SECREFS_CP_CIPHER_KEY);
  }
  throw new CipherConfigError();
}
