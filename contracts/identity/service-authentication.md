# Identity workload authentication and caller context

This service-owned contract implements the
[platform authentication profile](../platform/service-authentication.md) for
[#25](https://github.com/tf4fun/antnest-platform/issues/25). It introduces Identity
RPC revision 14. Gateway and Console adoption remain separate owning-service
batches; coordinated deployment and cross-service Docker acceptance follow them.

## Immediate caller

Identity accepts `token` and `mtls` using the exact shared configuration and
header rules. Each route enforces [its caller catalog](callers.json): Gateway
owns login/session resolution and SCIM forwarding, Console owns administrative
requests, and Controller owns its authorization/revocation queries. Health
probes disclose only liveness/readiness. There is no body-only compatibility
mode or `ANTNEST_IDENTITY_REQUIRE_CALLER_CONTEXT` escape hatch.

TLS certificates must chain to the mounted platform CA, carry exactly the
expected `antnest://service/<name>` URI and have the required DNS/usage/validity.
Token mode over TLS authenticates callers with the dedicated service header;
mTLS derives them from the verified client certificate. Neither falls back to
the other. Only the exact development HTTP opt-in permits a plaintext listener.
Partial TLS settings remain fatal even with that opt-in. Identity uses TLS 1.3
or later. Its healthcheck verifies the same server identity and uses its own
client certificate in mTLS mode; it never reads CCT or user secrets.

Identity has no static outbound Antnest dependency, so its token directory may
be omitted. External OIDC connections retain their own issuer/TLS rules and
never receive Antnest workload credentials. Receiver hash JSON is limited to
8 KiB; startup rejects duplicate decoded keys/hashes and ungranted self-calls.

## Signing configuration and key rotation

All three variables are mandatory. They are read once before the HTTP listener
opens, mounted read-only, and never exposed in configuration responses.

| Variable | Exact format |
| --- | --- |
| `ANTNEST_IDENTITY_CCT_SIGNING_KID` | 1–128 printable non-space ASCII characters, compared exactly with no trimming. |
| `ANTNEST_IDENTITY_CCT_SIGNING_KEY_FILE` | One unencrypted PKCS#8 PEM `PRIVATE KEY` block containing an Ed25519 private key, at most 4 KiB. Separate from TLS, encryption and Runtime maintenance keys. |
| `ANTNEST_IDENTITY_CCT_JWKS_FILE` | UTF-8 JSON matching the [public JWKS schema](../platform/caller-context-jwks.schema.json), at most 16 KiB: 1–8 public Ed25519 keys with distinct exact IDs. No `d` or unknown members. |

The configured signing ID must occur in the JWKS and its public bytes must
match the private key. Unknown/malformed/mismatched keys fail startup. Generate
keys through the deployment batch; there is no working development default.
Publish current+next public keys and restart Identity before selecting next as
the signer. Retain the prior key through the last issued CCT's 60-second lifetime,
30-second tolerance and consumers' bounded JWKS-cache propagation. A consumer
must not fetch an issuer/key URL from unverified token fields.

## CCT issuance

`POST /rpc/identity/resolve-access-token` requires Gateway workload identity.
Revision 14 requires `access_token` and `profile`; optional `agent_id` scopes a
request to that exact Agent. The Gateway selects `profile` from its route, not
browser-supplied arbitrary audiences. Only `console`, `workspace` and `acp` are
accepted, mapped to the exact platform audience arrays. Identity takes all user,
Organization, membership and role claims from its active access-token record.
An Agent ID is a binding to the request target, not proof of Agent access; the
owning receiver still validates Organization, owner and resource authorization.

The response adds required `caller_context` alongside `principal`. It is a
compact Ed25519 JWS with `typ: antnest-cct+jwt` and the shared claims. `sid` is
the Identity `api_tokens.id` of the resolved credential, including credentials
issued through OIDC. It is not Gateway's cookie-session ID or the transient
OIDC login-state ID. No extra authentication/session table is introduced.
`iat` is integer UTC seconds; `exp` is no later than `iat + 60` or the underlying
credential's expiry. Each issuance has a new `jti`. `act` is never issued.

Only internal authenticated responses contain a CCT. Consumers forward it
unchanged in exactly one `Antnest-Caller-Context` field; do not put it into
browser JSON, redirects, transcripts, telemetry or RPC-content capture. A
resolve response uses `Cache-Control: no-store`; content observation omits the
`caller_context` field even when RPC content capture is enabled.

`GET /rpc/identity/jwks` (including Go's implicit HEAD) needs workload identity
but no CCT, avoiding bootstrap recursion. Its exact allowed callers are Gateway,
Console, Agent UI, ACP, Agent Controller and Registry. It returns only the public
configured JWKS with `Cache-Control: no-store`; clients own bounded refresh/cache
policies. It is not a browser/public endpoint.

## Administrative admission

Before decoding an administrative body or calling an application service,
Identity verifies the immediate workload, route allowlist and exactly one CCT.
It rejects duplicate/unknown JWS members, noncanonical segments, invalid UTF-8,
non-Ed25519 keys, wrong type/issuer/audience, unsupported `act`, invalid lifetime
and expired/future times (30 seconds maximum tolerance). Key IDs are exact.

It reloads the `sid` record, checks active User/Organization/membership, expiry
and revocation, and matches `sub`, `org`, `mbr` and roles against those live facts.
A missing/revoked/mismatched session is `401 caller_context_invalid`. Database
failure is a dependency error (503), never an authentication success. Already
admitted effects are not retroactively cancelled by session revocation.

`actor_principal_id` is an audit echo and must equal the verified `sub`; mismatch
returns `403 actor_mismatch`. A supplied Organization must match the verified
Organization scope. Existing application/transaction role and resource checks
still apply. `resolve-principal` is a Controller-owned operation query and is
not granted to Console. Global system-administrator operations retain their
existing role checks; resource-backed organization operations also check the
stored target Organization against the CCT scope.

All JSON RPC bodies require one `application/json` Content-Type, with only an
optional UTF-8 charset. Missing/duplicate/wrong content types return 415 before
decoding. Enforce one strict UTF-8 object, exact-case field names,
unknown/duplicate-field rejection and
the 1 MiB body limit before effects. SCIM keeps its explicit `application/scim+json`
contract and separate `Authorization` bearer; its forwarding Gateway must also
authenticate as a workload.

Errors retain Identity's `{code, message, retryable}` envelope. Workload failures
and caller-context failures are 401, caller-not-allowed and actor-mismatch are
403, media-type errors are 415. Authentication/authorization failures are not
retryable. Workload 401 carries exactly the platform Bearer challenge; caller
context 401 uses `Bearer realm="antnest-caller-context"`. No error contains a
credential or peer-controlled text.
