/**
 * Admin session handling, deliberately behind one small interface so the
 * real WorkOS AuthKit flow can drop in without touching any screen.
 *
 * Today there are two modes, and which one applies is discovered at
 * runtime from `GET /v1/config` rather than baked in at build time -
 * the same built console has to work against a SecRefs-hosted control
 * plane (auth required) and a bare self-hosted one (no auth configured):
 *
 * - **No admin auth** (`adminAuthRequired: false`): the control plane has
 *   no WorkOS configured, so its management endpoints are open. The
 *   console sends no Authorization header and shows a standing warning
 *   banner. This is the documented self-hosted local-dev mode.
 * - **WorkOS** (`adminAuthRequired: true`): the console needs a WorkOS
 *   AuthKit session token to send as a bearer token. `signIn()` below is
 *   the seam where the real redirect flow goes; until it's wired, the
 *   console accepts a token pasted directly so a WorkOS-enabled control
 *   plane is still operable (and testable) before the UI flow exists.
 */

const TOKEN_STORAGE_KEY = "secrefs.admin.token";

/** Reads the stored admin session token, if any. Returns undefined in
 * no-auth mode, before sign-in, or during SSR/prerender where there's no
 * `window` - callers treat all three the same way (send no header). */
export function getAdminToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    // Private-mode browsers and blocked-storage settings throw on access
    // rather than returning null. Treat exactly like "not signed in".
    return undefined;
  }
}

export function setAdminToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Nothing useful to do - the session just won't survive a reload.
  }
}

export function clearAdminToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore - see setAdminToken
  }
}

/**
 * Where the WorkOS AuthKit redirect goes once credentials exist. Kept as
 * an explicit unimplemented seam rather than a stub that silently does
 * nothing, so it's obvious at the call site that sign-in isn't wired yet
 * and the paste-a-token path is the current route in.
 */
export function isRedirectSignInAvailable(): boolean {
  return false;
}

/**
 * Expiry, from the client's side.
 *
 * The control plane verifies `exp` and 401s an expired token, so the
 * server is not the problem - the console was. Nothing here watched the
 * clock, so a lapsed session showed up as every screen erroring at once
 * with no indication that signing in again was the fix.
 *
 * These are deliberately parse-only: the signature is the server's
 * business, and a client that "validated" a token would be claiming a
 * guarantee it cannot make. All we want is the timestamp, so we can stop
 * sending a token we already know is dead.
 */

/** Reads `exp` (seconds since epoch) from a JWT without verifying it.
 * Returns undefined for anything that isn't a JWT carrying an `exp` -
 * including the opaque tokens a self-hoster may paste in. */
export function readTokenExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : undefined;
  } catch {
    // Not a JWT, or not base64url. Treat as "no expiry information",
    // never as "expired" - refusing to send a token we simply cannot
    // read would lock out every non-JWT session for no reason.
    return undefined;
  }
}

/** True when the token's own `exp` has passed. Unreadable or
 * expiry-less tokens are never reported as expired. */
export function isTokenExpired(token: string, nowMs: number = Date.now()): boolean {
  const exp = readTokenExpiry(token);
  if (exp === undefined) return false;
  return exp * 1000 <= nowMs;
}

/** Milliseconds until the token expires, or undefined if unknown. Used to
 * warn before the session lapses rather than after. */
export function millisUntilExpiry(token: string, nowMs: number = Date.now()): number | undefined {
  const exp = readTokenExpiry(token);
  return exp === undefined ? undefined : exp * 1000 - nowMs;
}

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

/** Subscribe to session expiry, so a layout can route to sign-in from one
 * place rather than every screen handling 401 itself. */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export function notifySessionExpired(): void {
  for (const listener of sessionExpiredListeners) listener();
}
