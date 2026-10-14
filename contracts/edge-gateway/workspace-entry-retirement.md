# Browser workspace entry retirement

The [architecture decision](../../docs/architecture/browser-workspace-entry.md)
selects option A of [#64](https://github.com/tf4fun/antnest-platform/issues/64):
retire the unused direct Gateway browser stack and keep the shipped Agent UI
Bridge. The [policy](workspace-entry-retirement-policy.json) defines the target
behavior and the evidence required before declaring the migration complete.

## Activation and version ownership

The shared policy has revision 1. Its baseline is Gateway 23, header registry 1,
Resolve cache policy 3, Identity 18 and Console 54. Publishing the policy does
not remove a route or activate a service version. The Gateway owning batch
activates session revision 24 and header registry 2 with its implementation,
service documentation, unit, contract and component evidence. Consumers and
cross-service integration remain separate batches.

At Gateway activation, the session catalog references this policy and removes
the five legacy route definitions; the caller registry removes their ten
registrations while retaining the `/api/app/*` deny fallback. Regenerate guarded
source fingerprints only for reviewed owning changes. Remove the legacy
`acp-http` outbound-header profile and browser WebSocket inventory while
preserving the reserved namespaces, local CSRF processing, Cookie stripping,
workload credentials, signed CCT and verified Bridge presentation hints.

Update the active session schema title, cache session reference and subsequent
Console/Agent UI consumer references. Header registry versions are independent
of Gateway session revisions. A reference-only cache update does not change
cache semantics; migrating its ACP load/initialization measurement to actual
Bridge requests requires a new cache policy revision and an explicit counting
definition. Keep historical baselines and activations intact, including login
admission baseline 22/activation 23, password activation Identity 17/Gateway 22
and SCIM baseline Identity 17/Console 53, activation Identity 18/Console 54.

## Retired routes

The policy inventories all ten registrations: bootstrap, state and state-watch
GETs; GETs for `acp`, `v1/acp`, `v2/acp`; and POST/DELETE for `acp` and `v1/acp`.
These paths, implicit HEAD requests and WebSocket upgrade requests return the
existing `404 not_found` response without contacting Identity, Controller,
ACP or Agent UI. Exercise both anonymous and valid browser sessions. The shared
Origin/Fetch Metadata admission still runs before routing, so an invalid outer
request may receive its existing 403 instead of 404. A retired path never
falls through to the Console application or starts an upstream upgrade.

Remove the unused `acpConnections`, `acpMessages` and `stateConnections` pools
with their implementation. Removing the legacy four-message pool is not
evidence of Bridge capacity: that pool never governed the shipped UI path.
Retain body limits needed by Bridge when deleting shared legacy definitions.

## Retained behavior and evidence

The browser continues to use `/workspace/*` and `/api/app/workspace/v1/*`.
Preserve bootstrap, authorized state/events, prompt, cancellation, permission
reply, Session load and reconnect without replay. Bridge DTOs differ from the
old direct ACP/state objects; migrate assertions to the real Bridge responses
and commands, not just different URL strings. ACP still owns protocol and Run
semantics. Authenticated service-internal ACP v1/v2 remains available for its
protocol tests. This decision does not add an external bearer ACP endpoint;
option B's external-client and limiter admission criteria are not applicable.

Migrate Origin, CSRF, forged header/trailer, workload/CCT, HSTS/Cookie, expiry,
revocation, blocked-write, silent-stream and shutdown checks onto retained
routes. Preserve original principal scope and idle/absolute/CCT deadlines,
non-touch authorization, private feed invalidation and the maximum 30-second
stale-output boundary. Observer disconnect or revoked browser access does not
cancel an already accepted durable Run.

The replacement load/outage evidence must retain 100 actual same-scope calls
within 8 seconds and at most three actual Resolve calls, including entry
initialization and refresh. Independently account for feed/activity/JWKS calls.
During a real five-second Identity outage, prewarmed valid authority must allow
observable output and actual cancellation/termination; cold or expired scopes
must remain refused. Keep actual Resolve source traces, both parent chains,
original strict diagnostics and the cleanup receipts. The Node SDK sub-1ms
investigation remains separate from larger deltas or missing raw evidence.

## Bridge capacity admission

Review the Gateway's global SSE pool, process-global Bridge owners, owner
subscribers, concurrent body bytes, per-principal uploads and synchronous
parse/hash/serialization work. Existing owner/subscriber/SSE counters do not
account for attachment body reception or parsing. A full SSE pool must not
block an existing other user's small cancellation request.

Use two independently authenticated users and Agents with user B already
executing observable Runtime work. User A uploads a valid attachment near the
negotiated input limit. Test both while its body remains incomplete and across
body completion/processing. Measure B's direct operation cancellation and the
shipped `/commands` stop path separately. From an independent client's
monotonic cancellation start, cancellation must be accepted, the matching Run
must reach its terminal state and actual Runtime execution must quiesce within
1 second. A 200 response or `cancelling` state alone is insufficient.

B's work must remain held until the correlated cancellation. Bind the evidence
to its Organization, User, Agent, Run, Runtime instance and actual Runtime work
reference. Require the same target's cancellation-specific outcome and
quiescence; natural completion, unrelated idle work or a replacement execution
cannot prove cancellation. These are evidence identities resolved from the
owning protocols, not new browser request fields.

Archive correlated receipts for A's body-reception interval, actual EOF and
processing completion, and B's cancellation-request send time. Explicitly
correlate clock domains and prove overlap with the phase being exercised.
The completion phase ends when the required parsing, hashing and serialization
finish; a later wait for an upstream response is not body processing. Starting
B's cancel after A finishes processing does not pass that phase even if it is
fast. Negative inspector cases must reject these substitute proofs.

The client and Node server must not share an event loop. Do not manufacture
latency with a busy loop or patched parser. Add component cases for chunked and
oversized bodies, repeated uploads, disconnect and budget release; preserve
authentication and deadline behavior. Run the admitted production images in
the explicit two-user Docker integration. Document the actual resulting limits
and measured deployment; do not infer universal fairness from one passing run.

## Delivery dependencies

1. Shared policy and architecture decision, with failing-first contract checks.
2. Gateway removal, active catalogs and its local admission/documentation.
3. Controller removes the unused Gateway workload caller in its own catalog,
   receiver implementation, documentation and admission batch.
4. ACP removes that unused Gateway caller in a separate owning batch while
   retaining Agent UI and private v1/v2 protocol admission.
5. Agent UI capacity reproduction, required repairs and owning admission.
6. Deployment and browser/contract/E2E consumers, including identity-closeout and transitive
   lifecycle, workspace, Skill and managed-MCP helpers; preserve private ACP
   v1/v2 protocol tests and historical activation references.
7. Explicit cross-service business, security, load/outage and upload/cancel
   integration, followed by complete CI and coordinator review.

The Gateway batch removes its unused Controller/ACP URLs, outbound clients and
required credentials. Receiver batches must reject the retired Gateway
credential without business effects and retain Agent UI's workload callers.
Development credential pairs derive from the updated receiver catalogs;
deployment consumers remove Gateway's unused direct dependencies, URLs and
network attachments. Preserve Agent UI's URLs/networks and Identity workspace
CCT audiences for Controller and ACP, which Agent UI still needs for its own
downstream calls. Updating Gateway alone does not retire receiver grants or
stop generating their development credentials.

Completing a producer or keeping tests compatible does not close the workflow
or #165–#169. Their service-owned coverage remains separately accountable.
