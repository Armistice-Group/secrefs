import { createHash, randomBytes } from "node:crypto";
import type { ControlPlaneRepo, ServiceIdentity } from "../db/repo.js";
import { matchesPathPattern } from "../rbac/match.js";
import { verifyOidcToken, type OidcConfig } from "./oidc.js";

/**
 * Generates a new bootstrap token and its stored hash together, so a
 * caller creating a `ServiceIdentity` never has to hash it separately (and
 * can't accidentally persist the plaintext by reusing the wrong value).
 * Docs §9: this is the fallback for platforms with no OIDC issuer to
 * federate against - workload identity federation (below) is preferred
 * wherever it's available.
 */
export function generateBootstrapToken(): { token: string; tokenHash: string } {
  const token = `sfcp_${randomBytes(24).toString("base64url")}`;
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolves a bearer token from an `Authorization: Bearer <token>` header
 * to the `ServiceIdentity` it belongs to, or `undefined` if it doesn't
 * match any known token/binding. Never throws on a bad/missing header,
 * an unverifiable OIDC token, or a token from an untrusted issuer -
 * every one of those is just "not a recognized principal" to the caller,
 * which turns `undefined` into a 401. The two auth modes are tried in
 * order, cheapest/most-common first:
 *
 *   1. Bootstrap token - a local hash lookup, no network call.
 *   2. OIDC workload identity (docs §9) - only attempted if the token has
 *      the three-segment shape of a JWT and `oidcConfig` is provided
 *      (i.e. the operator has configured at least one trusted issuer).
 *      Verifies the token (see auth/oidc.ts - this is the only step that
 *      makes a network call, to the matched issuer's *pinned* JWKS URL),
 *      then matches its `sub` claim against every `OidcBinding`
 *      registered for its `iss` using the same glob-lite pattern
 *      matching `Grant.path_pattern` already uses.
 */
export async function resolvePrincipal(
  repo: ControlPlaneRepo,
  authorizationHeader: string | undefined,
  oidcConfig?: OidcConfig,
): Promise<ServiceIdentity | undefined> {
  if (!authorizationHeader?.startsWith("Bearer ")) return undefined;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) return undefined;

  const byBootstrapToken = await repo.findServiceIdentityByTokenHash(hashToken(token));
  if (byBootstrapToken) return byBootstrapToken;

  if (!oidcConfig || token.split(".").length !== 3) return undefined;

  let claims;
  try {
    claims = await verifyOidcToken(token, oidcConfig);
  } catch {
    return undefined;
  }

  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  const iss = typeof claims.iss === "string" ? claims.iss : undefined;
  if (!sub || !iss) return undefined;

  const binding = (await repo.findOidcBindingsByIssuer(iss)).find((b) => matchesPathPattern(b.subject_pattern, sub));
  if (!binding) return undefined;

  return await repo.findServiceIdentityById(binding.service_identity_id);
}
