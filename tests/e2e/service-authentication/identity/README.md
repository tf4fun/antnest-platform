# Identity authentication service acceptance

Run `node tests/e2e/service-authentication/identity/run.mjs` from the repository
root with NVM's pinned Node version and Docker available. This owning-service
fixture starts only Identity and an isolated PostgreSQL database. Credentials,
encryption and signing keys are freshly generated; no public conformance token
or real provider secret is installed.

The fixture validates signed CCT issuance, the complete administrative RPC
contract rejecting body-only actors, caller allowlists, scope/audience/actor
binding, revocation, JWKS restrictions, JSON media types and absence of business
effects after rejection. TLS/mTLS handshakes are additionally covered by the
service component tests. It does not claim Gateway/Console or cross-service
acceptance.

The service runs as the invoking nonroot UID solely so it can read the temporary
0600 bind-mounted credentials. The image's production nonroot default is unchanged.
Containers and networks are removed on completion/interruption; temporary keys
are deleted and a credential-free result remains under ignored
`artifacts/verification/identity-authentication/`.
