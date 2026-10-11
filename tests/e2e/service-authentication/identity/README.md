# Identity authentication service acceptance

Run `node tests/e2e/service-authentication/identity/run.mjs` from the repository
root with NVM's pinned Node version and Docker available. This owning-service
fixture starts Identity, an isolated PostgreSQL database and a test-only HTTPS
IdP. Credentials,
encryption and signing keys are freshly generated; no public conformance token
or real provider secret is installed.

The fixture validates signed CCT issuance, the complete administrative RPC
contract rejecting body-only actors, caller allowlists, scope/audience/actor
binding, revocation, JWKS restrictions, JSON media types and absence of business
effects after rejection. TLS/mTLS handshakes are additionally covered by the
service component tests. It does not claim Gateway/Console or cross-service
acceptance.

The exact five not-yet-implemented #61 linking/notice methods remain ungranted
and reject even a valid workload/CCT. Every active administrative method still
receives the missing-CCT checks; absent caller policies are never silently skipped.

The same real binary also rotates synthetic historical Provider and pending
login-session ciphertext: add a decrypt-only key, switch the active key, run
`rekey --batch-size 1` twice, verify both tables finish at zero without business
changes, retire the old key and verify normal login still works. The service's
PostgreSQL integration tests additionally complete an actual fixture OIDC
callback started before rotation after the old key is removed.

After key rotation, the Docker fixture exercises twelve signed-token callbacks
against the disposable IdP with CA and hostname verification. New registrations
reject first binding by default; exact domains and the administrator authority
flag control explicit automatic linking. Existing subject bindings skip a
failing UserInfo endpoint even without email, across all three policies. Wrong
nonce and mismatched UserInfo subjects reject authentication. Denials preserve
the ordered full-row summaries of bindings, browser tokens and completed-login
events. Review acknowledgement is checked through secret rotation, enable/disable
and a real service restart, including rediscovery of a changed published port.
The policy flow remains a producer gate: binding management, paired SCIM,
notices and browser consumers require their later batches.

The service runs as the invoking nonroot UID solely so it can read the temporary
0600 bind-mounted credentials. The image's production nonroot default is unchanged.
Containers and networks are removed on completion/interruption; temporary keys
are deleted and a credential-free result remains under ignored
`artifacts/verification/identity-authentication/`.
