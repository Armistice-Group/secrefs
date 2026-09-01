/**
 * Why a fetch failed, and - more usefully - who has to do something
 * about it.
 *
 * The distinction that matters is between a problem with *the reference*
 * and a problem with *the environment*. They currently look identical to
 * a caller, which produces the worst message SecRefs emits today: an
 * expired `aws sso login` reported once per reference as
 * `could not fetch secret "prod/db"`, blaming four healthy secrets for
 * one dead credential.
 */
export type SecretErrorKind =
  /** Credentials are missing, expired, or unusable. Nothing about the
   * reference is wrong; a human has to re-authenticate. Report once for
   * the whole provider, never per reference. */
  | "auth"
  /** Credentials worked and the backend says this path does not exist.
   * Specific to the reference. */
  | "not_found"
  /** Credentials worked and the backend refused *this* path. Also
   * specific to the reference - sending someone to re-login when the
   * real problem is an IAM policy wastes their afternoon. */
  | "denied"
  /** Network, timeout, throttle, or 5xx. Nobody is at fault and the same
   * call may well succeed a second later. The only kind for which
   * serving a stale value is defensible. */
  | "transient"
  /** Unclassified. Treated as permanent, because guessing "transient"
   * would mean retrying something that will never succeed. */
  | "unknown";

/** Error `name`s and codes the AWS SDK uses for credential problems. */
const AUTH_NAMES = new Set([
  "CredentialsProviderError",
  "TokenProviderError",
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "InvalidIdentityToken",
  "AuthFailure",
  "SSOTokenProviderFailure",
]);

const NOT_FOUND_NAMES = new Set([
  "ResourceNotFoundException",
  "NoSuchEntity",
  "SecretNotFound",
]);

const DENIED_NAMES = new Set([
  "AccessDeniedException",
  "AccessDenied",
  "AuthorizationError",
  "UnauthorizedOperation",
]);

const TRANSIENT_NAMES = new Set([
  "TimeoutError",
  "NetworkingError",
  "RequestTimeout",
  "RequestTimeoutException",
  "ThrottlingException",
  "TooManyRequestsException",
  "InternalServiceError",
  "InternalServerError",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "AbortError",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/** Message fragments to fall back on when a thrown value carries no
 * usable `name` - some SDK layers and every `fetch` polyfill lose it. */
const AUTH_FRAGMENTS = [
  "could not load credentials",
  "sso session associated with this profile has expired",
  "security token included in the request is expired",
  "unable to locate credentials",
  "token is expired",
  "credentials have expired",
  "is expired",
];

const TRANSIENT_FRAGMENTS = [
  "socket hang up",
  "network error",
  "timed out",
  "timeout",
  "econnreset",
  "econnrefused",
  "getaddrinfo",
];

function nameOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const e = err as { name?: unknown; code?: unknown; __type?: unknown };
  for (const candidate of [e.name, e.code, e.__type]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (typeof meta?.httpStatusCode === "number") return meta.httpStatusCode;
  const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Best-effort classification of a provider error. Deliberately
 * conservative: anything unrecognised is "unknown" rather than
 * "transient", because the only behaviour keyed off "transient" is
 * retrying and serving stale values, and doing either to a permanent
 * failure turns one clear error into a slow, confusing one.
 */
export function classifyError(err: unknown): SecretErrorKind {
  const name = nameOf(err);
  if (AUTH_NAMES.has(name)) return "auth";
  if (NOT_FOUND_NAMES.has(name)) return "not_found";
  if (DENIED_NAMES.has(name)) return "denied";
  if (TRANSIENT_NAMES.has(name)) return "transient";

  const status = statusOf(err);
  if (status === 401) return "auth";
  if (status === 403) return "denied";
  if (status === 404) return "not_found";
  if (status === 408 || status === 429) return "transient";
  if (status !== undefined && status >= 500) return "transient";

  const message = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  // Auth is checked before transient: "the SSO session ... has expired"
  // contains no transient marker, but a wrapped auth error can pick up
  // network-ish wording from an outer layer, and mis-filing auth as
  // transient is the expensive direction.
  if (AUTH_FRAGMENTS.some((f) => message.includes(f))) return "auth";
  if (TRANSIENT_FRAGMENTS.some((f) => message.includes(f))) return "transient";

  return "unknown";
}

/** Whether serving a previously-fetched value in place of this failure is
 * defensible. Only ever true for transient faults: a stale value papering
 * over an expired credential hides a change in the environment that a
 * human has to act on, and a stale value papering over a *rotation* means
 * continuing to use a key that may have been rotated because it leaked. */
export function isStaleServable(kind: SecretErrorKind): boolean {
  return kind === "transient";
}

/**
 * The action that actually fixes this, when there is one. Returned
 * separately from the message so a CLI can print it as a next step
 * rather than burying it in prose.
 */
export function remedyFor(kind: SecretErrorKind, provider: string, err?: unknown): string | undefined {
  if (kind !== "auth") return undefined;

  // The AWS SDK's own SSO message already names the fix; don't talk over
  // it with a worse guess about which profile is involved.
  const message = err instanceof Error ? err.message : "";
  if (/sso session/i.test(message)) {
    const profile = process.env.AWS_PROFILE;
    return profile
      ? `Run: aws sso login --profile ${profile}`
      : "Run: aws sso login --profile <your-profile>";
  }

  switch (provider) {
    case "aws": {
      const profile = process.env.AWS_PROFILE;
      return profile
        ? `Check credentials for AWS profile "${profile}" - if it uses SSO, run: aws sso login --profile ${profile}`
        : "No AWS credentials found. Set AWS_PROFILE, export static keys, or attach an instance role.";
    }
    case "bitwarden":
      return "Set BWS_ACCESS_TOKEN to a valid Bitwarden machine account token.";
    case "vault":
      return "Set VAULT_ADDR and VAULT_TOKEN, or renew the token if it has expired.";
    default:
      return undefined;
  }
}
