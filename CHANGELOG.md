# Changelog

## 0.2.0

Minor rather than patch: this adds features and narrows a compatibility
claim, and calling that a patch would misrepresent it.

### Added

- **`secrefs.config.json`** — project configuration for the CLI. Declares
  provider aliases, so `secrefs run` can reach more than one AWS account or
  Bitwarden vault. Credentials are named by the environment variable that
  holds them, never written into the file, and credential-shaped keys are
  rejected outright rather than ignored.
- **`profile`** option on the AWS provider, for addressing multiple accounts.
- **Error classification.** A failed fetch now carries `kind` — `auth`,
  `not_found`, `denied`, `transient`, `unknown` — and a `remedy` for auth
  failures. An expired SSO session is reported once for the provider with the
  command that fixes it, instead of once per reference blaming healthy secrets.
- **`staleGraceMs`.** After a *failed* refresh, a value fetched within the
  window may be served instead of throwing — for transient faults only. Never
  for auth or denial, since a stale value there hides a change the operator has
  to act on. Off by default.

### Changed

- **`engines` narrowed from `>=18` to `>=20`.** Node 18 and 20 are both past
  end-of-life; the previous claim was one nothing verified. CI now runs a
  20/22/24 matrix, which immediately caught a `better-sqlite3` crash on Node 24.
- `AccessDenied` is deliberately classified as a path failure, not an auth
  failure — the credentials worked and a policy refused one secret.

### Fixed

- `better-sqlite3` upgraded to 12.x; 11.x crashed at teardown on Node 24.
- The `bin` path no longer carries a `./` prefix npm was silently rewriting.

## 0.1.0

Initial release. `sec://` reference parsing and resolution, AWS Secrets
Manager / HashiCorp Vault / Bitwarden Secrets Manager / local providers,
`secrefs run` and `secrefs check`, and Python parity.
