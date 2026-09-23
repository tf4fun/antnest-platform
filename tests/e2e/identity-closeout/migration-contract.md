# Identity and access acceptance migration

Migrate in independent deployment batches. Production service behavior is not
changed by this fixture migration, and passing one batch does not accept the
other owners' workflows.

1. Identity HTTP/SCIM/OIDC: retain local sessions, CSRF, membership/global-user
   revocation, SCIM isolation and lifecycle, password-change semantics, real
   token expiry/outage recovery, verified HTTPS OIDC and correlated secret-free
   logs. Run in disposable projects with explicit synthetic configuration,
   loopback ports, isolated allocator ranges and bounded process cleanup.
2. ACP session consumers: retain v1/v2 logout/expiry/outage behavior, accepted
   Run continuation, no rejected-message effects and exact history restoration.
   Replace Model revision and Controller admission assumptions with current
   Provider/Model, ACP audit and per-message Trace contracts.
3. Agent access/offboarding integration: retain organization/admin/member/owner
   isolation, same-user cross-organization evidence, automatic Disable and
   explicit Enable, Controller restart recovery and SCIM/OIDC offboarding.
   Verify current ACP authorization and durable effects, Runtime replacement
   boundaries and exact source-event/Temporal workflow and activity ancestry.

The first batch owns the HTTP fixture and deployment changes. Record pending
ACP/Agent consumers until their own fixtures and Docker evidence pass. Shared
helpers and legacy default/retained branches remain until their final consumer
migrates.

Completed-request Trace collection waits for actual topology, SQL ownership,
protocol and privacy assertions before archiving. It retains unmodified spans,
error events and warnings. Strict warning/error results remain failures and
are reported after all independent business cases run; topology success does
not imply strict success. Existing strict helper entry points keep their
behavior. No clock setting, timestamp rewriting or export-interval change is
part of migration.

Test fixture and contract changes first, including negative evidence and actual
HTTP collector tests. Then run the affected local tests and each applicable
Docker profile serially. Preserve retained development container IDs, image
IDs and health and prove that every disposable project and verification child
is removed after success, failure or interruption.
