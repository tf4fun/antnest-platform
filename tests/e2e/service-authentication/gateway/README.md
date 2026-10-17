# Gateway authenticated forwarding

Run `node tests/e2e/service-authentication/gateway/run.mjs` from the repository
root. This owning-service acceptance builds the real Gateway image against
authenticated dependency doubles, with distinct temporary CSPRNG token files
and an Ed25519 test issuer. It covers login, session JSON privacy, server-owned
CCT profiles and Agent scopes, forged headers, CSRF, Bridge HTTP, SCIM,
credential rotation, missing/replaced credentials and recovery. It also checks
the revision 20 browser boundary: account projection, explicit non-cookie-writing
activity, independent public session IDs/pagination, self revocation, wrong-password
classification, password cookie/CSRF rotation with inherited absolute expiry,
old-session rejection and the explicit logout matrix. Ordinary and upstream
responses cannot overwrite session cookies.

Gateway 24 retirement covers all ten old registrations, implicit HEAD and valid
wire upgrades with both anonymous and live sessions. Requests return 404 without
Cookie/credential leakage. Invalid outer Origin still returns 403. Authenticated
private before/after counters prove no Identity or application request; only
health, private fixture observation and the process-owned revocation feed are
excluded. The fixture has no Controller/ACP listener, URL or outgoing credential.
Bridge calls retain the workspace CCT audiences needed by Agent UI's downstream
Controller/ACP calls and verify signed scope plus exact regenerated hints.

The revision 22 password matrix exercises both real Gateway entry points with
validated busy/rate failures and malformed status, body and Retry-After values.
Authenticated private counters prove exactly one owning RPC per case, no session
issuance, rotation or revocation, continued use of the original cookie and later
successful login/password rotation. Case counts are checked again after Gateway
stops. These receipts contain counts only and stay in private evidence; the
fixture control endpoint has no published port. The original edge login limit
remains enabled. Real Identity accounting and final #60 HTTPS integration are
separate admissions.

The #2 login admission phase recreates only Gateway from the same built image,
with table capacity 1, password source/account limits 2/1 and OIDC source limit 2.
Sixteen requests prove independent flows, the `oidc:workforce` account boundary,
retained source/account refusals, atomic refusal at full capacity and restart of
evicted windows. The complete sequence must finish strictly within the five-minute
window, measured with a monotonic clock, so natural expiry cannot substitute for
eviction. Source A uses the published host port; source B runs inside the
dependency container and reaches Gateway directly. Private Gateway receipts must
show two distinct actual selected IPs, including B's inspected container IP.
Authenticated before/after counters prove one owning RPC per admission and zero
on refusal, with unchanged issuance/rotation/revocation counts through shutdown.
OIDC success writes only its secure binding Cookie; 401/429 write no Cookies.
Receipts omit authorization URLs, state and Cookie values, and project arbitrary
response headers or JSON parse failures to fixed non-sensitive values. OTel is disabled in
this owning Docker fixture; metric counts/labels have separate Go evidence.
This phase does not perform real signed SSO or satisfy the final two-client
container HTTPS/OIDC admission.

The external identity flow covers independent binding/notice pagination,
cross-organization self entries, immutable historical notice fields, exact opaque
subjects, explicit per-ID acknowledgment and idempotent zero counts. It checks
input/Origin/CSRF rejection, 404/409 error mapping, unbind with current-session
revocation, subsequent 401 responses and silent SSE retirement through the
private feed. Ordinary reads and acknowledgments preserve both session deadlines.
The Identity double checks the exact RPC fields and original session CCT scope;
its in-memory state does not prove real Identity transactions or grants.

A quiet administrator SSE stream must close within three seconds of starting
its HTTP request after another session revokes it. The dependency double returns
a 30-second activity hint, so ordinary live polling starts at ten seconds; the
fixture's lease is fifteen seconds. This verifies the real process-owned private
feed wiring, independently of the Go tests for the authoritative live-check
bound, blocked socket writes and feed failures.

The harness
removes containers, its network and all generated credential files on exit;
only private result evidence remains in `artifacts/verification/`.

Go service tests cover real TLS/mTLS receiver identity checks, both retained SSE
families, blocked HTTP writes and socket cancellation. The separate
\`tests/e2e/edge-gateway/shutdown-docker.mjs\` regression covers SIGTERM, restart
and SIGINT with five simultaneous receives across those two families. Its CCT
is a framing fixture; this authentication suite uses an actual Ed25519 issuer.
Neither double establishes the complete real Identity/Agent UI/ACP workflow,
receiver grant retirement, Bridge load/outage or two-user Runtime cancellation.
Those remain explicit #64 consumer and cross-service integration gates.
