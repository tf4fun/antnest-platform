# Catalog Availability And Configuration Delivery

This B4 batch consumes existing Controller contracts. Console does not own
reference validation, dependency enablement, credential rotation or Agent
lifecycle. No other service implementation changes in this batch.

## Commands

| Browser command | Controller command |
| --- | --- |
| `PUT /api/admin/provider-connections/{connection_id}/availability` | `PUT /internal/provider-connections/{connection_id}/availability` |
| `PUT /api/admin/model-profiles/{model_profile_id}/availability` | `PUT /internal/model-profiles/{model_profile_id}/availability` |
| `PUT /api/admin/templates/{template_id}/availability` | `PUT /internal/agent-templates/{template_id}/availability` |

All require the verified administrator, `Idempotency-Key`, and precisely
`{expected_enabled: boolean, enabled: boolean}`. Missing/null flags and injected
identity/query fields are rejected. BFF derives request and organization IDs
from the trusted context and key. It performs one Controller call, with the
normal request timeout/cancellation and HTTP tracing; no read-before-write,
ACP call, implicit retries, or cascade of changes. The successful browser DTO is
`{resource_id, enabled, updated_at}`. A missing flag or wrong resource is not a
successful update.

No-op commands still go to Controller and preserve its receipt timestamp. A
rejected, uncommitted conflict has no saved receipt; Console does not invent one.

Controller conflicts stay conflicts. `resource_in_use` retains its structured
`references` and optional `references_truncated`. Templates link to their current
head, Agents to their detail, and lifecycle targets to the Agent with the
operation ID shown. A truncated list is explicitly incomplete. Unknown or
malformed reference details never imply that disabling is safe.

## Interaction

Provider detail, Model detail and current Template detail offer independent
availability controls. Historical Template revisions remain read-only. Disabling
a Template does not disable its existing Agents; disabling a Provider does not
rewrite each Model flag. These rules remain Controller-owned, not inferred from
loaded browser lists.

Provider disable is allowed while referenced. When ACP applies the update,
active requests fail immediately; the next prompt can use the Template's ordered
backup connections. Re-enabling restores availability without changing references.
No physical deletion action is exposed. Referenced Model disable still returns
`resource_in_use`.

The browser sends no optimistic flag change. After a committed receipt it reads
the current resource, because replayed receipts may precede a later opposite
change. A failed read after a successful write is displayed as saved but not
refreshed; retry refreshes the read only. An uncertain write is retried explicitly
with the same intent/key, not a newly inverted checkbox. Definite conflicts permit
reviewing references or refreshing current state; they are never auto-retried.

Retry keys are scoped to the verified browser principal; late completions from
an older login cannot clear a new session's pending command. Reads are cancelled
on leaving a detail, and check cancellation before updating parent state. Detail
editing and availability refreshes are mutually exclusive. Template publication
also confirms its receipt separately from reading the current head, so a replayed
publication cannot silently re-enable a Template disabled in the meantime.

## Configuration Delivery

Management save success and ACP application are separate facts. A single
organization-scoped status in configuration/Agent pages reads the existing BFF
`/api/admin/execution-synchronization`. It refreshes on mount, explicit refresh
and confirmed configuration mutations; no timer polls or ACP health probes.
Audit pages do not depend on this read. Stale identity/page responses are ignored.

Null means no published execution configuration. Lower `applied_revision` means
pending delivery; equality means a historical acknowledgement, never live ACP
health, Agent readiness or idle execution. Failures mean unknown, not rollback
of a successful save. Lifecycle and Runtime conditions remain separate views.

## Acceptance

Use request/response contract tests for exact booleans, trusted scope, stable keys,
bounded reference metadata, unchanged error codes, and absent fan-out. Component
tests exercise all three controls, historical read-only detail, reference links,
conflict/uncertain retry, saved-but-refresh-failed and late callbacks. Verify null,
pending, old/current ACK and read failure separately; a successful write must not
wait for or retry due to failed synchronization reads. Real Controller/ACP delivery
and Gateway-rooted traces remain B5, not synthetic UI acceptance.

Owner contract: [Controller catalog availability](../../../contracts/agent-controller/control-api.md#catalog-availability).

## Reusable Checks

`npm --prefix services/admin-console/web test` covers the API adapter, reference
presentation, all three pages, current-versus-historical Template, uncertain
commands, saved-but-unread state, principal changes and stale read cancellation.
Go service tests cover BFF identity, strict commands, owner errors and contract
route registration; they do not simulate Controller's database business rules.

After `npm --prefix services/admin-console/web run build`, run
`npm --prefix services/admin-console/web run test:browser:catalog` for desktop and
mobile synthetic UI acceptance, then `test:browser:audit` for audit independence.
Both use the same local static-server/browser harness, refuse external requests,
close the browser and server in `finally`, and overwrite screenshots under the
repository `.cache`. No credentials, database or Docker are used. These are
repeatable client checks, not proof of real configuration delivery or B5.
