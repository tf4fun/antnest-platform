# Bounded Identity resolution

Gateway session revision 21 defines the positive Resolve cache for
[#59](https://github.com/tf4fun/antnest-platform/issues/59). The machine-readable
limits are in [resolve-cache-policy.json](resolve-cache-policy.json), policy
revision 4. The `resolve-access-token` and `list-session-revocations` wire
schemas from Identity revision 16 remain unchanged in revision 17. Gateway
session revision 22 retains this cache policy and adds the separately scoped
[password failure consumer](../identity/password-verification.md).
Revision 23 preserves both and activates independent
[login admission](login-admission.md) budgets and bounded tables.
Gateway 24 retires the direct browser ACP transport under the
[retirement policy](workspace-entry-retirement.md). Policy 4 defines the retained
Bridge HTTP load and SSE/HTTP outage measurements without changing cache
authority, resource limits, Identity revision 18 or Gateway revision 24.
Policy 3's direct-ACP message/handshake clauses remain explicitly historical;
their WSS evidence cannot admit the Bridge. This shared policy defines the new
measurement. The test consumers and actual cross-service admission are separate,
pending delivery batches.

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
the cache or escape to a late waiter as old authority. Session-feed events use
the bounded SID window below, including work whose SID was unknown when it
started. Local User mutations retain their conservative generation barrier.
Neither path automatically retries Resolve.

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

When a matching feed event wins cancellation of an already admitted browser
stream, its original Gateway HTTP SERVER records one
`antnest.stream.termination` event before ending. It has fixed
`source=identity-session-feed`, `reason=session_revoked`, the allowlisted
`antnest.revocation.reason`, sequence, original organization/User/Membership
and route Agent. Valid source trace/span IDs are decoded from the producer's
traceparent; raw traceparent, SID, Cookie and CCT are never recorded. Invalid
diagnostics cannot delay cancellation or be exported as arbitrary text.
The event timestamp is the winning cancellation attempt's local time.
Parent cancellation, live-check rejection and expiry cannot be relabeled by a
later feed event. Existing HTTP errors, status, deadlines and joined cleanup
remain unchanged; consumers must still bind the event to its real mutation.

Keep the most recent 128 applied session SIDs as SHA-256 digests in a fixed
4096-byte window, plus a process-local application counter. This fixed metadata
is separate from the accounted entry budget and retains no raw SID strings.
The counter counts applied events, not Identity sequence values: legal producer
sequence gaps do not consume window space. Each flight records the counter at
creation; joining, completing and delivering that work never reset its anchor.
Before storing a positive result and at final waiter delivery, compare its
validated CCT SID with every event applied since that anchor, under the cache
lock. A matching SID rejects the result. An unrelated SID preserves the same
live result and its original deadlines, without another RPC. A previously known
SID must also agree with the returned SID. These checks cover background
refresh, activity-obsolete work and completed results with pending waiters.

Exactly 128 intervening events remain inspectable. More than 128 reject old
work without retry because its history is incomplete; new work starts at the
current counter. Before a counter wrap, invalidate all retained work under the
same lock, then reset the counter and window. Invalidated work keeps its capacity
until cleanup and delivery finish. Cached entries still receive immediate
SID-scoped eviction on each event. This window neither negatively caches a SID
nor denies work started after an event, and does not change caught-up proof,
local token/User invalidation, TTL-zero behavior or any capacity/deadline limit.

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
the independent stale/session deadlines and current returned CCT validity
enforced while rechecking and joining cancelled workers. Preserve both real
Resolve decisions and their source links. Initial HTTP/stream admission and
Activity retain their existing no-automatic-retry behavior.

Every retained stream remains bound to its original SID, identities and roles.
Background checks cannot extend authority through cache hits. Silent output
still stops within `R`, and original absolute session expiry is a hard cap.
An idle observation schedules fresh resolution because genuine activity may
have extended the session elsewhere. A fresh RPC may supply a new CCT; it
cannot mutate an old snapshot or waive the current snapshot's expiry checks.

Policy 3's original-handshake CCT cap applied specifically to the now-retired
direct Gateway WebSocket. It does not impose that old socket lifetime on the
Gateway's retained SSE guard, which checks the current CCT on revalidation while
preserving the original SID, identities, roles and absolute session deadline.
The Agent UI receiver separately terminates Workspace SSE at its originally
verified delegation CCT expiry, as defined by the
[Workspace API](../agent-ui/workspace-api.json). Gateway cache refresh cannot
extend that Node stream. Private ACP consumers continue to enforce their own
authenticated transport contract.

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
Resolve revalidation remains valid. An actual final RPC revalidation may instead
receive 401 after the committed revocation. Require the complete recovery HTTP
admission for that exact mutation, the actual stream and mutation credential
observations, and the same organization, User and Membership. Initial admission
must still succeed; the rejected decision is terminal with no later Resolve.
Retain the exact rejected decision, CLIENT 401 and Identity unauthenticated
protocol diagnostics, including the producer's actual status rather than adding
an OTel ERROR requirement to the Identity SERVER. Require its sole original
browser-token SELECT to return zero rows without errors or writes. Zero rows
alone do not identify a session: the real dispatch, Principal and validated
mutation semantics supply that binding. Compare the mutation's completed COMMIT
with that SELECT only after matching both Identity processes by service instance,
host and PID. Bound the decision and CLIENT using Gateway HTTP Date and the
observed mutation-to-remote-closure window; do not compare a Gateway timestamp
directly with an Identity timestamp. This rule does not admit shared-source or
unavailable decisions, unrelated errors, or a mutation marker without its full
transaction/feed evidence.

HTTP Date and observed request/closure
intervals bound the Gateway end time without assuming identical host and service
clocks. A claimed root handler abort and forwarding read failure require their
exact fields/events and successful response with the original Agent UI receiver.
Internal ACP watches retain their actual HTTP origin as their causal parent and may
outlive that HTTP response. Only an observed normal same-container ACP restart
or final UI drain may explain their precise disconnect diagnostics. A separate
offboarding claim requires the original GET's fixed access-denial close event,
its trusted Agent/organization, the actual committed membership deactivation,
and the same disabled Agent readback within the observed recovery window. A
generic disconnect near a membership mutation is insufficient. The ACP
execution-state watch additionally requires the producer's `process-shutdown`
witness. Scan actual HTTP origins and ACP initializations rather than assigning
a fixed number of watches to each view, because later requests may reuse an
existing connection. Each observed
post-restart watch needs its own offboarding or final-drain evidence; all may
close on proved offboarding before the UI drain begins. Extra errors,
missing ancestry or archives, local closure and unrelated shutdowns are not
covered. Every claim names one original trace/span; raw diagnostics stay strict.

Before restarting the old ACP process, the outage runner performs its own
control `GET /status` and records the monotonic send and complete ready-body
receipt, HTTP Date and body hash. Docker observations before and after the probe
must retain the original container, StartedAt and healthy process; bind raw
receivers to the same host, PID and service instance as the actual old ACP
initialization. Use already verified complete HTTP request windows to form a
coarse clock bound, then require exactly one health SERVER whose possible start
interval intersects this probe. Intersect the independently measured health
bounds with all existing same-process bounds. Do not select the nearest
timestamp, synthesize a parent, or reuse an unverified load-clock summary.

Keep a fixed independent `HTTP GET /status` query window covering the entire
possible probe interval, reject unread pages or a saturated 500-Trace result,
and require three equal complete raw snapshots. Archive every candidate and
reconcile the search and full raw archive in both directions, retaining the
reason each other receiver cannot belong to the probe. Missing, ambiguous,
foreign-process or inconsistent evidence fails admission. The entire resulting
closure interval must still lie within the observed process lifecycle; mere
overlap with the restart boundary is insufficient. Preserve the original
errors and warnings. Historical runs without the probe remain incomplete.
The final policy 4 completion report must retain this generation-zero ACP clock
and its probe, with identical resulting bounds, one selected archived receiver,
the actual probe sample, and the original verified initialization samples.
Omitting these fields cannot admit an older report that once passed a narrower
stream inspector.

The outage owner inventory includes successful POST/session creation, GET/view
requests and any denied HTTP origin that actually initialized an owner. A denied
origin needs its exact independently verified denial; its status alone does not
admit its errors. Bind each close root through its unique initialization Link
and enumerate all GET and execution-state watch receipts, including later GETs
under a reused owner. Reconcile independent close-root and DELETE-receiver
searches with the complete raw archive over the same three stable rounds.
Normal owner retirement still requires a complete DELETE 202. Missing owners,
duplicate origins, foreign Links, unbound later streams and no-target closes
cannot establish completion.

The deliberate ACP process restart has one separate failed-cleanup admission.
Require a `transport_failure` / `failed` owner-close root, its exact initialized
owner, that owner's `process-shutdown` execution-state watch, and the observed
normal exit of the old ACP process. Relate each service's spans to its own process
and observed lifecycle; an unrelated restart or the later UI drain is not a
witness. The actual close receipt must show a target, exactly one DELETE attempt,
zero response headers, completed bodies and status, no pending requests, a joined
SDK stream, exactly one failure and no truncated diagnostics. Require one
`delete_request` failure event containing exactly one of `connection_refused`,
`connection_reset`, `broken_pipe` or `socket_closed`, optionally preceded by one
`unknown` wrapper. Unknown-only, DNS, timeout, abort, body/stream cleanup, extra
events or contradictory counts fail admission, as does any DELETE receiver for
this failed close. Preserve its original ERROR and any drain warning as failed
cleanup evidence. This does not turn the attempt into a successful DELETE or add
a shutdown acknowledgement protocol; online DELETE 404 and missing receipts
remain failures. Historical traces without these producer receipts cannot be
retrofitted into this admission.

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

The held Runtime outage uses one successful `c4-cache-runtime-outage` model
request followed by exactly one Runtime `bash` call. The model is not the work
being cancelled. Bind the actual prompt and cancellation HTTP observations,
their complete Gateway/UI/ACP ancestry, original organization/User/Agent/
Session/Run, stored execution snapshot, Runtime execution/generation/image and
observed process group. The original Run must finish as `unresolved`, with
`quiescent` executor, `unknown` tool effects, `runtime_mcp` source and
`cancelled_tool_outcome_unknown` error class. Preserve the terminal SQL and
actual audit; cancellation must not create a replacement Run.

Its five exact ERROR spans are `agent.run` (`run_unresolved`), `mcp.tools.call`
(`McpToolCallError`), and the Runtime operation, tool and executor
(`outcome_unknown`). Require the unique Run/model/tool/Runtime parent chain,
all original fixed error tags and events, bounded producer cause lists and the
executor's actual process-group PID and `canceled` exit classification. The
operation completion remains INFO with outcome `error`; the tool and executor
completions remain WARN. Do not replace these errors with success or claim
unrelated spans. An extra model, tool, error field, event or cause fails this
admission.

The corresponding ACP HTTP CLIENT and Runtime `tools/call` HTTP SERVER are
separate non-ERROR transport receipts. The CLIENT requires its exact
`AbortError`/`http.send_or_read` cancellation event. The SERVER requires HTTP
200, protocol `error`, transport `canceled`, `client_disconnected`, the exact
WARN HTTP completion and `antnest.error` event at stage `http`; the successful
initialize-read exception does not apply. Both ends must record equal positive
response bytes. Only the cancellation inspector, after proving this original
Run and actual Runtime quiescence, may identify these exact non-error spans
for final diagnostic reconciliation. Keep their raw fields and events.

Direct execution ordering uses the same ACP process: the successful model ends
before the ACP `mcp.tools.call` for bash begins, cancellation starts before that
call ends, and terminal SQL
follows bash and is joined by Run completion. The cancellation window is the
same-process internal `acp session/cancel` span, not its early HTTP 202 or the
public UI response. Only the Run end is inside that window; its start predates
cancellation. Run and terminal SQL finish before that internal RPC ends, with
only the separately recorded same-ACP Node anchor ambiguity below. Runtime
SERVER/operation/tool/executor ancestry and event ordering use the same Runtime
clock. Independently calibrate that clock using actual completed RPC
request/response intervals from the same Runtime process, execution and
generation. Require successful protocol operations, dual HTTP 200 and equal
positive response bytes, with no CLIENT cancellation or error. The Runtime
SERVER start must lie between ACP CLIENT send and complete EOF; its end is not
an anchor. Include all eligible samples, with witnesses before and after
cancellation, and reject an empty offset intersection. Never use the cancelled
Tool request itself as a calibration sample. Bind each entire Runtime
end interval to the same ACP cancellation RPC and actual process-group
quiescence. A remote SERVER need not end before its
cancelled CLIENT: their raw wall-clock ends are not a join bound. This is not a
blanket clock-skew allowance. Preserve calculated warnings and measured bounds;
the deferred Node sub-millisecond investigation applies only to independently
integer-millisecond-anchored spans in the same ACP process. All other timing
findings still need their own evidence. Jaeger's independently represented
integer-microsecond start, duration and event timestamps are checked as half-open
representation intervals: an event one microsecond beyond the summed raw end
can still overlap its represented end, but two microseconds cannot. Record this
representation ambiguity without claiming nanosecond ordering or treating Rust
events as Node SDK findings. This also applies to the Runtime `/status`
completion used by Rebuild preparation: require the actual Rust/OpenTelemetry
resource, unique successful completion, matching identity and safe integer
timestamps. Preserve the raw endpoint pair in `time_observations`; two
microseconds, an earlier-than-start event or unrelated diagnostics still fail.
The consumer and fresh Docker
integration must pass before this new admission is complete.

Every request-admission resolution decision has an INTERNAL `gateway.identity.resolve` span
under the current HTTP request root, ending before any resulting upstream
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

The first caller of a process-owned flight remains `source=rpc`. It records
`cancel_kind` only if the same linearized cancellation snapshot already contains
the actual published CLIENT. Cancellation before CLIENT creation omits that
attribute; a CLIENT created later cannot change the finished decision or qualify
for a late-completion exception. The creator adds neither a SpanLink nor
`shared_source_state`: its actual CLIENT retains the same request parent.
Cancelled decisions cannot prove successful admission. A creator carrying
`shared-deadline` may finish before transport cleanup, provided the consumer
binds the unique same-process CLIENT that started within that decision to its
complete deadline failure and the independently observed outage window. Other
cancel kinds cannot substitute for this deadline proof. Ordinary RPC completion
keeps its existing ordering. The worker retains its capacity slot until actual
transport cleanup finishes, and process shutdown joins the worker.

A half-TTL background refresh is process-owned work with its own root and a
link to the triggering request-admission decision. It must not extend a
finished request root or invent a current request. If a request later
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

Historical #59 delivery order (completed admissions are recorded in the
[global TODO](../../TODO.md)):

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

## Bridge load and outage admission

Policy 4 measures 100 sequential actual `GET
/api/app/workspace/v1/agents/{agentId}/sessions` requests with the same opaque
token, route-selected `workspace` profile and Agent. Use the actual default
10-second cache TTL. Begin a client-monotonic timer before sending the first
request to a cold exact Resolve scope and a cold Bridge owner; end it only
after receiving the hundredth complete response body. The whole interval must
be at most eight seconds. Do not warm this scope or owner through bootstrap,
view, SSE, private ACP initialization or any other request before timing, and
do not report activity during the window. Setup may provision the Agent and
browser credential through other scopes. The first measured HTTP request must
include the real Bridge/ACP initialization it requires; initialization is not
an extra public request outside the hundred or the timer.

Every response must be HTTP 200 with the owning
[`sessionPage` DTO](../agent-ui/workspace-api.schema.json): `items` and
`nextCursor`, with each item carrying `sessionId`, `title`, `updatedAt` and
`activeOperationId`. Preserve the schema's valid nulls and empty/partial pages;
neither JSON-RPC `result.sessions` nor a required full page is this response.
Record every request's actual Trace ID, send and complete-body observations.
Hold the final request until after half of the original cache TTL, within the
same eight-second window, and require its actual background-refresh trigger
and completed source evidence.

Count actual Gateway Resolve CLIENT attempts and Identity Resolve SERVER calls
independently; each count must be at most three. Include initialization,
foreground and background work, including failed attempts without a receiver.
Refresh triggered by a measured request counts even when its RPC completes
after the last HTTP body. Feed, activity and JWKS calls remain separate; a
cache-hit metric is not a count of network calls. Collect the actual per-HTTP
Gateway roots, direct Gateway CLIENT to Agent UI SERVER ancestry, workspace
Resolve decisions and real ACP `session/list` receipts, including the first
initialization. Preserve source links, both complete parent chains and
non-Resolve SQL/business evidence. Independently search CLIENT and SERVER
inventories, reject saturated searches and require complete closure stable for
three consecutive rounds, including late refresh workers. Archive every raw
source and retain its original strict diagnostic result.

Complete the measured response window before retiring its Bridge owner. Capture
the selected images, original containers, configurations and process starts
before the first request. Stop only that Agent UI container, require normal
exit within 30 seconds, and inspect its complete stdout and stderr for forced
drain or cleanup failures. Keep ACP, Identity, Gateway, Controller, Runtime and
telemetry participants alive with their original processes. Collect and archive
the completed traces before restarting the same UI container with its original
image and configuration; require healthy readiness within 30 seconds before
the outage scenario. Attempt this restoration even when collection fails and
preserve both the original and restoration errors.

A zero exit does not prove protocol cleanup. Require exactly one
`agent-ui / agent_ui.acp.close` INTERNAL root without a synchronous parent,
with `requested` trigger and `closed` outcome. Its unique Link must identify
the exact Agent UI HTTP span that initialized this measured owner. Require
one completed workspace ACP SERVER `DELETE /v1/acp`, HTTP 202, directly
parented by that close root. Do not invent an outbound CLIENT. Independently
search close roots and DELETE receivers and include their raw source closure
in the same three stable rounds as the HTTP requests and refresh workers.

Enumerate every actual private ACP GET and execution-state watch receipt for
this owner; do not assume a fixed stream count. A normal UI-drain error claim
requires the exact initial HTTP parent, matching protocol and signed scope
where the producer records it, the complete stream, and same-service clock
evidence relating its end to the observed stop interval. The watch can finish
before the ACP close root because UI drain aborts the watch first. Do not
equate host and service clocks or infer receiver timing from a different
service's HTTP Date. Only the producer's exact `stream_interrupted` /
`disconnected` diagnostics without extra error fields or events are eligible;
early EOF, process shutdown, access denial and unrelated errors fail this
claim. Keep every raw ERROR and warning, and preserve `strict_trace=failed`
when present even when all errors have proved business ownership.

For the five-second outage, warm the exact browser `workspace` scope and retain
an established Bridge SSE with enough original cache, idle, absolute, Node CCT
and JWKS authority remaining. Hold accepted work in one identified
organization/User/Agent/Session/Run and Runtime instance until the actual
correlated cancellation. While the real Identity service is stopped, receive
new real output through `/api/app/workspace/v1/agents/{agentId}/events` and send
the real HTTP operation-cancel request. Prove that same Run's terminal outcome
and that same Runtime execution's quiescence before restarting Identity.
Unrelated idle work, natural completion, a replacement Run or local stream
abort cannot establish this admission.

Retain new-login, cold-token/profile/Agent and exhausted cache/session/CCT
denials without Cookie loss or downstream effects. After recovery, retain
logout/password/role/deactivation rejection, no resurrection and independently
observed remote closure within the respective bounds. Preserve actual outage
timestamps, authority budgets, raw traces, strict error ownership and cleanup
receipts. Old WSS, a protocol double or a passing shared-contract test cannot
substitute for these actual Bridge/Runtime results. Store the #64 evidence in
`artifacts/verification/issue-64/`, outside `.cache`.

### Current suite completion

The final current report explicitly identifies policy 4. Admit the complete
HTTP load through its full owning admission, including original-owner drain,
protocol cleanup and restoration. The outage must identify `http-sse` and
carry all eight successful owning gates and complete raw diagnostic admission.
Bind its business fields to the cancellation inspector's checked `business`
result: the same Run and Runtime execution, new output, terminal outcome and
Runtime quiescence must occur within the actual five-second-or-longer stop.
Retain the cancellation inspector's original timing, error ownership and
transport receipts; an isolated `passed` marker does not replace that result.

The four recovery cases are logout, password change, role change and member
deactivation. Bind their exact business results to `recovery_runs.business`
and the same Run IDs to its owning `runs`. Require independently observed
remote SSE closure within 30 seconds; a historical WSS field is not a Bridge
receipt. Keep the other recovery, authority and stream inspectors' evidence.

Join the final Trace inventory to the unique complete archived closure, and
reconcile the diagnostic error claims with the exact union of owning-gate
claims, including their reasons and owners. Preserve source closure and raw
strict findings; source warnings may appear in more than one per-Trace report
and must not be counted as distinct raw warnings merely by summing reports.
The raw diagnostic inspector retains a unique per-Trace span/error/warning
inventory; the final global counts and each source-closure summary must agree
with it. Recovery owning reports retain their checked current view and SSE
Trace IDs, distinct from the authorization source IDs, to join the same cases.
Cleanup must be verified before publishing completion. Missing, pending or
failed evidence, unknown revisions and mixed legacy/current scenarios fail
completion. Policy-3 records remain historical and cannot admit policy 4.
This shared contract does not itself complete the consumer or Docker batch.

### Historical direct-ACP measurement

The following policy-3 outage/load procedure records the #59 direct-ACP
baseline. It does not admit Gateway 24 Bridge load or outage behavior. The
policy-4 replacement above preserves the 100-call/eight-second/three-Resolve
budgets, actual initialization/refresh accounting and five-second outage with
output and same-Run cancellation. The retirement policy's wire baseline remains
revision 3; it is not a current Bridge acceptance result.

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
