import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmCipher } from "../src/crypto/cipher.js";
import { KmsEnvelopeCipher } from "../src/crypto/kmsCipher.js";
import { CipherConfigError, selectCipher } from "../src/crypto/selectCipher.js";

describe("selectCipher", () => {
  it("chooses AesGcmCipher when only SECREFS_CP_CIPHER_KEY is set", () => {
    const cipher = selectCipher({ SECREFS_CP_CIPHER_KEY: randomBytes(32).toString("base64") });
    expect(cipher).toBeInstanceOf(AesGcmCipher);
  });

  it("chooses KmsEnvelopeCipher when SECREFS_CP_KMS_KEY_ID is set", () => {
    const cipher = selectCipher({ SECREFS_CP_KMS_KEY_ID: "alias/secrefs" });
    expect(cipher).toBeInstanceOf(KmsEnvelopeCipher);
  });

  it("prefers KMS when both are set", () => {
    const cipher = selectCipher({
      SECREFS_CP_KMS_KEY_ID: "alias/secrefs",
      SECREFS_CP_CIPHER_KEY: randomBytes(32).toString("base64"),
    });
    expect(cipher).toBeInstanceOf(KmsEnvelopeCipher);
  });

  it("throws CipherConfigError with actionable instructions when neither is set", () => {
    expect(() => selectCipher({})).toThrow(CipherConfigError);
    expect(() => selectCipher({})).toThrow(/SECREFS_CP_KMS_KEY_ID/);
    expect(() => selectCipher({})).toThrow(/SECREFS_CP_CIPHER_KEY/);
  });
});
