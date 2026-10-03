# Gateway authenticated forwarding

Run `node tests/e2e/service-authentication/gateway/run.mjs` from the repository
root. This owning-service acceptance builds the real Gateway image against
authenticated dependency doubles, with distinct temporary CSPRNG token files
and an Ed25519 test issuer. It covers login, session JSON privacy, server-owned
CCT profiles and Agent scopes, forged headers, CSRF, discovery, ACP HTTP, SCIM,
credential rotation, missing/replaced credentials and recovery. The harness
removes containers, its network and all generated credential files on exit;
only private result evidence remains in `artifacts/verification/`.

Go service tests cover real TLS/mTLS receiver identity checks and WebSocket
socket configuration/relay. Real Identity, Controller, ACP and UI integration
belongs to the final `feat/service-authentication` batch after their individual
admissions. This fixture does not claim completion of #26's whole workflow.
