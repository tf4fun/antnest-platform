# Business Flow Reliability Remediation Plan

> Lifecycle execution update (2026-09-12): all five commands now use Temporal
> workflows and SDK Activities. The PostgreSQL worker, claim/lease scheduler and
> custom recovery spans described in the earlier analysis below are superseded
> by [the current lifecycle contract](../services/agent-controller/docs/lifecycle-workflows.md).
> The business ordering and domain transactions remain; there is no dual executor.

> Date: 2026-09-02
> Status: implementation corrections complete; full admission verification passed
> Scope: the reconstructed `antnest-platform` services only

## 1. Purpose

The business-sequence review found several places where a correct local
mechanism is connected into an unreliable end-to-end flow. This plan records
the confirmed problems, rejects unnecessary infrastructure, and defines
bounded implementation packages with measurable acceptance criteria.

The intended control-plane model is:

- HTTP mutations commit durable intent and return promptly;
- one service owns each business invariant and its persistence;
- background work advances one durable phase at a time;
- events improve convergence but never replace authoritative state;
- ambiguous side effects remain ambiguous instead of being guessed into
  success or failure;
- retries preserve one user-action identity from browser to owner service.

This plan does not introduce a general workflow engine, message broker,
distributed transaction, service-to-service JWT, or duplicate read model.

## 2. Confirmed Findings

### 2.1 Lifecycle execution

| ID | Priority | Confirmed fact | Consequence |
| --- | --- | --- | --- |
| L01 | P1 | Create, rebuild, disable, enable, and delete persist an operation and then continue convergence inside the HTTP request | Browser latency and request deadlines are coupled to Docker, Runtime, and Egress latency |
| L02 | P1 | A PostgreSQL-leased recovery worker already exists, but it only claims attempts already reserved for recovery or operations older than the stale threshold | Fresh operations cannot be delegated immediately without changing claim eligibility |
| L03 | P1 | Admin Console creates a new request ID for each browser request | A timeout followed by a browser retry can create a second lifecycle operation |
| L04 | P2 | Operation and Agent events are durable, but the browser treats the initial HTTP response as the completion boundary for some actions | Delete navigates away immediately and progress presentation is inconsistent |
| L05 | P1 | Rebuild requires an open attachment when replaying its network-fence phase | A lost response after a successful close is interpreted as failure and can leave the source fenced |
| L06 | P1 | Delete accepts only an active, closed allocation when replaying its network-release phase | A lost response after successful quarantine can leave delete permanently running |

The earlier statement that every lifecycle call blocks until a terminal state
was too broad. The current request advances as far as it can and may return a
running operation after a dependency error or deadline. The coupling is still
real and should be removed.

### 2.2 Tool side-effect integrity

| ID | Priority | Confirmed fact | Consequence |
| --- | --- | --- | --- |
| T01 | P1 | Runtime MCP can return `outcome_unknown`, but Agent ACP drops structured error content and maps every received result to `settled` | A model can retry a write or command whose effect may already have happened |
| T02 | P1 | Atomic write/edit can complete `rename` and then fail directory sync or verification while reporting an ordinary known failure | Post-commit ambiguity is hidden at the Runtime boundary |
| T03 | P2 | MCP connection and initialization failures share a catch path with a disconnect after `tools/call` dispatch | Definite pre-dispatch absence is mislabeled as an unknown side effect |

### 2.3 Authorization, identity, and idempotency

| ID | Priority | Confirmed fact | Consequence |
| --- | --- | --- | --- |
| A01 | P1 | Admin Console performs an unscoped Agent read and then applies the organization check before lifecycle and event forwarding | The BFF is the sole tenant authorization boundary and Agent Controller audit lacks the actor |
| A02 | P1 | Logout ignores Identity resolution/revocation failures, clears all cookies, and returns success | A copied token may remain usable while the browser loses its retry credential |
| A03 | P1 | Public password login reaches Argon2 verification without an Edge admission limit | Password guessing and compute exhaustion are unnecessarily cheap |
| A04 | P1 | Existing SSE connections are authorized only when admitted | Token revocation or principal disable does not terminate a long-lived stream |
| A05 | P2 | A first non-replay ACP prompt resolves access and then calls authoritative Run acquisition, reaching Identity twice | Prompt latency and dependency exposure are duplicated |
| A06 | P2 | Identity token resolution executes an `UPDATE` on every request even when last-use telemetry need not change | Authorization reads create row locks and PostgreSQL version churn |

The trusted internal network remains an explicit deployment boundary. This
plan does not add application JWT or mTLS between internal services. Business
authorization still belongs to the service owning the resource.

### 2.4 Runtime Egress and Runtime observations

| ID | Priority | Confirmed fact | Consequence |
| --- | --- | --- | --- |
| N01 | P1 | Egress represents both desired policy and lifecycle deny-all fencing with the same durable assignment | A user-selected deny-all policy can be mistaken for a temporary fence and later overwritten |
| N02 | P1 | Agent Controller duplicates fence/reset choreography already owned by Egress | Ordering is harder to prove and reset can occur while the old Runtime still exists |
| N03 | P2 | A same-generation container restart gets a new Runtime execution ID, but Agent Controller retains the old executable snapshot | Tool calls can target stale execution state |
| N04 | P1 | A closed Runtime attachment removes the Agent route from Egress, while Runtime readiness requires an Egress packet-path reply before Agent Controller opens that attachment | Runtime creation enters a circular wait: Egress reports the probe as an unknown Agent, Runtime restarts, and the lifecycle operation never settles |
| N05 | P1 | Attachment admission is split between a route snapshot and a separate process-local fence set; snapshot replacement clears every fence | Closed allocations cannot be recovered atomically without either forwarding traffic or remaining unknown |
| N06 | P1 | Egress commits `closed` before flow and conntrack cleanup completes | A crash or cleanup failure makes durable `closed` claim a barrier that was never established |
| N07 | P1 | Release performs close and cleanup before validating the caller's network resource version; attachment transitions do not require an active allocation | A stale release or delayed open can mutate a newer or quarantined lifecycle |
| N08 | P2 | Same-state attachment replay ignores the expected resource version, and the readiness packet shape is documented only in prose | A stale request can masquerade as an exact retry, while implementations can drift on the probe exception |

### 2.5 Read aggregation and realtime convergence

| ID | Priority | Confirmed fact | Consequence |
| --- | --- | --- | --- |
| R01 | P2 | Admin overview performs four upstream requests sequentially and fails the aggregate on any one error | Dashboard latency is additive and partial data is discarded |
| R02 | P2 | Browser EventSource reconnect keeps the original query cursor and does not explicitly restore from the latest delivered sequence | Reconnect can duplicate a large backlog or miss an expired-cursor recovery path |
| R03 | P2 | Admin raw-proxies private control-plane fields that the browser does not use | Runtime endpoints, credential references, and access internals cross an unnecessary boundary |
| R04 | P2 | Resolved: Edge owns explicit OIDC start/callback and SCIM pass-through routes | Protocol requests cannot fall through to the SPA, and browser credentials stay at Edge |
| R05 | P3 | Edge probes Identity directly and indirectly through Admin readiness | Duplicate health traffic exists, but no material failure has been demonstrated |
| R06 | P1 | Stage 3 acceptance treats the terminal lifecycle event trace as the complete asynchronous Saga trace | Correct phase-local traces fail acceptance, while earlier phase dependencies cannot be proven |
| R07 | P2 | Fatal lifecycle quarantine records the worker-loop context trace ID after the attempt trace has ended | The durable quarantine event can lose correlation with the attempt that exposed the invariant failure |

### 2.6 Verification integrity

| ID | Priority | Confirmed fact | Consequence |
| --- | --- | --- | --- |
| Q01 | P1 | The Go format gate captures `gofmt` output inside `test -z` without preserving command failure | A missing or failed formatter can manufacture a green format result |

## 3. Rejected Or Qualified Findings

- The lifecycle recovery worker is not missing; its eligibility model is too
  narrow for immediate asynchronous execution.
- Agent Controller's terminal admission projection is not a second Run owner.
  It is allowed to retain the minimum state needed to release or block Agent
  occupancy.
- Internal trusted headers are not an application vulnerability under the
  documented trusted-network deployment model. Network reachability remains a
  deployment prerequisite.
- SSE is not an authoritative message bus. It is a wake-up and replay channel
  over durable Agent and Operation projections.
- Dashboard data does not justify another persistent aggregate or cache.

## 4. Target Lifecycle Model

### 4.1 Command path

1. The browser creates one opaque idempotency key for a user action and retains
   it until a conclusive response is observed.
2. Edge authenticates the request and forwards actor, organization, and the
   stable key.
3. Admin validates browser input and forwards the same values without reading
   the Agent first.
4. Agent Controller performs owner-scoped validation and atomically commits the
   Agent mutation, lifecycle operation, and requested event.
5. Agent Controller returns `202 Accepted` with the authoritative operation and
   Agent identifier. It does not call Runtime Controller or Egress from the
   request path.
6. A lifecycle worker can claim the fresh running operation immediately after
   commit and advances one durable phase per lease. Polling bounds scheduling
   latency; it is not presented as zero-latency delivery.

### 4.2 Worker path

The current recovery worker becomes the sole lifecycle execution path. Multiple
service replicas may run workers concurrently; `SKIP LOCKED`, a per-operation
lease, and a monotonic lease generation ensure that only one worker owns an
operation at a time. A fresh operation and a stale operation use the same
claim, phase transition, retry, and observability model.

Claim eligibility is:

- operation state is `running`;
- `recovery_after` is due;
- no live lease exists.

Every `Begin*` transaction sets `recovery_after` from the database clock. The
current repository already stamps it at insertion; tests must make this
invariant explicit. `created_at` and attempt number must not decide whether an
operation is eligible.

The current `attempt` value is a fencing generation, not merely diagnostic
evidence. Accepted operations start at generation zero; the first worker claim
increments it to one. Every post-admission phase mutation requires the matching
live lease token even while an operation is momentarily unleased. Only the
atomic `Begin*` transaction may write without a worker lease.

Each claim advances at most one durable phase. Scheduling has three outcomes:

- progress releases with zero delay so the next phase is immediately eligible;
- a normal pending/no-progress response releases with the polling interval;
- a retryable no-progress failure releases with bounded exponential backoff.

Every terminal transition transaction clears the worker owner and lease. A
malformed operation is terminalized or quarantined as an operation-local
failure; it must not stop workers from processing unrelated operations.

### 4.3 Browser convergence

The browser treats `202` as acceptance, not completion:

- show the returned operation immediately;
- keep lifecycle controls disabled while the authoritative Agent reports an
  active running operation;
- subscribe to Agent events through SSE;
- on every event, refresh Agent and Operation projections;
- after disconnect, re-list from the latest delivered sequence before opening
  a new stream;
- after page reload, read Agent, active Operation, and event history before
  rendering controls;
- navigate away after delete only when the delete operation is terminal.

User-facing stages map stable domain phases to plain language. Internal worker
leases, attempts, and recovery ownership remain hidden.

## 5. Delivery Packages

### P1. Asynchronous lifecycle and tenant ownership

Changes:

- split lifecycle application methods into `Begin*` behavior and worker-only
  phase execution without duplicating Saga state;
- make all running, due, unleased operations immediately claimable;
- remove online convergence, the stale-age claim gate, and lifecycle HTTP
  dependency timeout;
- carry organization and actor through Admin lifecycle, Operation, and event
  contracts;
- enforce organization in Agent Controller owner queries;
- preserve one browser idempotency key across ambiguous retries, scoped to the
  organization and bound to the immutable command fingerprint; conflicting
  reuse returns `409`;
- update Browser operation progress and reconnect behavior.

Acceptance:

- lifecycle handlers perform no Runtime Controller or Egress call;
- a fresh operation is claimable without waiting for the stale threshold;
- post-admission phase writes without a live lease token are rejected;
- progressed, pending, and failed claims receive distinct schedules;
- a terminal transition leaves no lease and one malformed operation cannot
  stop unrelated lifecycle work;
- process restart after any committed phase converges through the same worker;
- duplicate browser submission with the same key returns the same operation;
- conflicting reuse of the key returns `409`;
- a cross-organization Agent ID is indistinguishable from not found at Agent
  Controller for Agent, Operation, and event reads;
- SSE disconnect and page reload converge to the same terminal projection.

### P2. Tool effect-state preservation

Changes:

- define one explicit Runtime-to-ACP effect projection in MCP
  `structuredContent`: `effect_state` is `none`, `settled`, or `unknown`, and
  `effect_source` plus stable Runtime `error_code` accompany unknown results;
- preserve and validate Runtime `structuredContent` through the official MCP
  SDK adapter; malformed or missing effect state on an error is treated
  conservatively as `unknown` after invocation;
- distinguish failure before dispatch from interrupted dispatched calls;
- take invocation of `client.callTool` as the conservative dispatch boundary;
- preserve a typed committed-but-unknown error from the filesystem layer
  through Tool and MCP layers for every failure after rename, including parent
  sync, reopen, readback, and verification mismatch;
- terminate the Run on unknown effects without model-driven automatic retry.

Acceptance:

- URL parsing, client lookup, connection, and initialization failures before
  `client.callTool` are `none`;
- `isError: false` is `settled`;
- a received known Tool error uses the Runtime-declared `none` or `settled`;
- disconnect after invocation and every post-rename verification failure are
  `unknown`;
- the next model request is not issued after an unknown Tool effect;
- Run terminal evidence retains typed source and Runtime error code.

### P3. Session security and Identity hot path

Changes:

- add one idempotent Identity `RevokeByAccessToken` operation returning typed
  `revoked` or `already_invalid`, and clear cookies only after either result;
- add bounded login admission at Edge by source and normalized account key;
- give Edge-proxied SSE watch requests a bounded deadline, forcing periodic
  reconnect and fresh authentication;
- make authorization resolution read-only and sample last-use telemetry through
  a conditional best-effort update;
- let ACP prompt use authoritative Run acquisition directly.

Acceptance:

- retryable revoke failure preserves browser credentials and returns failure;
- repeated failed login is bounded before repeated Argon2 work;
- revocation/disable ends access no later than the stream lease;
- repeated token resolution does not update the row inside the sampling window;
- first prompt performs one authoritative Agent/Identity admission path.

### P4. Egress lifecycle ownership

Changes:

- persist desired Agent policy independently from Runtime attachment state;
- expose one Egress-owned close/open attachment operation with CAS;
- make admission an atomic route property with `open`, `probe_only`, and
  `hard_fenced` values instead of a route plus an independent fence set;
- close first installs `hard_fenced`, drains packet writers, and clears
  userspace and conntrack flow state; only then may it commit durable `closed`
  and publish `probe_only`, so durable `closed` proves cleanup completion;
- retain the allocated Tunnel route while closed in `probe_only`; answer only
  the exact reserved readiness SYN locally with a TCP reset, without creating a
  flow or writing to TUN;
- open restores forwarding from current desired policy only after Runtime
  readiness;
- require every attachment mutation to reference an active allocation, bind
  same-state replay to the current or immediately preceding resource version,
  and reject older cycles;
- quarantine validates the network version before any destructive in-memory
  action, then removes the route and performs bounded cleanup; retry reconciles
  an already-quarantined allocation;
- make rebuild accept an already-closed active attachment as the replay of its
  own fence phase, and make delete accept an already-quarantined allocation as
  the replay of release;
- remove Agent Controller's duplicate reset choreography.

Acceptance:

- desired deny-all survives disable, rebuild, and enable;
- stale close/open requests fail CAS without replacing newer state;
- a newly allocated, closed attachment answers the exact Runtime readiness
  probe, while every other packet from that Agent remains fenced;
- readiness probing creates no userspace flow and sends no packet to TUN or an
  external destination;
- Egress cold recovery atomically restores open and probe-only routes, while
  quarantined allocations remain absent;
- `closed` is never visible before packet writers, userspace flows, and kernel
  flow state have crossed the cleanup barrier;
- a stale release performs no fence, cleanup, or quarantine side effect;
- lost responses after rebuild close and delete quarantine converge on retry;
- the shared packet contract and fixtures define the exact readiness request
  and response; near misses remain fenced;
- old Runtime flow state is gone before attachment opens for the replacement;
- Agent Controller calls one Egress lifecycle abstraction per transition.

### P5. Read and public-route hardening

Changes:

- extract a pure buffered upstream fetch, execute overview fan-out concurrently
  under one bounded deadline, then serialize one response; never write to the
  shared `ResponseWriter` from worker goroutines;
- return stable section envelopes and named errors, with Agent inventory
  required while directory and Template sections may degrade;
- define browser-specific DTOs in Admin;
- connect typed OIDC discovery/start/callback and protocol-preserving SCIM
  routes at Edge, with unknown OIDC paths failing closed;
- retain duplicate readiness probing unless measured load justifies removal;
- consume same-generation Runtime restart observations and make the Agent
  unavailable pending explicit rebuild.

Acceptance:

- overview duration is bounded by the slowest dependency rather than their sum;
- one optional overview failure does not erase unrelated data;
- browser payloads contain no credential, access-subject, or Runtime endpoint
  fields;
- OIDC/SCIM routes never return SPA HTML and preserve their distinct credential boundaries;
- stale Runtime execution cannot remain executable after a restart observation.

## 6. Implementation Order

1. P1 asynchronous lifecycle and tenant ownership.
2. P2 Tool effect-state preservation.
3. P4 Egress lifecycle ownership.
4. P3 session security and Identity hot path.
5. P5 read and public-route hardening.

P1 comes first because it shortens the administrator critical path and gives
the remaining control-plane changes one durable execution model. P2 precedes
network and session tuning because hidden Tool ambiguity can corrupt Agent
work. P4 changes lifecycle internals but not the public command model. P3 and
P5 are independently deployable once actor and idempotency propagation from P1
exist.

## 7. Verification Strategy

Each package requires:

- domain/application unit tests for state transitions and rejected edges;
- repository integration tests for transaction, lease, CAS, and replay
  invariants;
- HTTP contract tests for status, error, tenant, and idempotency semantics;
- a focused multi-service integration test for the changed path;
- browser automation for lifecycle progress, reload, reconnect, and terminal
  action behavior when P1 changes the Console;
- format, lint, module tests, architecture checks, and documentation checks run
  serially by the coordinator.

External provider tests are not required for these control-plane corrections.
Docker-backed tests must clean up containers and volumes after completion.

Asynchronous lifecycle observability is verified within the originating
business trace. The admission HTTP span ends normally at `202`; the first
durable attempt restores its parent from that admission, and later attempts
restore the preceding attempt's context. Acceptance validates the exact
Gateway -> Console -> Controller ancestry, ordered attempt parents and actual
downstream calls in one trace. Independent roots connected only by Span Links
do not satisfy this requirement. See the Agent Controller
[observability contract](../services/agent-controller/docs/observability.md#asynchronous-lifecycle-causality).

## 8. Implementation Record

| Package | Status | Result |
| --- | --- | --- |
| P1 | implemented | Lifecycle commands commit intent and return `202`; leased workers execute phases; organization ownership and stable browser idempotency are enforced |
| P2 | implemented | Runtime and ACP preserve `none`, `settled`, and `unknown` effects; post-dispatch ambiguity terminates the Run |
| P3 | implemented | Raw-token idempotent revoke, bounded login admission, SSE leases, sampled token use, and direct prompt admission are in place |
| P4 | implemented | Runtime Egress owns atomic route gates, readiness-only closed attachments, cleanup-before-close barriers, active-allocation CAS, bounded replay, and quarantine-first release |
| P5 | implemented | Concurrent degraded overview, browser DTO allowlists, connected OIDC/SCIM protocol routes, and Runtime restart invalidation are in place |

Five independent read-only adversarial reviews examined lifecycle execution,
Tool-effect semantics, the Stage 3 Edge/Admin boundary, Egress readiness, and
asynchronous trace evidence. The coordinator implemented every accepted
finding and ran all shared-resource verification serially. Repository format,
Go/Rust/Node lint, Go/Rust/Node tests, all PostgreSQL integration profiles, JSON
contract parsing, and the disposable Stage 3 lifecycle/Jaeger acceptance pass.
The Stage 3 proof includes create, disable, enable, rebuild, delete, Runtime and
workspace cleanup, phase-specific trace topology, causal links, secret
exclusion, and the sole-ingress port boundary.
