# Gateway authenticated forwarding

Run `node tests/e2e/service-authentication/gateway/run.mjs` from the repository
root. This owning-service acceptance builds the real Gateway image against
authenticated dependency doubles, with distinct temporary CSPRNG token files
and an Ed25519 test issuer. It covers login, session JSON privacy, server-owned
CCT profiles and Agent scopes, forged headers, CSRF, discovery, ACP HTTP, SCIM,
credential rotation, missing/replaced credentials and recovery. It also checks
the revision 19 browser boundary: account projection, explicit non-cookie-writing
activity, independent public session IDs/pagination, self revocation, wrong-password
classification, password cookie/CSRF rotation with inherited absolute expiry,
old-session rejection and the explicit logout matrix. Ordinary and upstream
responses cannot overwrite session cookies.

A quiet administrator SSE stream must close within three seconds of starting
its HTTP request after another session revokes it. The dependency double returns
a 30-second activity hint, so ordinary live polling starts at ten seconds; the
fixture's lease is fifteen seconds. This verifies the real process-owned private
feed wiring, independently of the Go tests for the authoritative live-check
bound, blocked socket writes and feed failures.

The harness
removes containers, its network and all generated credential files on exit;
only private result evidence remains in `artifacts/verification/`.

Go service tests cover real TLS/mTLS receiver identity checks, five HTTP receive
paths, both WebSocket directions and socket cancellation. The separate
`tests/e2e/edge-gateway/shutdown-docker.mjs` regression covers SIGTERM, restart
and SIGINT with five active receives. Real Identity, Console, Agent UI and
two-browser HTTPS session behavior belongs to the final #58 integration batch
after all owning-service admissions; these dependency doubles do not complete
that workflow.
