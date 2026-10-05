# Runtime Egress control authentication (#32)

Status: frozen revision 5 profile; Egress owning-service admission is complete.
Coordinated deployment and final cross-service acceptance remain pending in the
[rollout ledger](../platform/service-authentication-rollout.json).
The [platform workload/token contract](../platform/service-authentication.md)
and [caller catalog](callers.json) are authoritative. Network placement, packet
source addresses and unsigned identity headers grant no control permission.

## Workload and operation scope

All eight business method/route combinations admit only `agent-controller`.
Authenticate before route fallback, path/body validation, repository access,
address allocation, policy changes, fences and kernel cleanup. A verified
different workload has no permission, including RC, ACP and Runtime.

These are Controller-owned operations. Controller derives the Agent and desired
policy from its accepted lifecycle or administrative operation. Egress does not
issue or verify end-user CCTs, query Identity, infer an organization from a
header, or acquire user/session/Run ownership. Remove incoming user Authorization,
Cookie, CCT and `X-Antnest-*` carriers before business handling and content capture.
Existing Agent scope, CAS, closed/open gates and flow/conntrack barriers remain
mandatory after admission. Workload permission does not bypass those invariants.

Unknown routes and method fallbacks still pass workload verification; a verified
Controller then receives the existing bounded 404/405. No wildcard business
grant is introduced.

## Configuration and transport

Use the exact `ANTNEST_SERVICE_AUTH_MODE` values `token` or `mtls`, with no default.
Token mode loads `ANTNEST_SERVICE_AUTH_CALLERS_FILE` once before any database,
kernel or listener effects. It is a regular, bounded UTF-8 JSON receiver file
containing only caller names and current/next SHA-256 hashes; duplicate members,
hash aliases and malformed profiles fail startup. No inline JSON, environment
secret, public conformance credential or legacy Authorization fallback exists.
Egress has no outbound business service client and needs no sender token directory.

Token-over-HTTP requires the exact development-only
`ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true` opt-in. Without that opt-in,
token mode requires the complete TLS profile. mTLS always requires TLS and rejects
the insecure flag. If TLS is configured even with the development opt-in, validate
and use TLS; do not silently discard the configuration.

The shared `ANTNEST_TLS_CA_FILE`, `ANTNEST_TLS_CERT_FILE`,
`ANTNEST_TLS_KEY_FILE` and `ANTNEST_TLS_SERVER_NAME` profile must be complete.
Validate the service's certificate/key, trust, validity, server usage, configured
DNS name and exactly one `antnest://service/runtime-egress` URI before effects.
mTLS validates the client chain, validity, client usage and exactly one known
workload URI. Peer identity comes only from the authenticated connection, never
the CN, peer IP, request extension supplied by a caller or a header. Unsupported
or invalid TLS never downgrades to plaintext or token identity.

TLS handshakes have a five-second deadline and at most 16 pending handshakes;
one slow handshake must not serialize all legitimate clients. Shutdown cancels
owned handshakes and drains the HTTP server within the service shutdown bound.
Receiver hash rotation follows the platform's bounded current/next overlap and
requires receiver restart. Sender rotation is owned by Controller's admitted
per-request file reader; expiry never cancels an already accepted operation.

## Listener isolation and health

`ANTNEST_EGRESS_CONTROL_LISTEN` remains an explicit unicast IPv4 address and
nonzero port, default `127.0.0.1:8081`. Its IP must differ from
`ANTNEST_EGRESS_UDP_ADVERTISE`: production binds the Controller-purpose address,
not the Runtime packet interface or a wildcard. Deployment must keep that
purpose network private and expose no Egress host port.

`ANTNEST_EGRESS_HEALTH_LISTEN` is a separate explicit IPv4 loopback address and
nonzero port, default `127.0.0.1:8082`, and cannot equal the control endpoint.
Only exact `GET/HEAD /status` exists there, with no authentication or business
routes. The control listener does not expose anonymous `/status`; a verified
Controller receives its normal route-not-found response there. The local
`--healthcheck` reads the configured loopback health endpoint without workload
credentials or database/signing configuration.

The existing status document is unchanged: `status`, `data_plane_ready`,
`control_plane_ready`, `snapshot_revision`. It contains no credentials, Agent
content or configuration. Preserve HTTP 200 for both ready/degraded as defined
by the control contract; control mutations still return their bounded retryable
failure when unavailable. Cold start opens neither listener before recovery.

## Request hygiene and failures

Ensure (`PUT /internal/agent-networks/{agent_id}`) has no request body, matching
the existing Controller producer. GETs and Ensure reject nonempty bodies, and
all business routes reject query fields. Do not turn Ensure into a new JSON API.

The four JSON routes require exactly one UTF-8 `application/json` Content-Type
(one optional UTF-8 charset), no/identity Content-Encoding, one JSON object,
valid UTF-8, unique member names at every level, exact known fields, depth at
most 32 and at most 4 KiB. Body reads are bounded by five seconds. Unsupported
media returns 415 before decoding; malformed JSON or query/body misuse returns
400; an oversized body returns 413. These failures precede business effects.

Keep the existing `{code,message,retryable}` envelope. Missing, ambiguous,
malformed or unknown workload authority returns 401 `service_unauthenticated`,
`retryable:false`, and exactly `WWW-Authenticate: Bearer realm="antnest-service"`.
A verified disallowed workload returns 403 `caller_not_allowed` without a
challenge. Media rejection is 415 `unsupported_media_type`, `retryable:false`.
Validation/size failures use `invalid_request`, `retryable:false`.
Token headers are not an alternate identity in mTLS mode.

Authentication failures contain no raw header, token, certificate, file path,
claim or upstream body. Trace/content capture never records authority carriers;
denied requests record only bounded classification and route/status information.
Successful Controller requests retain existing W3C tracing and typed RPC capture.

## Delivery boundaries and evidence

Freeze this profile and contract tests first. The Egress-owned implementation
batch then supplies native shared-token vectors, certificate/TLS negatives,
all-route caller and media probes, no-effect/replay/CAS regressions, separate
health/startup/shutdown checks, real HTTP and PostgreSQL components, and a
production-image Docker gate with disposable credentials. It changes only Egress
implementation and its own documentation/tests.

Controller already owns the authenticated outgoing client and no-body Ensure;
actual Controller-to-Egress compatibility is verified in the final integration
batch after local gates. Random provisioning, PKI, purpose networks and debug
ports are the deployment batch; full platform business/security E2E remains
separate from an isolated producer gate.

This control profile does not authenticate UDP packet sources or filter DNS
answers. [#34](https://github.com/tf4fun/antnest-platform/issues/34) and
[#36](https://github.com/tf4fun/antnest-platform/issues/36) remain independent
packet/DNS work. Packet format revision and trust limitations remain unchanged;
passing control authentication must not be described as fixing those issues.
