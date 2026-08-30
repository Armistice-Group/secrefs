/**
 * Bitwarden Secrets Manager (docs/control-plane-design.md §8, corrected).
 * Deliberately *not* symmetric with `awsSts.ts`: AWS's `AssumeRole` can
 * mint a fresh, per-request, narrower credential on demand. Bitwarden's
 * publicly documented API can't - access tokens are pre-provisioned per
 * machine account (fixed project scope, fixed expiration) via Bitwarden's
 * own admin UI/API, with no found mechanism for the control plane to
 * mint a new one dynamically.
 *
 * So this isn't a credential *minter* - it's a credential *distributor*:
 * the org's one pre-provisioned access token is stored encrypted, and
 * this function is the seam that hands it back once `authorize()` already
 * said yes. Still real access control (authenticated, RBAC'd, audited) -
 * just not per-request re-scoped the way AWS/GCP are. If Bitwarden's API
 * ever adds real dynamic minting, this is the one place that changes.
 */

export interface BitwardenMasterCredential {
  accessToken: string;
  /** Needed by the SDK only to address a secret by name rather than UUID
   * - see packages/node/src/providers/bitwarden.ts. Optional here too. */
  organizationId?: string;
}

export interface DistributedBitwardenCredential {
  accessToken: string;
  organizationId?: string;
  /**
   * Explicitly *not* a promise about when this token actually expires -
   * Bitwarden's own expiration (set when the org created the token) is
   * whatever it is, independent of the `Grant.max_ttl` that authorized
   * this distribution. Surfaced so a caller doesn't mistake this for an
   * AWS-style enforced TTL.
   */
  note: string;
}

export function distributeBitwardenCredential(
  credential: BitwardenMasterCredential,
): DistributedBitwardenCredential {
  return {
    accessToken: credential.accessToken,
    organizationId: credential.organizationId,
    note:
      "this is Bitwarden's own pre-provisioned access token, not a freshly minted one - " +
      "its actual expiration is whatever was set when it was created, not the grant's max_ttl",
  };
}
