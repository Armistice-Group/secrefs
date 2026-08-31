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
