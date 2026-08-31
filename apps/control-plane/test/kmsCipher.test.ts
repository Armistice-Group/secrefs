import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { KMSClient } from "@aws-sdk/client-kms";
import { KmsEnvelopeCipher } from "../src/crypto/kmsCipher.js";

/**
 * A fake KMS that actually implements GenerateDataKey/Decrypt correctly
 * (real AES key generation, real wrap/unwrap via a fixed test "master
 * key") rather than just returning canned bytes - so these tests exercise
 * the real envelope-encryption math in kmsCipher.ts, not just that it
 * calls the SDK with the right shape.
 */
function fakeKms(): { client: KMSClient; generateDataKey: ReturnType<typeof vi.fn>; decrypt: ReturnType<typeof vi.fn> } {
  const masterKey = randomBytes(32);

  function wrap(dataKey: Buffer, context?: Record<string, string>): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    if (context) cipher.setAAD(Buffer.from(JSON.stringify(context)));
    const encrypted = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  function unwrap(wrapped: Buffer, context?: Record<string, string>): Buffer {
    const iv = wrapped.subarray(0, 12);
    const authTag = wrapped.subarray(12, 28);
    const encrypted = wrapped.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
    if (context) decipher.setAAD(Buffer.from(JSON.stringify(context)));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  const generateDataKey = vi.fn(async (command: { input: { EncryptionContext?: Record<string, string> } }) => {
    const dataKey = randomBytes(32);
    return { Plaintext: dataKey, CiphertextBlob: wrap(dataKey, command.input.EncryptionContext) };
  });

  const decrypt = vi.fn(async (command: { input: { CiphertextBlob: Uint8Array; EncryptionContext?: Record<string, string> } }) => {
    const plaintext = unwrap(Buffer.from(command.input.CiphertextBlob), command.input.EncryptionContext);
    return { Plaintext: plaintext };
  });

  const client = {
    send: vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
      if (command.constructor.name === "GenerateDataKeyCommand") {
        return generateDataKey(command as never);
      }
      if (command.constructor.name === "DecryptCommand") {
        return decrypt(command as never);
      }
      throw new Error(`unexpected command: ${command.constructor.name}`);
    }),
  } as unknown as KMSClient;

  return { client, generateDataKey, decrypt };
}

describe("KmsEnvelopeCipher", () => {
  it("round-trips plaintext through GenerateDataKey + local AES-GCM + Decrypt", async () => {
    const { client, generateDataKey, decrypt } = fakeKms();
    const cipher = new KmsEnvelopeCipher({ keyId: "alias/secrefs-test", client });

    const plaintext = JSON.stringify({ roleArn: "arn:aws:iam::111111111111:role/Example" });
    const ciphertext = await cipher.encrypt(plaintext);
    expect(ciphertext).not.toContain("roleArn");
    expect(generateDataKey).toHaveBeenCalledTimes(1);

    expect(await cipher.decrypt(ciphertext)).toBe(plaintext);
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it("passes the keyId and encryption context through to KMS on both calls", async () => {
    const { client, generateDataKey, decrypt } = fakeKms();
    const cipher = new KmsEnvelopeCipher({ keyId: "alias/secrefs-test", client });

    const ciphertext = await cipher.encrypt("secret", { orgId: "org-1" });
    await cipher.decrypt(ciphertext, { orgId: "org-1" });

    expect(generateDataKey.mock.calls[0]![0].input.KeyId).toBe("alias/secrefs-test");
    expect(generateDataKey.mock.calls[0]![0].input.EncryptionContext).toEqual({ orgId: "org-1" });
    expect(decrypt.mock.calls[0]![0].input.KeyId).toBe("alias/secrefs-test");
    expect(decrypt.mock.calls[0]![0].input.EncryptionContext).toEqual({ orgId: "org-1" });
  });

  it("a fresh data key is minted on every encrypt() call, not reused", async () => {
    const { client, generateDataKey } = fakeKms();
    const cipher = new KmsEnvelopeCipher({ keyId: "alias/secrefs-test", client });

    await cipher.encrypt("one");
    await cipher.encrypt("two");

    expect(generateDataKey).toHaveBeenCalledTimes(2);
  });

  it("decrypting with a different context than was used to encrypt fails", async () => {
    const { client } = fakeKms();
    const cipher = new KmsEnvelopeCipher({ keyId: "alias/secrefs-test", client });

    const ciphertext = await cipher.encrypt("secret", { orgId: "org-1" });
    await expect(cipher.decrypt(ciphertext, { orgId: "org-2" })).rejects.toThrow();
  });

  it("propagates a KMS error cleanly (e.g. access denied) rather than swallowing it", async () => {
    const client = {
      send: vi.fn().mockRejectedValue(new Error("AccessDeniedException: not authorized")),
    } as unknown as KMSClient;
    const cipher = new KmsEnvelopeCipher({ keyId: "alias/secrefs-test", client });

    await expect(cipher.encrypt("secret")).rejects.toThrow(/not authorized/);
  });
});
