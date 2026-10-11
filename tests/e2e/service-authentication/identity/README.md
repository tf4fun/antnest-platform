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

The five #61 binding/notice methods use their exact Gateway/Console grants and
require a live CCT. Every administrative method receives missing-CCT checks;
absent caller policies are never silently skipped.

The same real binary also rotates synthetic historical Provider and pending
login-session ciphertext: add a decrypt-only key, switch the active key, run
`rekey --batch-size 1` twice, verify both tables finish at zero without business
changes, retire the old key and verify normal login still works. The service's
PostgreSQL integration tests additionally complete an actual fixture OIDC
callback started before rotation after the old key is removed.

After key rotation, the Docker fixture exercises signed-token callbacks
against the disposable IdP with CA and hostname verification. New registrations
reject first binding by default; exact domains and the administrator authority
flag control explicit automatic linking. Existing subject bindings skip a
failing UserInfo endpoint even without email, across all three policies. Wrong
nonce and mismatched UserInfo subjects reject authentication. Denials preserve
the ordered full-row summaries of bindings, notices, browser tokens and
binding/completed-login events. Review acknowledgement is checked through secret rotation, enable/disable
and a real service restart, including rediscovery of a changed published port.
The binding flow uses a real ordinary organization administrator to prebind an
account under `none`, then verifies signed callback admission. Self unbind
preserves the subject tombstone and checks exact session token IDs, revocation
feed, request-correlated audit and absence of principal offboarding. Callbacks
cannot restore it even after automatic email linking is enabled. Explicit
restoration produces a new notice; exact-ID acknowledgment retries cannot hide
that notice, including across a service restart. An isolated Membership proves
the last-method conflict and explicit self lockout. Inventory, chooser and
rejected writes preserve full durable-state summaries.

The SCIM flow issues A/B/unpaired credentials through an ordinary organization
administrator, verifies pairing metadata across restart, and exercises the
production Users/Groups HTTP routes. Invalid raw subjects, duplicate JSON,
subject changes and ownership collisions preserve full business-state
summaries (SCIM authentication's bounded last-used accounting is excluded).
Paired creation enables signed subject login under `none` with an atomic
SCIM-actor audit and notice. Other credentials retain directory CRUD authority.
Paired, unpaired and reprovisioned User POST timestamps match the persisted
metadata returned by an immediate GET.
Delete performs actual offboarding; exact-lineage reprovision preserves the
User, creates a fresh Membership and moves its binding without recreating a
notice. Explicit unbind remains revoked after deletion, reprovision, enabling
email linking and restart. Gateway/browser consumers and cross-service HTTPS
acceptance remain separate batches.

The service runs as the invoking nonroot UID solely so it can read the temporary
0600 bind-mounted credentials. The image's production nonroot default is unchanged.
Containers and networks are removed on completion/interruption; temporary keys
are deleted and a credential-free result remains under ignored
`artifacts/verification/identity-authentication/`.
