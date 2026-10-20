# Console authenticated service acceptance

Run `node tests/e2e/service-authentication/console/run.mjs` from the repository
root. This builds the real Console container with authenticated dependency
doubles. Each run has a unique Compose project, temporary credentials and
durable evidence under `artifacts/verification/console-authentication/`. Cleanup
removes the project, volumes, local candidate image and credential files.

The OIDC checks in [oidc-linking.mjs](oidc-linking.mjs) cover complete and omitted
Provider policies, persistent review acknowledgment, canonical domains, nullable
SCIM pairing, the limited Provider chooser, scoped Membership bindings,
restoration, last-method confirmation and committed current-session revocation.
Invalid inputs cause zero dependency effects. The Identity double verifies the
original signed CCT, exact actor/scope fields and command namespace. Responses
test private-field projection, malformed data rejection, sanitized errors,
`no-store`, no Cookie forwarding and no mutation replay.

The create-user password matrix additionally checks canonical busy failures,
invalid status/body/retry metadata, mixed success/error responses and connection
loss. Each case records one signed Identity RPC and zero users created in the
double, preserves an authenticated follow-up read, and recovers on an explicit
later create. Counts are checked again after Console shutdown. Private receipts
are written to `password-admission.json`; passwords and CCTs are not recorded.

`npm --prefix services/admin-console/web run test:browser:sessions` additionally
runs the built Console's desktop and mobile account/OIDC flows, including
independent notice pagination, exact notice acknowledgment, plaintext subjects,
SCIM pairing and Provider review. Build the web assets before that command.

These fixtures prove the Console consumer and UI against doubles. Identity
transactions, live session grants, real SCIM requests and both browser
applications over HTTPS require the separate integration batch.

The network-policy checks use the real BFF with an authenticated Controller
double: pending read, one policy CAS, unchanged pending read, then an independent
peer-open transition and a fresh open read. Exactly three GETs and one PUT carry
the original signed scope; rejected account/member requests make no dependency
call, private fields are removed and responses stay `no-store`. A counter before
workload/CCT authentication also rejects hidden failed business HTTP attempts;
status, fixture control and JWKS reads remain separate. The independent
assignment and attachment versions are preserved in `network-admission.json`.
This does not prove React event refresh, live Egress packet flow or Foundation
integration; those have their own component and integration gates.
