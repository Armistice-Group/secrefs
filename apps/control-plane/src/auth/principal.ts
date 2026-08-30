import { createHash, randomBytes } from "node:crypto";
import type { ControlPlaneRepo, ServiceIdentity } from "../db/repo.js";

/**
 * Generates a new bootstrap token and its stored hash together, so a
 * caller creating a `ServiceIdentity` never has to hash it separately (and
 * can't accidentally persist the plaintext by reusing the wrong value).
 * Docs §9: this is the fallback for platforms with no OIDC issuer to
 * federate against - workload identity federation is preferred wherever
 * it's available and isn't implemented in this v1 scaffold yet.
 */
export function generateBootstrapToken(): { token: string; tokenHash: string } {
  const token = `sfcp_${randomBytes(24).toString("base64url")}`;
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Resolves a bearer token from an `Authorization: Bearer <token>` header
 * to the `ServiceIdentity` it belongs to, or `undefined` if it doesn't
 * match any known token. Never throws on a bad/missing header - callers
 * turn `undefined` into a 401. */
export function resolvePrincipal(
  repo: ControlPlaneRepo,
  authorizationHeader: string | undefined,
): ServiceIdentity | undefined {
  if (!authorizationHeader?.startsWith("Bearer ")) return undefined;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) return undefined;
  return repo.findServiceIdentityByTokenHash(hashToken(token));
}
