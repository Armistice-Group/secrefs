import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmCipher } from "../src/crypto/cipher.js";

describe("AesGcmCipher", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips plaintext through encrypt/decrypt", async () => {
    const cipher = new AesGcmCipher(key);
    const plaintext = JSON.stringify({ roleArn: "arn:aws:iam::111111111111:role/Example", region: "us-east-1" });
    const ciphertext = await cipher.encrypt(plaintext);
    expect(ciphertext).not.toContain("roleArn");
    expect(await cipher.decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext (random IV per call)", async () => {
    const cipher = new AesGcmCipher(key);
    const a = await cipher.encrypt("same plaintext");
    const b = await cipher.encrypt("same plaintext");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key (authenticated encryption catches tampering/wrong key)", async () => {
    const cipher = new AesGcmCipher(key);
    const other = new AesGcmCipher(randomBytes(32).toString("base64"));
    const ciphertext = await cipher.encrypt("secret");
    await expect(other.decrypt(ciphertext)).rejects.toThrow();
  });

  it("rejects a key that isn't exactly 32 bytes", async () => {
    expect(() => new AesGcmCipher(Buffer.from("too-short").toString("base64"))).toThrow(/32 bytes/);
  });

  it("round-trips with a context, and rejects decryption with a different context", async () => {
    const cipher = new AesGcmCipher(key);
    const ciphertext = await cipher.encrypt("secret", { orgId: "org-1" });
    expect(await cipher.decrypt(ciphertext, { orgId: "org-1" })).toBe("secret");
    await expect(cipher.decrypt(ciphertext, { orgId: "org-2" })).rejects.toThrow();
    await expect(cipher.decrypt(ciphertext)).rejects.toThrow();
  });
});
