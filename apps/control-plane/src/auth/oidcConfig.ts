import type { OidcConfig, TrustedOidcIssuer } from "./oidc.js";

/** GitHub Actions' fixed, well-known OIDC issuer + JWKS - see
 * https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect */
export const GITHUB_ACTIONS_OIDC_ISSUER: TrustedOidcIssuer = {
  issuer: "https://token.actions.githubusercontent.com",
  jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
};

/** GitLab's OIDC issuer + JWKS, for gitlab.com by default or a
 * self-managed instance's base URL. */
export function gitlabOidcIssuer(baseUrl = "https://gitlab.com"): TrustedOidcIssuer {
  const normalized = baseUrl.replace(/\/$/, "");
  return { issuer: normalized, jwksUrl: `${normalized}/oauth/discovery/keys` };
}

export interface OidcEnv {
  SECREFS_CP_OIDC_AUDIENCE?: string;
  /** "true" to trust GitHub Actions' fixed issuer. */
  SECREFS_CP_OIDC_GITHUB_ACTIONS?: string;
  /** "true" for gitlab.com, or a self-managed instance's base URL. */
  SECREFS_CP_OIDC_GITLAB?: string;
  /** JSON `TrustedOidcIssuer[]` - the fully generic/configurable escape
   * hatch for any other OIDC-compliant issuer (Okta, Auth0, a
   * self-hosted IdP). */
  SECREFS_CP_TRUSTED_OIDC_ISSUERS?: string;
}

/**
 * Assembles `OidcConfig` from environment configuration. Returns
 * `undefined` (OIDC simply disabled, every principal must use a
 * bootstrap token) when no issuer is configured at all - that's a valid,
 * common setup, not an error. Throws only for a genuine misconfiguration:
 * malformed JSON, or an issuer configured with no audience to check
 * tokens against.
 */
export function buildOidcConfigFromEnv(env: OidcEnv): OidcConfig | undefined {
  const trustedIssuers: TrustedOidcIssuer[] = [];

  if (env.SECREFS_CP_OIDC_GITHUB_ACTIONS === "true") {
    trustedIssuers.push(GITHUB_ACTIONS_OIDC_ISSUER);
  }
  if (env.SECREFS_CP_OIDC_GITLAB) {
    const base = env.SECREFS_CP_OIDC_GITLAB === "true" ? undefined : env.SECREFS_CP_OIDC_GITLAB;
    trustedIssuers.push(gitlabOidcIssuer(base));
  }
  if (env.SECREFS_CP_TRUSTED_OIDC_ISSUERS) {
    let custom: TrustedOidcIssuer[];
    try {
      custom = JSON.parse(env.SECREFS_CP_TRUSTED_OIDC_ISSUERS) as TrustedOidcIssuer[];
    } catch (err) {
      throw new Error(
        `SECREFS_CP_TRUSTED_OIDC_ISSUERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    trustedIssuers.push(...custom);
  }

  if (trustedIssuers.length === 0) return undefined;

  if (!env.SECREFS_CP_OIDC_AUDIENCE) {
    throw new Error(
      "At least one trusted OIDC issuer is configured, but SECREFS_CP_OIDC_AUDIENCE is not set - " +
        "required so a token minted for some other audience can't be replayed against this server.",
    );
  }

  return { trustedIssuers, audience: env.SECREFS_CP_OIDC_AUDIENCE };
}
