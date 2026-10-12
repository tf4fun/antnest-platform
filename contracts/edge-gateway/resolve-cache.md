# Bounded Identity resolution

Gateway session revision 21 defines the positive Resolve cache for
[#59](https://github.com/tf4fun/antnest-platform/issues/59). The machine-readable
limits are in [resolve-cache-policy.json](resolve-cache-policy.json), policy
revision 2. The `resolve-access-token` and `list-session-revocations` wire
schemas from Identity revision 16 remain unchanged in revision 17. The updated
compatible catalog reference does not activate Gateway's pending #60
password-resource response handling, which requires its own consumer batch.

## Scope and authority

One Identity client owns one issuer's cache. The key is the SHA-256 digest of
the exact opaque token, the server-selected CCT profile and the exact Agent
scope, including an absent Agent. Validate the profile/Agent combination
against the Identity contract before any lookup. `session` forbids an Agent.
No browser field can select a profile or overwrite route-derived scope. Keys
and values must not cross client/issuer boundaries. Cached entries retain no
raw browser token.

A value is the complete validated, active Principal, original unchanged CCT,
private SID, browser session metadata and private resolution provenance.
Inactive principals, authorization errors, transport failures and malformed
responses are never positive entries. A successful snapshot is immutable;
activity or a hit cannot patch its CCT or its deadlines.

For positive TTL `T`, the reuse deadline is the earliest of:

- The actual Resolve RPC start plus `T`.
- Observed idle expiry.
- Absolute session expiry.
- The returned CCT's expiry.

Equality is expired. RPC latency consumes this budget; receiving a slow
successful reply does not move the start. Cache hits, waiter arrival, LRU
movement and empty feed pages never extend it. Every hit and completed waiter
rechecks deadlines, active state, the applicable invalidation generation and
feed proof. After a deadline expires, a new live Resolve is required; an old
positive is never used as fallback for a failed live call. Explicit activity
on another replica may produce a newer idle observation through that live
call, but cannot revive an expired credential.

Authoritative `unauthenticated` or `inactive_principal` errors, and complete
successful responses with `Active: false`, evict that token's cached authority
across every profile/Agent scope and invalidate its in-flight results. This
includes background refresh; simply declining to cache an inactive reply would
leave old active authority reusable. These denials are not negatively cached.
Revocation also invalidates
work already in flight: a result begun before the invalidation cannot refill
the cache or escape to a late waiter as old authority. A conservative process
generation barrier is permitted when an in-flight result's SID is not known.
Any bounded retry remains within the caller and shared-work deadlines.

Cache lookup is an admission point, not a distributed transaction with an
upstream business effect. Already admitted Runs keep their documented lifetime;
revoking a browser session does not cancel a durable Run.

## Configuration and resource ownership

| Setting                           | Default | Accepted values                                                              |
| --------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `ANTNEST_EDGE_RESOLVE_CACHE_TTL`  | `10s`   | Go duration from zero through `30s`; negative or larger values fail startup. |
| `ANTNEST_EDGE_RESOLVE_CACHE_SIZE` | `50000` | Integer from 1 through 50000; entry ceiling, also constrained by bytes.      |

TTL zero preserves direct Resolve behavior. It disables positive entries,
coalescing, background refresh, and the new shared-work capacity/deadline rules.
The existing session stream poller and live bounds still operate.

Enabled caching has a 64 MiB accounting budget, a 16 KiB per-entry ceiling and
an LRU entry ceiling. Charge all retained strings, including the CCT, SID,
profile/Agent key and display metadata, plus a conservative 1024-byte structure
charge for each entry and its indexes. Do not size entries by public JSON,
which omits private fields. LRU pressure evicts entries. An otherwise valid
live response above the per-entry ceiling is returned without caching; the
existing 2 MiB Identity response ceiling is not reduced. These limits bound
accounted retained data, not process RSS, transport buffers or allocator peaks.

At most 32 distinct scope resolutions may run concurrently, with 128 waiters
per scope and 1024 waiters in total. Enabled cache misses share work only for
one exact key and invalidation generation. Work-capacity exhaustion returns
`503 identity_unavailable`, preserving cookies; it must not fall back to an
unbounded direct RPC. Shared RPC lifetime is at most the minimum of five
seconds, configured request timeout and `T`, including reading and validating
the response. A caller may have a smaller independent deadline.

The per-scope waiter count includes every retained invalidation generation.
A work slot remains occupied until both its RPC has finished cleanup and its
last waiter has consumed the completed result. This also bounds valid oversized
live results retained outside the LRU while their ready waiters are unscheduled.
Cancellation releases a waiter promptly; it does not free an unjoined RPC slot.

Shared work has a process-owned context. Cancelling its first waiter cannot
poison other waiters; when its last waiter or explicit background owner leaves,
its RPC is cancelled. After half the TTL, a still-valid hit may start a shared
background refresh. Attempts for that entry are separated by at least half the
TTL, including after failure. Refresh uses the same flight limits; if capacity
is full, serve the valid hit without launching work. Refresh failure never
extends the old entry or becomes a new entry. Authoritative denial invalidates
it immediately.

Constructors start no goroutines. Main owns the feed and cache work lifecycle:
stop new work, cancel and join flights/poller, then close transports and
telemetry. `CloseIdleConnections` alone is not cancellation of active RPCs.
Shutdown must not wait for the normal five-second RPC budget when its own
budget is shorter.

## Revocation and caught-up proof

Reuse the private session feed from
[browser-sessions.md](../identity/browser-sessions.md). Do not introduce a
`list-access-revocations` alias or change the Controller offboarding feed.
One process-owned poller fans each validated event to the SID stream registry
and cache. Invalidation is by private SID across every profile/Agent entry.
The events already cover logout, password changes, role changes, User and
Membership deactivation/deletion, and OIDC unbinding's session revocations.
There is no implemented Organization-disable command to claim as new coverage.

The current producer locks the writer before allocating a sequence and holds
that lock until transaction completion. Reads are a fresh single-statement
snapshot on the authoritative store. The proof therefore covers committed
history visible at that query, not future commits or an uncommitted writer.
Replica reads or feed retention require a separately specified consistency
protocol; no watermark, epoch or retention migration is introduced here.

Poll every second, at most four pages per turn, 500 events per page and five
seconds per RPC. Start with cursor zero and no fresh proof. Only a validated
short page, after **all** its events have been applied to both consumers, proves
catch-up. Its age anchors to that page's RPC start, not response completion or
application completion. A short fourth page is eligible. Four full pages,
failed/cancelled calls, malformed pages or unfinished event application do not
refresh proof. Sequence gaps are legal; an empty page preserves the cursor.

Cache reuse requires proof younger than `T`. If proof is absent or stale,
bypass stored entries and require a successful live Resolve, with the enabled
work bounds still in force. A stale proof never extends a snapshot; a fresh
proof never refreshes one. The independent live stream output bound remains
in force even when polling fails. Following an Identity database restore,
restart every Gateway to clear entries, reset the cursor and catch up from
zero; a process holding a pre-restore cursor must not resume using it.

Successful local Gateway mutations evict before returning their response:
logout evicts the exact token hash across scopes; password change and self
session revocation evict the trusted User; unbinding evicts the trusted User
across Organizations even when `current_revoked` is false. Activity follows the
bounded in-flight exception below, without modifying old CCTs. Identity and
other replica mutations remain covered by the feed and absolute snapshot-age bound.
Eviction is not itself denial of another still-valid session: the next live
Resolve determines that session's authority.

### Activity and concurrent reads

A successful, metadata-validated Touch extends idle eligibility; it does not
revoke authority. Under the cache lock and before returning that response,
evict the trusted SID's entries and mark its existing work obsolete for reuse.
Use SID evidence from entries, known-SID flights and completed results to cover
all flights for each identified token across profiles and Agents. Do not
advance the global epoch or affect an unrelated SID.

An obsolete flight cannot accept new waiters or store its result. Waiters
already attached may still receive its actual live result, subject to the
same final checks for security invalidation, epoch, shutdown, caller/shared
cancellation and every original TTL, idle, absolute and CCT deadline. This
exception prevents normal browser input from cancelling a concurrent read.
It never edits the old Principal, extends a deadline or automatically retries
Resolve. A truly unknown SID retains the existing conservative bounded live
behavior; no unbounded SID/token tombstones are introduced.

Later requests use eligible cache state or new bounded work. Old work retains
its capacity through RPC cleanup and final waiter delivery, including completed
but undelivered results. It cannot remove or overwrite a newer generation.
An authoritative denial from an obsolete flight still evicts and fences every
scope for that token, including newer work. Revocation and other security
mutations always override the activity exception. An obsolete background
refresh without waiters may finish within its original budget but cannot store.

Keep actual RPC accounting and existing `rpc`/`shared` provenance: delivery from
an obsolete live flight is never a cache hit, and discarded real RPCs still
count. Acceptance requires deterministic held and ready-result interleavings,
new-before-old completion, later denial/revocation/expiry, generation capacity,
failed Touch, unrelated sessions and TTL-zero compatibility. Real HTTP
acceptance must witness a controlled overlap: bootstrap's Resolve is already
in flight or awaiting delivery when the successful Touch invalidates its old
generation, then both requests' first responses succeed without retries.
Sequential successes cannot establish this concurrency acceptance.

## Streams and timing provenance

Private `resolve_started_at`, `resolve_completed_at`, `valid_until` and
`cache_hit` distinguish actual RPC work from a reused snapshot. They never
appear in browser JSON or headers. Keep the current probe's start separately:

- Real Resolve start anchors snapshot age and the independent stream bound `R`
  (30 seconds by default), including the existing socket-close grace.
- Real Resolve completion minus start measures RPC duration.
- Probe start bounds this invocation's waiting time and schedules its next
  check. A cache hit cannot reset the first timestamp to the third.

A live miss retains the existing initial RPC and invocation reply budgets of
`min(R / 3, activity_interval_ms)`. A cache-hit stream admission may reuse a
snapshot older than that polling interval if it is still within every
cache/feed/session/CCT deadline and `real Resolve start + R - close grace`.
The current invocation must still fit its reply budget. Snapshot age is not
RPC duration. Do not reject a valid hit merely by treating its age as network
latency, or repeatedly schedule immediate probes from the old authority start.

A periodic guard can receive a previously complete, valid cache hit after its
TTL reuse deadline passes during delivery. Discard that result and resolve at
most once more within the same probe context and original deadline, only when
the snapshot was already complete and valid at the actual probe start and its
SID, identities, roles, idle/absolute/CCT deadlines and remaining stale bound
are still valid at delivery. This exception applies only to TTL reuse expiry;
malformed provenance, changed authority, live/shared results, errors and any
other expired bound keep their rejection behavior. The discarded hit cannot
update authority age, the current principal or the next-probe schedule. Keep
the independent stale/original CCT timers active while rechecking and joining
cancelled workers. Preserve both real Resolve trace decisions and their source
links. Initial HTTP/stream admission, ACP per-message admission and Activity
retain their existing no-automatic-retry behavior.

Every stream remains bound to its original SID, identities and roles.
Background checks and per-message admission use the same scoped resolver but
cannot extend authority through hits. Silent output still stops within `R`;
absolute session expiry and the original direct WebSocket handshake CCT are
hard caps. Reconnection is required when that original CCT expires. An idle
observation still schedules a fresh lookup/live resolution because genuine
activity may have extended the session elsewhere. Polling availability cannot
relax these rules.

## Organization display

Gateway caches the complete Principal, including display name and slug, for
at most `T` from real Resolve start. There is no independent metadata cache in
Node. Empty feed pages, requests and stream traffic do not renew that snapshot.
After expiry, the next real bootstrap/session/SSR read must resolve Identity
again. A browser observes the updated name after that read and its request
latency; no promise is made that already rendered text changes by itself
within `T`. IDs, roles, drafts, Agent sessions and authorization scope retain
their existing semantics. The browser still receives `Cache-Control: no-store`.

## Diagnostics and delivery evidence

Record actual Resolve RPC duration/outcome separately from cache lookup
outcome, so hit ratio is measurable without counting a hit as a network call.
Expose bounded cache occupancy and caught-up proof age/availability. Use only
fixed outcome/profile labels. Tokens, token hashes, private SIDs, CCTs and
cache keys must not become metric labels or diagnostic log fields. A proof-age
measurement is not proof of zero replication or event lag.

The owning `ListSessionRevocations` adapter identifies each real feed attempt on
its existing HTTP CLIENT with fixed `rpc.method=list_session_revocations`,
`rpc.service=identity` and `rpc.system.name=antnest.http-json`. These attributes
exist even when sending fails before an Identity SERVER exists. They describe
the adapter's operation, never inferred URL, header or body data. They add no
span, content capture, cursor, private SID or token, and preserve actual
parentage, error and lifetime. A consumer needs this method witness together
with the actual outage and failure evidence; an anonymous Identity CLIENT is
not sufficient proof of a failed feed request. Historical traces without the
witness remain unclassified.

The outage feed consumer queries the broad Gateway Identity CLIENT inventory
and the receiving feed SERVER inventory in pairs over one fixed query window.
It retains every round and requires both inventories to be unchanged for three
consecutive paired rounds, with every SERVER represented in the CLIENT search
and every already visible successful feed CLIENT represented in the SERVER
search. Complete archive coverage remains required. It reconciles that inventory
against all matching archived CLIENTs before selecting process-owned feed roots;
browser requests and other
work remain in the raw diagnostic set. A failed feed claim requires the fixed
method witness, a lone root CLIENT with no response or receiver, the exact
send-stage transport error and the observed Identity container lifecycle.
Distinguish sends that fail during the actual stopped interval (including
already in-flight attempts) from failures after restart begins but before
readiness. The latter must finish before
both the healthy observation and the first successful post-restart feed.
Neither phase admits a failure after recovery, an unidentified process root,
an unrelated error field/event or a missing attempt. Successful feed responses
retain their actual Identity receiver and read-only session-revocation SELECT.
An actual successful PostgreSQL `connect` may precede that SELECT under the same
Identity SERVER and process, with the same driver and database endpoint. It
cannot replace the SQL receipt, carry SQL/rows/errors, or cover unknown work.
The successful response set must equal the final SERVER inventory even if the two search
indexes become visible at different times.
An outage need not force a feed error: a bounded request may start while Identity
is stopped and succeed after the same container restarts. If no feed error was
observed, require that actual process-owned CLIENT to start between the container's
finished time and the restart command, finish within the existing five-second
request bound, and enclose its real successful SERVER after this restart's
container started time. Its positive timeout budget, complete SELECT and archive
remain mandatory, as does a separate successful CLIENT started after restart.
Retain this successful cross-restart receipt separately from error claims. A
missing stopped-period attempt, an out-of-lifetime receiver or any unidentified
error still fails admission; the five-second business outage is unchanged.
Claims never change the original strict result or cover other inventory errors.

The outage stream consumer binds public SSE retirement to the actual Agent,
Session, credential observation and remote closure after its recorded mutation.
The warm SSE is retired by that member's password change; successful intervening
Resolve revalidation remains valid. HTTP Date and observed request/closure
intervals bound the Gateway end time without assuming identical host and service
clocks. A claimed root handler abort and forwarding read failure require their
exact fields/events and successful response with the original Agent UI receiver.
Internal ACP watches retain the actual view as their causal parent and may
outlive that HTTP response. Only an observed normal same-container ACP restart
or final UI drain may explain their precise disconnect diagnostics. A separate
offboarding claim requires the original GET's fixed access-denial close event,
its trusted Agent/organization, the actual committed membership deactivation,
and the same disabled Agent readback within the observed recovery window. A
generic disconnect near a membership mutation is insufficient. The ACP
execution-state watch additionally requires the producer's `process-shutdown`
witness. Scan actual view traces rather than assigning a fixed number of watches
to each view, because a view may reuse an existing connection. Each observed
post-restart watch needs its own offboarding or final-drain evidence; all may
close on proved offboarding before the UI drain begins. Extra errors,
missing ancestry or archives, local closure and unrelated shutdowns are not
covered. Every claim names one original trace/span; raw diagnostics stay strict.

Final outage admission reconciles the entire archived Trace map, including
shared sources and triggers, against the exact error claims from all passed
owning gates. Every raw error must have an owner; unknown or non-error IDs,
conflicting reasons, incomplete archives or pending gates fail admission.
Repeated evidence of the same span is counted once. Original errors and warnings
remain intact, and only the already reviewed Jaeger clock-skew warning format
may accompany completion. The suite is complete only after HTTPS load, outage,
recovery, all owning gates, diagnostic reconciliation and resource cleanup pass;
an intermediate report or exit zero alone cannot establish CI admission.

An initialize-time Runtime MCP configuration read can complete its handler before
the SDK closes the HTTP response ahead of EOF. Its exact completion event may
retain `client_disconnected` as neutral transport evidence only with the real
ACP initialize/HTTP parent chain, HTTP 200, successful Runtime MCP operation and
matching cancellation witness. This does not prove client receipt, claim an
error, or excuse another failure; retain the original event and exact span ID.

Every request-admission resolution decision has an INTERNAL `gateway.identity.resolve` span
under the current HTTP or ACP-message root, ending before any resulting upstream
admission. Its `antnest.identity.resolve.` attributes include `source` from
`rpc | cache | shared`, the server-owned `profile`, and `outcome` from
`admitted | rejected | unavailable`. An admitted cache hit also records numeric
`snapshot_age_ms`, `proof_age_ms` and positive `valid_for_ms`; ages must fit the
configured policy. Preserve real RPC parentage rather than wrapping its CLIENT
span under this new marker. A shared waiter keeps its own request ancestry and
links its decision to the exact actual RPC CLIENT span through a SpanLink.
Archive that source Trace and validate both complete parent chains; the
waiter's own Trace does not pretend to contain the source SQL.

The fixed `antnest.identity.resolve.shared_source_state` is `actual-client`
when the CLIENT exists. A cancelled shared waiter may instead record
`cancelled-before-client`, with outcome `unavailable` and a fixed
`cancel_kind` (`caller-cancelled`, `caller-deadline`, `shared-cancelled`,
`shared-deadline` or `process-shutdown`), only if no CLIENT existed at its
cancellation snapshot. CLIENT creation/publication and that snapshot must be
linearized; an unpublished SpanContext alone does not establish absence.
This narrow branch has no upstream admission and cannot substitute for any
successful authorization or business evidence. It still requires complete
request ancestry and cancellation evidence. Another waiter may start the RPC
later. Normal replies, denials and cancellation after CLIENT creation retain
the exact link, archived source and both-parent-chain requirements. Never wait
for a future RPC or invent a span merely to decorate a cancelled request.

A half-TTL background refresh is process-owned work with its own root and a
link to the triggering request-admission decision. It must not extend a
finished request root or invent a current HTTP/ACP request. If a request later
joins that flight, its request-admission marker links to the background RPC's
actual CLIENT span. The source Trace is validated from its process-owned root;
the waiter's Trace still requires its actual Gateway request root. Background
refresh outcome/duration remains separately observable without counting it as
a request-admission decision.

Trace consumers first require complete synchronous parentage and the actual
Gateway root. A cache marker must belong to that root, use the expected profile,
end before upstream admission, and have valid budgets. Only then may it replace
the Resolve-specific Identity SQL expectation. The rpc branch still requires
CLIENT → Identity SERVER → SQL, and a shared branch requires its real source.
Missing/unknown markers, missing parents, wrong profiles and expired budgets
reject. Login, OIDC, password mutations, Controller owner authorization, ACP
persistence and Runtime evidence keep their original requirements.

Update the shared trace consumer expectations in a separate consumer batch,
retaining strict missing-parent diagnostics such as #247. A legitimate cached
request has no new Identity SQL span; no fabricated span or broad SQL exemption
is acceptable.

An outage diagnostic inspector reports `owned_error_spans` as exact
`{trace_id, span_id, reason}` claims only after validating each owning request's
wire evidence, complete ancestry and error shape. For stopped HTTP requests,
validate the Gateway request, optional Resolve decision and actual failed
Identity CLIENT independently; a deadline response can precede its cancelled
process-owned CLIENT only when the request carries its original waiter deadline
cause. Otherwise the request error must wrap the same CLIENT type and cause
chain, subject to the producer's four-cause limit. For recovered expired sessions,
require the actual completed `GET /api/session` 401 after restart, unauthenticated
Identity protocol event and successful zero-row token lookup.
Required error tags and events must be present, unique and match their owning
boundary; extra or unrelated diagnostics reject. A status code or temporal
overlap alone cannot establish error ownership. Claims never cover every span
in a linked source Trace, suppress raw errors/warnings or turn the original
strict verdict into success. Final integration must reconcile the complete
diagnostic set against the claims of all successful inspectors.

Delivery order:

1. Shared policy, schemas already supplied by Identity, admission assertions
   and explicit consumer work. No owning-service implementation in this batch.
2. Identity documentation and PostgreSQL proof: from a nonzero cursor, read a
   terminal page while another writer is uncommitted, then commit/rollback and
   continue from that cursor without skipping events. Existing ordering tests
   remain; no production Identity schema change is planned.
3. Gateway config/cache/stream/poller/lifecycle and diagnostics, unit/contract/
   component gates, real owning-service Docker admission and independent review.
4. Consumer compatibility and trace/display fixture changes, each with its
   own checks. A Gateway producer alone is not complete delivery.
5. Explicit real HTTPS integration, then full required repository/CI admission.

Tests must exercise scope and issuer isolation, exact deadline equality, slow
responses, uncached inactive/error/malformed/oversized responses, byte/LRU/work
limits, waiter cancellation, shutdown, revocation versus in-flight completion
and late waiter arrival, and retry spacing after failed refresh. Fake-clock
feed tests include slow terminal pages, blocked application, a short fourth
page and four full pages. Check both real and cached initial stream admission
without authority renewal or timer spin.

For the five-second Identity outage, first warm the **exact** token/profile/
Agent scopes on established WSS/SSE connections with sufficient remaining
cache, idle, absolute, CCT and JWKS budgets. Require real new model output,
an actual cancel, and terminal/quiescent Run evidence while Identity is down.
Cold tokens, profiles and Agents, new login, and exhausted deadlines fail;
cookies and upstream rejection boundaries remain intact. This does not claim
new/unknown-key handshakes or expired JWKS work during the outage. After
recovery, real logout/password/role/deactivation operations must reach HTTP
rejection and remote stream closure within the declared respective bounds.
Local socket cleanup cannot satisfy remote-closure evidence.

The load check sends 100 actual ACP `session/list` exchanges for one exact
scope in at most eight seconds, including the handshake in the measurement.
Each response must complete. At default TTL, at most **three actual Resolve
RPC attempts** may occur, including handshake and background refresh. Count
Gateway CLIENT attempts and Identity SERVER calls independently from raw
trace/fixture evidence; feed, activity and JWKS calls are separate. Record
message count, elapsed time, settings and counter deltas rather than inferring
network calls from a cache-hit metric.

For names, warm session/bootstrap/SSR separately, commit a rename, continue
healthy empty-page polling and issue real repeated reads through the expiry.
Prove hits and feed proof do not extend the old snapshot; preserve IDs, roles,
cookies, drafts and the other Organization. Archive failure and success
evidence under `artifacts/verification/issue-59/`, outside `.cache`, and verify
owned-resource cleanup. Existing #246/#247 evidence limits remain explicit.
