import { describe, expect, it } from "vitest";
import { buildOidcConfigFromEnv, GITHUB_ACTIONS_OIDC_ISSUER, gitlabOidcIssuer } from "../src/auth/oidcConfig.js";

describe("buildOidcConfigFromEnv", () => {
  it("returns undefined when nothing is configured - OIDC simply disabled", async () => {
    expect(buildOidcConfigFromEnv({})).toBeUndefined();
  });

  it("enables the GitHub Actions preset", async () => {
    const config = buildOidcConfigFromEnv({
      SECREFS_CP_OIDC_GITHUB_ACTIONS: "true",
      SECREFS_CP_OIDC_AUDIENCE: "https://cp.example.com",
    });
    expect(config?.trustedIssuers).toEqual([GITHUB_ACTIONS_OIDC_ISSUER]);
  });

  it("enables the GitLab preset for gitlab.com when set to \"true\"", async () => {
    const config = buildOidcConfigFromEnv({
      SECREFS_CP_OIDC_GITLAB: "true",
      SECREFS_CP_OIDC_AUDIENCE: "https://cp.example.com",
    });
    expect(config?.trustedIssuers).toEqual([gitlabOidcIssuer()]);
  });

  it("enables the GitLab preset for a self-managed instance URL", async () => {
    const config = buildOidcConfigFromEnv({
      SECREFS_CP_OIDC_GITLAB: "https://gitlab.acme.internal",
      SECREFS_CP_OIDC_AUDIENCE: "https://cp.example.com",
    });
    expect(config?.trustedIssuers).toEqual([gitlabOidcIssuer("https://gitlab.acme.internal")]);
  });

  it("supports the generic/configurable escape hatch alongside presets", async () => {
    const config = buildOidcConfigFromEnv({
      SECREFS_CP_OIDC_GITHUB_ACTIONS: "true",
      SECREFS_CP_TRUSTED_OIDC_ISSUERS: JSON.stringify([
        { issuer: "https://okta.example.com", jwksUrl: "https://okta.example.com/jwks" },
      ]),
      SECREFS_CP_OIDC_AUDIENCE: "https://cp.example.com",
    });
    expect(config?.trustedIssuers).toEqual([
      GITHUB_ACTIONS_OIDC_ISSUER,
      { issuer: "https://okta.example.com", jwksUrl: "https://okta.example.com/jwks" },
    ]);
  });

  it("throws a clear error for malformed SECREFS_CP_TRUSTED_OIDC_ISSUERS JSON", async () => {
    expect(() =>
      buildOidcConfigFromEnv({
        SECREFS_CP_TRUSTED_OIDC_ISSUERS: "{not json",
        SECREFS_CP_OIDC_AUDIENCE: "https://cp.example.com",
      }),
    ).toThrow(/not valid JSON/);
  });

  it("throws when an issuer is configured but no audience is set", async () => {
    expect(() => buildOidcConfigFromEnv({ SECREFS_CP_OIDC_GITHUB_ACTIONS: "true" })).toThrow(
      /SECREFS_CP_OIDC_AUDIENCE/,
    );
  });
});
