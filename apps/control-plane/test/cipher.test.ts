import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmCipher } from "../src/crypto/cipher.js";

describe("AesGcmCipher", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips plaintext through encrypt/decrypt", () => {
    const cipher = new AesGcmCipher(key);
    const plaintext = JSON.stringify({ roleArn: "arn:aws:iam::111111111111:role/Example", region: "us-east-1" });
    const ciphertext = cipher.encrypt(plaintext);
    expect(ciphertext).not.toContain("roleArn");
    expect(cipher.decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext (random IV per call)", () => {
    const cipher = new AesGcmCipher(key);
    const a = cipher.encrypt("same plaintext");
    const b = cipher.encrypt("same plaintext");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key (authenticated encryption catches tampering/wrong key)", () => {
    const cipher = new AesGcmCipher(key);
    const other = new AesGcmCipher(randomBytes(32).toString("base64"));
    const ciphertext = cipher.encrypt("secret");
    expect(() => other.decrypt(ciphertext)).toThrow();
  });

  it("rejects a key that isn't exactly 32 bytes", () => {
    expect(() => new AesGcmCipher(Buffer.from("too-short").toString("base64"))).toThrow(/32 bytes/);
  });
});
