# Proxy mode: third-party pass-through

**Status:** Proposed. Nothing in this doc is built.
**Depends on:** [`control-plane-design.md`](./control-plane-design.md) — this
revisits its §3 trust-model decision rather than replacing it.

## 1. Why this exists

The control plane today is a **credential broker**: it authorizes a
request, mints a narrowly-scoped credential for the underlying vault, and
the caller fetches the secret themselves. Plaintext never transits SecRefs
infrastructure. That is the right shape for the case it was designed for —
an org's own CI and services, running on infrastructure the org controls.

It does not work for the case SecRefs actually wants to be a platform for.

**The pass-through case.** Instead of pasting a literal API key into a
vendor's dashboard, a customer gives the vendor a `sec://` reference. The
vendor's product expands it at runtime against the customer's SecRefs
account. The customer rotates the value at the source; the vendor keeps
working, because the reference never changed. A vendor breach leaks a
reference rather than a live key, and the customer can revoke one vendor
without touching the secret or any other consumer.

This is the product's central value proposition — a stable name for a
mutable value — and the broker model cannot deliver it:

- **AWS**: brokering means handing the vendor STS credentials into the
  customer's AWS account. Even scoped to one secret ARN, this is a
  credential in a third party's hands, inside the customer's account,
  which most security teams will refuse outright.
- **Bitwarden**: worse. The control plane distributes the org's
  pre-provisioned machine-account token, which is scoped to a whole
  project. There is no per-secret narrowing available.
- **Any future backend**: the general problem is that "a credential the
  vault will accept" is always a larger grant than "the value of this one
  secret," and the gap is exactly the thing you don't want to give a
  vendor.

So pass-through requires the control plane to fetch the value and return
it — the **proxy mode** §3 named and deliberately declined. §3 was right
for its case. This is a different case, and it needs the other answer.

## 2. What changes, honestly

Proxy mode means plaintext secret values transit SecRefs infrastructure,
in memory and in transit. Three consequences, stated plainly because the
project's credibility rests on not being vague about this:

1. **The README's claim narrows.** "No plaintext secret is ever written
   to disk or sent to a third-party SaaS vault" stops being true
   unqualified. It becomes true *of broker mode*, which remains the
   default and covers first-party infrastructure. Proxy mode is opt-in
   per grant, and the docs must say so at the same volume as the original
   claim rather than in a footnote. (Done: the site now says SecRefs
   "resolves secrets, and never stores one" — the §3 invariant, which
   holds under both modes, rather than "never touches", which does not.)
2. **SecRefs becomes a high-value target.** A control plane that proxies
   is one breach away from exposing every customer's every vendor secret.
   That is the LastPass/Okta risk profile. It is survivable — those are
   large companies — but it raises the security bar for everything below
   (§5) from "good practice" to "the thing the company lives or dies on."
   §6 narrows the window to code execution on the resolve path, and names
   the enclave path that would close it, but neither removes this as the
   defining risk of operating in proxy mode.
3. **SecRefs enters the vendor's critical path.** If the control plane is
   unreachable, the vendor's integration fails. Availability stops being
   an operational nicety and becomes a contractual concern.

None of these are reasons not to build it. They are the price of the
pass-through use case, and the alternative — vendors holding permanent
copies of customer keys — is worse on every axis. But they should be
chosen, not discovered.

## 3. Never store the value

The single most important constraint: **proxy mode fetches and forwards;
it never persists.** The control plane holds a plaintext secret only for
the duration of one request, in memory, and never writes it to the
database, the audit log, a cache, or a log line.

This is what keeps proxy mode meaningfully different from Doppler and
Infisical, which are custodians of record. SecRefs in proxy mode is a
*conduit*, not a store. The org's vault remains the only place the value
lives at rest.

Concretely, that means:
- No caching of fetched values in the control plane, at any TTL. A cache
  is storage with a timer on it.
- `AuthorizationEvent` continues to record the decision, never the value —
  the existing audit tests already assert this and must keep doing so.
- No request/response body logging on the proxy endpoint, ever. §6 makes
  this enforceable rather than merely mandated: with the payload
  encrypted to the vendor's key, a response body that escapes into a log
  is ciphertext. Treat the encryption as defence in depth for this rule,
  not a licence to relax it — the request side, and anything upstream of
  the seal, is still plaintext.

## 4. Shape

A new endpoint, deliberately separate from `/v1/credentials/mint` rather
than a flag on it, so the two modes can never be confused at a call site
or in an access log:

```
POST /v1/secrets/resolve
  Authorization: Bearer <service identity / OIDC token>
  { "alias": "aws-prod", "path": "prod/db", "field": "password" }

  200 → { "value": "..." }
  403 → { "error": "no grant authorizes ..." }
```

The authorization path is unchanged and reuses `rbac/authorize.ts`
exactly — same roles, same grants, same path patterns, same audit
record. The only difference is what happens after the decision:
`mint` returns a credential, `resolve` uses the credential internally
and returns the resolved value.

That reuse matters: proxy mode must not be a second, parallel
authorization system that can drift from the first.

### Grants must opt in

A `Grant` gains a mode:

```
Grant
  ...
  allow_proxy   BOOLEAN NOT NULL DEFAULT FALSE
```

Default false, so no existing grant silently becomes proxyable when this
ships. `POST /v1/secrets/resolve` refuses any grant without it, with a
reason that says so rather than a generic denial. An admin enabling it in
the console should see what it means — that SecRefs will handle the
plaintext for that grant — at the moment they enable it.

### `#field` moves server-side

Today the SDK does field extraction (`extractField` in
`providers/base.ts`) after fetching the whole secret. In proxy mode the
control plane must do it, and must return **only the requested field** —
returning the whole JSON blob when the grant authorized one field would
hand the vendor every other key in it. Grants already have an unused
`field_pattern` concept in §5's data model; this is where it earns its
place.

## 5. What this forces us to get right

Proxy mode raises the floor on several things that are currently
acceptable-for-a-scaffold:

- **Rate limiting.** A proxy endpoint with a stolen bootstrap token is a
  secret-exfiltration API. Per-identity limits, and alerting on a single
  identity resolving an unusual number of distinct paths.
- **Per-grant revocation that takes effect immediately.** Today a
  compromised identity is revoked by deleting its bindings; that needs to
  be a first-class, audited, instant operation.
- **Mutual TLS or signed requests** between vendor SDK and control plane,
  beyond a bearer token — a bearer token in a vendor's environment is the
  same class of artifact SecRefs exists to eliminate. Worth designing
  before pass-through has real users. (Workload-identity OIDC, already
  built, is the better answer wherever the vendor's platform supports it.)
- **A hard latency budget.** Use-time expansion means a SecRefs round trip
  in front of every vendor API call. That is a product tax and needs a
  number attached to it.

## 6. Payload encryption to the vendor's key

The response body is encrypted to a public key the vendor enrolls, so the
plaintext value exists in the clear only inside one function on the
resolve path — never in a response body, a log, a proxy, or anything that
terminates TLS.

### What this does not do

It does **not** mean SecRefs stops handling plaintext, and the docs must
not imply otherwise. Resolving requires the control plane to fetch from
the customer's vault (plaintext arrives in memory) and extract the
requested field from a JSON secret (§4, "`#field` moves server-side",
which needs plaintext) before it can encrypt anything. True end-to-end — vault to vendor, opaque in
between — is not reachable this way, because no supported backend will
encrypt to an arbitrary third party's key on our behalf.

So this does not answer §2.2. An attacker with **code execution on the
resolve path** still reads plaintext.

### What it does do

1. **It turns §3's logging prohibition from a policy into a property.**
   "No request/response body logging, ever" is currently a rule that
   people enforce and can violate — one APM integration, one debug
   middleware, one crash dump. Under payload encryption, a leaked
   response body is ciphertext. That is the difference between a control
   we assert and one a reviewer can verify, and it is most of the
   argument in a vendor security review.
2. **TLS-terminating infrastructure leaves scope.** The ALB terminates
   TLS today, so plaintext flows inside the VPC. Encrypted payloads mean
   the load balancer, and any CDN, service mesh or WAF added later, sees
   only ciphertext.
3. **Passive compromise stops paying.** Traffic capture, log
   aggregation, and backup snapshots yield ciphertext to an attacker who
   does not also hold the vendor's private key.

The exposure window narrows from *anything that touches the response* to
*code execution on the resolve path itself*. That is a real reduction,
and stating it at exactly that size is what makes it credible.

### Shape

**HPKE (RFC 9180)**, not raw RSA. It is standardised and has maintained
libraries in Go, Python, Rust and Java, which matters because vendors
implement in whatever they already run. Node has native X25519, so a
libsodium-style sealed box would need no new dependency — but the
multi-language vendor story is worth more than the saved dependency.

```
POST /v1/secrets/resolve
  { "alias": "acme", "path": "stripe", "field": "key" }

  200 → { "enc": "...", "ciphertext": "...", "key_id": "vk_3f9a" }
```

Three decisions that determine whether this is real or theatre:

- **Bind the ciphertext to the request.** `alias|path|field` and a
  timestamp go in HPKE's associated data. Without that binding, a
  ciphertext captured as the answer to one query can be replayed as the
  answer to a different one, and the vendor cannot tell.
- **Key IDs from the first release.** A vendor enrols one or more public
  keys; the response names which one was used. Retrofitting rotation
  onto a single-key scheme means a flag-day for every integration.
- **Enrolment becomes the most sensitive operation in the system.**
  Whoever can change a vendor's registered public key silently redirects
  every subsequent secret to themselves — without touching a grant, a
  role, or the resolve path. It must be separately audited, require
  re-authentication, and notify the vendor out of band. It is now a
  higher-value target than the resolve endpoint it protects.

### Getting the rest of the way

**Confidential computing (e.g. AWS Nitro Enclaves).** Run
fetch → extract → re-encrypt inside an attestable enclave, with the
private key existing only in there. Operators cannot read enclave
memory, and the vendor verifies an attestation document before sending
traffic.

Combined with the above, that supports *"we cannot read your customers'
secrets"* rather than *"we promise not to"* — the difference between a
policy and an architecture. It is real work and premature before a
design partner exists, but it is the path that makes the strong claim
honest, and it should be the answer when a vendor's security team asks
whether §2.2 is survivable.

## 7. What is deliberately not decided here

- **Whether vendors get a distinct principal type.** Today everything is a
  `ServiceIdentity`. A vendor is meaningfully different from a customer's
  own CI runner — different trust, different revocation story, plausibly
  different rate limits — and may deserve its own type. Not resolved.
- **How a customer discovers which vendors support `sec://`.** A registry
  is a real product surface and a real cold-start problem; out of scope
  for this document.
- **Whether proxy mode is a paid tier.** It is the expensive mode to
  operate and the one that carries the liability. Commercially that
  suggests it should be, but that is Nathan's call.

## 8. Recommendation

Build it, opt-in per grant, with the storage prohibition in §3 treated as
an invariant rather than a guideline — and update the README's headline
claim in the same change that ships it, not after.

Ship §6's payload encryption **in the first release, not as a follow-up**.
Adding it later means every early integration has to change, and key IDs
in particular cannot be retrofitted without a flag-day. It is also the
part that makes the security argument checkable rather than asserted,
which is what the first vendor's review will turn on.

Do not build it before there is a real vendor asking for it. It is the
mode that carries the liability, and speculative security surface is the
worst kind.
