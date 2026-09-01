import { clearAdminToken, getAdminToken, isTokenExpired, notifySessionExpired } from "./auth";
import type {
  AuthorizationEvent,
  ControlPlaneConfig,
  Grant,
  OidcBinding,
  Organization,
  Role,
  ServiceIdentity,
  ServiceIdentityWithToken,
  VaultConnection,
  VaultProviderKind,
} from "./types";

/** Where the control plane lives. Baked at build time for a deployed
 * console; defaults to the local dev port so `pnpm dev` works with no
 * setup. A self-hoster serving this from their own box sets
 * NEXT_PUBLIC_CONTROL_PLANE_URL to their own API's origin. */
export const CONTROL_PLANE_URL =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? "http://localhost:8787";

/** A non-2xx response from the control plane, carrying its own `{ error }`
 * message so denial reasons ("no grant authorizes path ...") and limits
 * ("the free plan is limited to ...") reach the UI verbatim rather than
 * as a generic failure. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAdminToken();

  // Don't spend a round trip on a token whose own `exp` has already
  // passed. Catching it here means the session ends the moment it
  // actually ended, rather than on whichever request happens to fire
  // next - which might be a mutation the user thought went through.
  if (token && isTokenExpired(token)) {
    clearAdminToken();
    notifySessionExpired();
    throw new ApiError(401, "Your session has expired. Please sign in again.");
  }

  let response: Response;
  try {
    response = await fetch(`${CONTROL_PLANE_URL}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    // fetch() rejects for network failures *and* for CORS rejections,
    // with no way to tell them apart from script - so name both, since
    // a missing SECREFS_CP_CORS_ORIGINS is the likeliest cause when the
    // control plane is otherwise up.
    throw new ApiError(
      0,
      `Can't reach the control plane at ${CONTROL_PLANE_URL}. Check it's running, and that ` +
        `this origin is listed in its SECREFS_CP_CORS_ORIGINS. (${
          err instanceof Error ? err.message : String(err)
        })`,
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };

    // A 401 while holding a token means the session lapsed - the server
    // verifies `exp` even though nothing here was watching it. Without
    // this the token sits in localStorage forever and every screen just
    // starts erroring, which reads as "the API is broken" rather than
    // "you need to sign in again".
    if (response.status === 401 && token) {
      clearAdminToken();
      notifySessionExpired();
      throw new ApiError(401, "Your session has expired. Please sign in again.");
    }

    throw new ApiError(response.status, body.error ?? `Request failed with ${response.status}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  getConfig: () => request<ControlPlaneConfig>("/v1/config"),

  listOrganizations: () =>
    request<{ organizations: Organization[] }>("/v1/organizations").then((r) => r.organizations),

  getOrganization: (orgId: string) =>
    request<Organization>(`/v1/organizations/${encodeURIComponent(orgId)}`),

  createOrganization: (name: string) =>
    request<Organization>("/v1/organizations", { method: "POST", body: JSON.stringify({ name }) }),

  listConnections: (orgId: string) =>
    request<{ connections: VaultConnection[] }>(
      `/v1/connections?orgId=${encodeURIComponent(orgId)}`,
    ).then((r) => r.connections),

  createConnection: (input: {
    orgId: string;
    alias: string;
    provider: VaultProviderKind;
    credential: Record<string, string>;
  }) => request<VaultConnection>("/v1/connections", { method: "POST", body: JSON.stringify(input) }),

  listRoles: (orgId: string) =>
    request<{ roles: Role[] }>(`/v1/roles?orgId=${encodeURIComponent(orgId)}`).then((r) => r.roles),

  createRole: (orgId: string, name: string) =>
    request<Role>("/v1/roles", { method: "POST", body: JSON.stringify({ orgId, name }) }),

  listGrants: (roleId: string) =>
    request<{ grants: Grant[] }>(`/v1/roles/${encodeURIComponent(roleId)}/grants`).then(
      (r) => r.grants,
    ),

  createGrant: (
    roleId: string,
    input: { vaultConnectionId: string; pathPattern: string; maxTtlSeconds: number },
  ) =>
    request<Grant>(`/v1/roles/${encodeURIComponent(roleId)}/grants`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  bindIdentityToRole: (roleId: string, serviceIdentityId: string) =>
    request<void>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`, {
      method: "POST",
      body: JSON.stringify({ serviceIdentityId }),
    }),

  listServiceIdentities: (orgId: string) =>
    request<{ serviceIdentities: ServiceIdentity[] }>(
      `/v1/service-identities?orgId=${encodeURIComponent(orgId)}`,
    ).then((r) => r.serviceIdentities),

  createServiceIdentity: (orgId: string, name: string) =>
    request<ServiceIdentityWithToken>("/v1/service-identities", {
      method: "POST",
      body: JSON.stringify({ orgId, name }),
    }),

  createOidcBinding: (identityId: string, input: { issuer: string; subjectPattern: string }) =>
    request<OidcBinding>(`/v1/service-identities/${encodeURIComponent(identityId)}/oidc-bindings`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  listAuditEvents: (orgId: string) =>
    request<{ events: AuthorizationEvent[] }>(`/v1/audit?orgId=${encodeURIComponent(orgId)}`).then(
      (r) => r.events,
    ),
};
