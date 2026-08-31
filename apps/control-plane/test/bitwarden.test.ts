import { describe, expect, it } from "vitest";
import { distributeBitwardenCredential } from "../src/providers/bitwarden.js";

describe("distributeBitwardenCredential", () => {
  it("hands back the stored access token and organizationId as-is", async () => {
    const result = distributeBitwardenCredential({
      accessToken: "0.machine-account-token",
      organizationId: "org-123",
    });
    expect(result.accessToken).toBe("0.machine-account-token");
    expect(result.organizationId).toBe("org-123");
  });

  it("includes a note that this is not a freshly minted, re-scoped credential", async () => {
    const result = distributeBitwardenCredential({ accessToken: "token" });
    expect(result.note).toMatch(/not.*freshly minted/i);
  });

  it("organizationId is optional", async () => {
    const result = distributeBitwardenCredential({ accessToken: "token" });
    expect(result.organizationId).toBeUndefined();
  });
});
