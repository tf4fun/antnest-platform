# Agent UI Architecture

Agent UI is one TypeScript/Node service. Its Node process owns the ACP Bridge,
HTTP API, SSE streams, static assets and React SSR. The browser uses same-origin
HTTP commands and SSE observation; it does not connect to ACP. The Edge Gateway
authenticates requests and proxies them to the Node service through one
`ANTNEST_AGENT_UI_URL` target. The browser contract is the
[Workspace API](../../../contracts/agent-ui/workspace-api.md).

## Ownership

```text
Browser: BridgeApp -> useBridgeWorkspace -> BridgeHttpClient / SSE observer
                                    -> WorkspacePage / presentation components
Edge Gateway: identity, CSRF and streaming proxy
Agent UI Node: HTTP routes -> owner registry -> ACP SDK connection / replay
ACP Service: Session, Run, history, permissions and durable intent authority
Agent Controller: Agent directory and lifecycle
```

The browser owns only the route, draft, unsent attachments, expanded details and
other presentation state. `use-bridge-workspace.ts` coordinates the current
Agent and Session; `bridge-agent-controller.ts` applies versioned views and
operations. `WorkspacePage.tsx` renders the model without transport knowledge.

The Node Bridge owns an ACP connection per authorized owner, Session replay,
compact views, operation reconciliation and permission requests. A browser
reload or disconnect removes an observer, not an accepted Run. The Bridge can
reconstruct its view after restart; ACP remains authoritative for admission,
execution and persisted output. There are no cumulative Session, owner or
global history byte quotas; memory is bounded by owner, observer, journal and
replay limits (see [Bridge capacity and lifetimes](#bridge-capacity-and-lifetimes)).
A failed replay never replaces the previous readable view.

## Request and observation flow

1. Gateway authenticates the principal and forwards the scoped request to Node.
2. Node renders a request-scoped SSR shell with a bounded bootstrap wait. The
   browser hydrates that exact shell in an inert state, validates its current
   Cookies with `GET /api/session`, then loads discovery and observes the
   selected Agent. SSR data is not proof of the browser's current session.
3. Browser commands use same-origin HTTP. A Prompt carries one stable intent;
   an uncertain HTTP response is reconciled by that intent rather than resent.
4. SSE delivers versioned Agent and Session views. On a gap or process epoch
   change, the browser fetches an authoritative snapshot.
5. A Run remains in ACP after the browser closes or Node restarts. Re-entering
   the workspace reloads its view and any pending permission request.

Node owns each Workspace document's nonce-bearing CSP. Gateway preserves that
policy and supplies only missing security headers, per its
[response security header rules](../../edge-gateway/docs/architecture.md#response-security-headers).
The browser entry loads `browser-validation.ts` before modules that construct
frontend schemas, enabling Zod's `jitless` parser. This skips the default
`new Function` environment probe, which otherwise emits a CSP violation even
when Zod catches the exception and falls back to interpretation. Schema
validation remains enabled; the document's CSP does not allow `unsafe-eval`.
Server-side parsing keeps its existing configuration.

Bootstrap and SSR share `readWorkspacePrincipal`: it requires private verified
CCT claims and the two display headers from Gateway revision 24. Signed claims
determine Organization/Principal IDs and administrator status; raw identity and
administrator hints grant nothing. Each label must be canonical unpadded Base64URL over
valid UTF-8 and decode to a non-whitespace string. Invalid or missing metadata
returns `401` before discovery or rendering. The real bootstrap principal uses
the central `verifiedWorkspacePrincipal` schema, including `organizationSlug`
and `organizationName`. Both browser bootstrap decoders preserve those fields;
the chooser and account footer render the name as escaped text. SSR serializes
the same response for hydration; there is no successful placeholder fallback.

Labels are excluded from owner keys, Agent/Session admission and identity-change
comparisons. Node does not cache Organization metadata. Gateway may supply the
same complete Principal until its bounded Resolve snapshot expires (default
TTL 10 seconds, measured from the actual Resolve start). Hits and healthy empty
feed pages do not renew it. After expiry the next actual session/bootstrap/SSR
read requires live resolution; user-visible timing includes that read and its
request latency. Already rendered text has no background rename watcher.
Repeated old snapshots and a later display-only update retain the same-identity
Agent/Session selection and unsaved draft.
See the [projection contract](../../../contracts/agent-ui/organization-projection.md)
for the shared cache policy and explicit display integration requirements.

The [Skill learning system notices](../../../docs/skill-learning-notifications-design.md)
use SDK 1.5.0's `notice` for live delivery from ACP, then reuse this HTTP/SSE
browser path. ACP persists learning changes before publishing; Node advertises
notice support, handles it independently of cached Session transcripts,
deduplicates by namespaced change identity and reconciles bounded records after
gaps. FE restores the separate system-notice field from Agent View snapshots/
deltas. These are not model messages, Run process entries or ACP delivery marks.
There is no notification long-poll, second browser stream or notification service.
Paused-review diagnostics use the existing Agent View endpoint
(`GET /agents/A/view?learningStatus=1`) only when the user opens learning
results; ordinary Views, stream refreshes and runtime sweeps do not query them.
Only applied changes produce a toast and result count; source links use the
existing conversation route. Unknown reads remain unavailable rather than
reporting successful learning. Unavailability describes a prior unfinished
review; diagnostics do not promise to replay an unknown model request. New
completed tasks can still be reviewed when the service recovers, subject to the
existing idle, cooldown and budget limits.

The Node connection to ACP uses the official SDK over its internal HTTP
transport. The standard ACP WebSocket endpoint can still serve other clients;
it is outside the Agent UI browser path.

## Boundaries and failure behavior

Authorized ACP Agent execution-state reads and watches supply the optional
`AgentView.unavailableReason`. Node preserves only the public classification;
snapshots and SSE deltas never include barrier IDs or recovery request details.
The browser clears prior guidance on a null or absent replacement reason,
Agent/identity changes, loss of a current view and access revocation. A healthy
management Runtime does not hide an execution barrier. With no Session selected,
the workspace still explains that an interrupted tool call requires recovery.
Verified administrators receive a same-origin link to that Agent's existing
Console recovery action; other members are directed to an administrator. Agent
UI sends no Rebuild command and does not expand lifecycle permissions. Console
authorizes the action and requires confirmation of the current recovery identity.
This service projection is separate from real manual fault-recovery acceptance.

The browser never receives the ACP access subject, provider credentials,
internal service addresses or Runtime endpoints. Gateway owns browser identity
and CSRF; Node scopes its owners and private caches to that identity. Access
loss clears the browser's private view and redirects through the Gateway login
entry with the selected route preserved. If an authorized bootstrap replaces
the browser session without a redirect, the browser also clears in-memory
drafts and unsent attachments before resuming, even for the same principal and
Agent ID. Each application instance owns its validation generation; requests,
response bodies, operations, attachments and SSE callbacks verify both that
generation and the current CSRF delivery hint before applying a result. The
hint detects replacement and is not authentication. Replacement aborts old
requests and observers, clears recovery timers and releases attachment URLs.

Account controls are reachable from the chooser, no-Agent page, and expanded,
collapsed or mobile navigation. Public session inventory spans the user's
organizations and renders browser descriptions as plain text. Revocation asks
for confirmation; a transient failure keeps the current view and does not
replay the mutation. Local password controls require Identity's capability.
A successful password writer owns a fresh session read independently of the old
dialog's lifetime. The application offers explicit validation retry after a
transient read failure. Explicit sign-out returns to the login entry; expiry
preserves the current workspace return route.

External bindings and binding notices belong to that validated shell, outside
Agent selection and the account dialog. The shell reads inventory once per
session generation; it does not poll or acknowledge on read. SSR cannot fetch
this private inventory before browser validation. The notice banner remains
available during Workspace failure and while an unread notice page remains.
The dialog preserves the other stream's rows and cursor when paging bindings
or notices, and keeps displayed data on a transient failure. Provider, organization
and subject snapshots are plain text, including historical notices whose binding
or organization is no longer available; subject whitespace is preserved.

Each explicit ACK freezes its notice ID and removes only that notice after a
successful response, including an already-acknowledged count of zero. Restored
bindings produce a different notice ID. Unbind confirmation freezes the selected
binding and is discarded when the dialog closes. A last-method response requires
a second explicit `allow_lockout` action. A successful noncurrent unbind refreshes
inventory once; `current_revoked` retires the generation and redirects without
another read or logout. Late results and CSRF replacement cannot modify a new
session. Gateway owns all three routes under `/api/session/external-identities`;
Node does not implement alternate account endpoints. See
[OIDC linking](../../../contracts/identity/oidc-linking.md).

The browser reports activity only for trusted keyboard, input, pointer, wheel
and touch events in a visible document. Reports have a leading call and a
trailing call only when more input arrived, with one in-flight request and the
server's interval measured from dispatch. Reads, stream events, focus changes,
synthetic input and periodic timers alone cannot extend idle time. All activity
timers and requests are disposed with their session generation. See the
[browser session contract](../../../contracts/identity/browser-sessions.md).

Workspace writes and logout copy the opaque CSRF delivery value from
`__Host-antnest_csrf`. The explicit insecure loopback deployment can supply
`antnest_csrf` when the prefixed cookie is absent. A malformed or duplicate
prefixed value never falls back to a legacy value. The browser does not infer
cookie mode from the URL or derive the token; Gateway verifies the header
against the authenticated Identity session under the
[session security contract](../../../contracts/edge-gateway/session-security.md).
Logout `204` and the Gateway's already-invalid-session `401` close the observer,
clear private Workspace state and drafts, and return to login. Late discovery
refreshes cannot restore that cleared state. `403`, transient and network
failures preserve the Workspace and show a retryable sign-out failure.

A Session load must complete before its composer or configuration controls
become available. Failed replay keeps the previous readable history and offers
retry. Switching Sessions does not cancel a Run; Stop targets the selected
accepted Run, and a late Stop for an older Run cannot cancel a newer one.
Transport failure never turns an uncertain submission into an automatic retry.
Failed ACP Runs carry their persisted `errorClass` through the Bridge operation
View and SSE. The browser maps `model_unsupported_content` to an actionable
attachment message for the latest failed turn; the composer becomes available
again when the Agent is ready. Unknown failure classes keep the generic Run
failure notice.
After keyboard submission temporarily disables the editor, focus returns to it
when the Run settles if the user has not moved focus elsewhere. Moving to
another control or clicking the page cancels that restoration.
The browser retries a failed observer after 1, 2, 4 and later bounded delays
up to 30 seconds. A live SSE connection resets this backoff; selecting another
Session or explicitly refreshing can start a new read immediately.

Drafts and unsent attachments stay scoped to their Agent and Session in memory.
Session history, Agent availability, configuration, Usage and permissions come
from authoritative Bridge views. Tool details and older turns load on demand.
ACP's unmarked `session_info_update` sideband also flows through the Session View as nullable
title and update time. The browser uses these fields for navigation metadata;
late catalog pages or older Views cannot replace a newer server timestamp.
When ACP has no update time, the browser does not stamp the View with its own
clock.
Expanded process content is released after collapse; content previews are
reclaimed when their last local reference is removed.
Creating a Session records it in the local directory before selection. A late
creation response cannot replace a Session the user selected afterward, and a
same-identity bootstrap arriving after creation merges discovery without
discarding the new Session.

Node drain first rejects new requests with retryable 503 and marks `/status`
unready while `/live` remains available. It aborts pending owner initialization,
closes observers and execution-state watches, and gives accepted work up to
15 seconds to settle without cancelling ACP Runs. Owner retirement then joins
the actual ACP transport cleanup, including the full DELETE response body,
before telemetry and authenticated dependency clients shut down. Cleanup has
a separate 5-second deadline: expiry aborts outstanding transport requests and
still joins their termination before reporting failure. An initializing ACP
connection also has a 10-second deadline; cancellation joins any late-created
connection's cleanup before initialization fails. Repeated close calls share
the same completion and retain the same failure.
Signal shutdown awaits service close, telemetry SDK shutdown, and authentication
client close in that order, attempting every step even after a failure.
Telemetry shutdown failures produce a warning and do not change the exit status;
service or authentication cleanup failures still produce a nonzero exit status.
The forced-drain warning covers either accepted work left for ACP to continue
or unsuccessful resource cleanup. Exit status alone therefore does not prove
clean connection retirement. Single-replica deployment is the current model. Multi-replica
ownership needs a separate lease and fencing design.
The Node process starts OTLP/HTTP tracing and metrics when configured, records
bounded route names and final status for each HTTP request, and awaits SDK
shutdown after Bridge drain. Aggregate owners, observer leases, held work,
cached/reserved history bytes, stream subscribers, queued/retained journal bytes,
active/queued Session replays, uncertain operation count/age, and Node heap/RSS
are observable gauges without scope labels. Cold replay duration and local
intent reuse outcomes are also exported; ACP separately records durable intent
reuse. These metrics contain no Agent, Session or principal labels.
Gateway's W3C trace context becomes the parent of each Node HTTP span;
Controller and ACP calls within the active HTTP request continue that context.
Background work deliberately omits an ended HTTP parent; it does not yet carry
independent span links except for owned ACP cleanup. That cleanup records one
`agent_ui.acp.close` root span, links it to the HTTP span that initialized the
owner when available, and parents the actual DELETE request. Its bounded
`antnest.ui.acp.close.trigger` and `antnest.ui.acp.close.outcome` attributes
distinguish requested or failed initialization/transport closure and
`closed`, `no_target`, or `failed` results. The span contains no connection,
Agent, Session, or principal identifiers and no credentials or remote errors.

An opened Workspace SSE that finishes because the Agent execution-state watch
reports revoked access records one `antnest.stream.termination` event on that
SSE's Node HTTP SERVER span. The event has `reason=access_denied`,
`source=agent-execution-state`, and `antnest.organization.id`,
`antnest.principal.id`, and `antnest.agent.id` from the authenticated scope.
The journal preserves each subscriber's first close reason; cancellation,
capacity retirement, ordinary EOF, and later revocation cannot replace it.
The HTTP adapter records the event only after sending the 200 SSE headers and
observing normal EOF while the original delegation is still valid. It captures
the owning HTTP span before subscribing, so background closure cannot attach
the event to another request or an ended span. A foreign journal scope is not
accepted as evidence. This is a non-error diagnostic: HTTP status, span status,
public SSE frames, and Run lifecycle are unchanged, and the event contains no
credentials, Session content, or exception message.

If React fails before producing its SSR shell, Node sends a safe loading shell
with no serialized bootstrap. The browser mounts with `createRoot` for that
response and fetches a fresh authorized bootstrap; successfully rendered pages
continue to use `hydrateRoot`.

## Navigation and workspace selection

The entry selects an Agent explicitly; Console deep-links to
`/workspace/<agentId>/`. A Session uses
`/workspace/<agentId>/sessions/<sessionId>`. There is no project hierarchy and
ACP always uses `/workspace` as cwd. See the
[navigation contract](../../../contracts/agent-ui/workspace-navigation.md).
A workspace is the selected Agent's conversation context. Switching workspaces
selects that Agent's local draft and scoped history, resets the history search,
and preserves per-Agent drafts through the presentation store. Selecting the
already active workspace leaves the current Session open. An Agent without a
selected Session accepts a local draft and creates a Session on first send.

The browser is an in-memory presentation layer. Global discovery/connection
state and each Session's history, draft and interaction phase are separate.
No business state is written to localStorage, sessionStorage or IndexedDB.
Reload restores Agent/Session selection from the URL and authoritative content
through the Node Bridge, which rebuilds its view from ACP.

## Commands and configuration

The `/` menu combines the Session's server-advertised ACP commands, each preset
and personal Runtime Skill (including in a new conversation before Session
creation), and deterministic Node workspace controls. Typing `/` filters the
catalog; Enter/Tab complete without submission. Selecting a Skill completes an
unsent task draft; sending it uses the normal Prompt path (see the
[Skill command contract](../../../contracts/agent-acp/skill-commands.md) and
[workspace commands](../../../contracts/agent-ui/workspace-commands.md)). Help,
status and navigation controls work before the first Session exists and remain
usable during Agent execution. Configuration and Stop reuse the existing
conditional and targeted operations. The latest command result is transient
feedback outside model history.

Model, thinking effort and mode selection are server-advertised and
provider-grouped. An uncreated draft uses Agent defaults, and Session settings
appear once its authoritative View is available; configuration responses and
notifications remain the only option authority. Tool approval requests support
once/Session decisions, cancellation and reissued requests after reconnect; no
approval is stored as a user message.

## Conversation recovery and cancellation

HTTP `202` confirms Bridge admission; the operation and ACP receipt determine
execution status. ACP owns the authoritative replay: loading a Session builds
a replacement projection while keeping the cached transcript readable. Only a
successful replay replaces that transcript; failed replay retains it.

A complete live user-message delivery schedules a fresh execution/receipt read
before publishing the next SSE projection. The first read after HTTP admission
can precede ACP's commit; this delivery signal lets a held prompt move from
Bridge dispatching to its durable Run status without a browser refresh or model
output. The signal follows batches actually applied in order, including buffered
input released by a checkpoint. Partial or duplicate input and ordinary model
output keep using cached receipts. If an authorization read is already running,
reconciliation joins it before starting a fresh read; it does not cancel that
request or reuse its potentially pre-admission observation. Queued refreshes
continue to share the next authorization workflow.

Both intent receipts and nested execution observations require `errorClass`:
either `null` or a 1–128 character ASCII code matching `^[a-z][a-z0-9_]*$`.
Only `failed`, `cancelled` and `unknown` receipts may carry a non-null code.
Node validates both response paths against the same receipt parser and keeps
the classification in its operation projection. The vocabulary remains open:
an unfamiliar valid code uses the ordinary failed-turn presentation, without
automatic retry or a model capability hint. `intentReceipt: 1` is unchanged.
See the [shared receipt contract](../../../contracts/agent-acp/workspace-bridge.md#receipt-failure-classification)
and [shared validation fixtures](../../../tests/support/fixtures/agent-acp/bridge-receipts.json).

Selected-Session cold replay negotiates `antnest.dev/errors: {version: 1}`
per ACP connection. It retries only a catalog-validated admission error with
`retryable: true`, recovery `backoff`, and a valid wire `retry_after_ms`, up to
four total attempts. Each wait is at least the wire delay. Unknown errors,
unsupported capabilities, permanent denials, and wait/rebuild/reconnect
directives return an error immediately. One server-owned work lease spans
the attempts and keeps concurrent readers on the same recovery workflow.
Retiring the owner aborts backoff, closes the transport, and waits for its
authorization workflows to settle. Exhausted recovery preserves an earlier
sealed transcript. This Load policy does not resubmit Prompt or intent work.

Prompt failures use the same negotiated error catalog for safe messages, while
the operation keeps its original intent ID and remains `uncertain` until a
durable receipt is available. Even a busy or denied response cannot prove that
an intent was never accepted. The Bridge attaches only the classified public
code and message, a stable local error correlation ID, and `query_operation`
guidance with `retryable: false`; it never automatically resubmits Prompt.
Original causes stay private. A known durable receipt takes precedence over a
late error or an unknown observation, and a later receipt clears the local
error. The browser validates the existing error envelope, shows the message
and original-operation query hint only in its owning Session, and removes that
hint when the durable operation replaces the uncertain state.

Once the local submission finishes, Refresh workspace and both New conversation
controls remain available while an operation is uncertain. Refresh only rereads
state; opening a new conversation selects a local draft without creating a
Session or resubmitting the original intent. Returning to the original Session
preserves its draft and operation. These controls stay disabled while the local
submission or an explicit original-Prompt retry is in flight, and ordinary
sending in the uncertain Session remains blocked until its operation settles.

Prompt admission checks the full serialized ACP request against the ACP POST
body limit before returning `202`. The default is 16 MiB; Compose passes
`ANTNEST_ACP_MAX_PROMPT_BYTES` to ACP and the same value to Node as
`ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES`. An oversized Prompt returns
`413 request_too_large` without reserving an operation.

An uncached selected Session shows a non-interactive history placeholder until
replay completes. The mounted, disabled composer preserves its draft; cached
transcripts remain readable during refresh. An opening failure replaces the
placeholder with Retry loading and Back to agent actions.

Stop remains bound to the outstanding prompt or the authenticated snapshot's
active Session even when another conversation is selected. Completion obtains
a fresh state subscription; Refresh workspace reloads access and reconnects
without resending a prompt. Ordinary workspace HTTP requests have a 60-second
total handler/body deadline; expiration returns
`504 workspace_deadline_exceeded`. Prompt/cancel ambiguity uses
`query_operation`, never automatic resubmission. SSE and accepted Run work have
independent lifetimes. The authenticated SSR shell keeps its separate 150 ms
bootstrap budget. See [Workspace state](workspace-state.md).

## History and process presentation

Completed turns build folded process messages only when opened. Running turns
open their process automatically and follow its versioned pages until folded by
the reader. A complete live process uses a one-revision View/SSE item delta for
consecutive updates; a missed delta or released cache falls back to versioned
pages. A process already read stays mounted while expanded and for five minutes
after folding, then releases its DOM while keeping the prompt, final answer and
process summary. This does not discard ACP history or reduce its transport
payload. Intermediate Agent replies stay in process order before the final
answer, even when a later process page arrives while an earlier thought is
expanded.

The Node history API returns both `nextCursor` (older) and `newerCursor`
(newer) for each turn page. Each cursor is signed for one identity, Session
incarnation, and output watermark. The browser keeps the latest View plus one
history page, evicts the previous page on navigation, and can fetch adjacent
older or newer pages or jump back to the latest View.

History size does not reject a Session or disable Prompt submission. The Bridge
retains complete ACP content and serves large content through exact, signed
continuations. Expanded content follows all advancing signed pages, including
single blocks above 64 MiB; each response stays bounded, and cancellation and
repeated-cursor checks still apply. Tool patches replace supplied fields,
omitted fields retain their current values, and each Run has one current plan.
Collapsed projections avoid copying hidden large text and formatting unrelated
tool results, and browser fragments are assembled once at completion. Identical
metadata and replacement tool results do not accumulate wire-traffic bytes.

## SSE deltas

Normal SSE publications are atomic Agent View deltas. A browser applies them to
its HTTP snapshot using `fromCursor`, stream revision, Session incarnation and
Session revision fences. Gaps, replacement incarnations, oversized deltas and
slow observers recover through reset snapshots. Unchanged Views publish nothing;
local output and metadata updates do not trigger ACP observation GETs.

## Bridge capacity and lifetimes

- Prompt reception and HTTP dispatch reserve at most 128 MiB / 16 requests
  per process, with 64 MiB / 4 requests per signed `(organization, user)` across
  Agents and login sessions. Unknown-length bodies reserve the full 64 MiB
  maximum. Admission happens before body consumption; exhaustion returns
  `429 upload_capacity_exceeded` with `Retry-After: 1` and no business dispatch.
  Cancellation and other control requests bypass this pool, with a 16 KiB
  native body ceiling and any smaller route bound still enforced. Reservations
  last until dispatch settles, including body failures and disconnect/deadline
  cleanup; accepted ACP work has its separate owner lifetime. These wire-byte
  budgets are not a process RSS bound.
- The native HTTP boundary validates UTF-8 and decoded duplicate JSON members
  once. A private Request-bound record carries that result and its actual byte
  count to route validation; clones and direct handler requests still parse
  strictly. Payload strings use native boundary scanning, and routes retain
  their Zod validation, byte limits and same-intent content digest comparison.
  Body copying and strict parsing at or above 1 MiB use a process-local FIFO.
  Prompt preparation uses the same FIFO, capturing a detached input and reusing
  one canonical serialization for wire sizing and the existing content digest.
  Hashing and byte counting yield between chunks so ready control I/O can proceed
  during preparation. A private token binds the prepared input to its owner;
  the final cancellation check, current idempotency/capacity checks and intent
  insertion remain synchronous. Each job keeps its caller's async context and
  releases the queue only after its asynchronous work finishes. Small control paths
  bypass the queue; queue failures do not block later requests, and dispatch
  still owns upload reservations and Session leases until its work settles.
  `/stop` repeats live authorization and validates the exact durable target
  without waiting for view projection, Skill discovery or history loading.
  Canonical copying, native JSON serialization and strict parsing retain
  synchronous sections. The fixed cancellation workloads below retain their
  one-second gate; this does not establish a general end-to-end latency bound.
- With telemetry enabled, each original HTTP SERVER span has
  `antnest.ui.http.started_monotonic_ns`, a decimal string from the current
  process's monotonic clock sampled before request handling. Calibrate it with
  the independent client's complete request interval and the original Trace
  and process identity; never compare clocks from different processes directly.
  An admitted native Prompt records at most four `antnest.ui.prompt_input`
  events with only `phase`, `bytes` and decimal-string `monotonic_ns`.
  `receive-started` follows the first nonempty chunk actually read;
  `body-eof` follows real EOF and the abort check; `body-parsed` follows
  successful strict parsing. `input-prepared` follows Antnest's envelope sizing
  serialization, canonical digest and atomic intent submission. This last
  receipt describes the service's synchronous work, not later SDK internals
  or the upstream response wait. Failed requests retain only their actual phase
  prefix. Control, unadmitted and disabled requests emit no input phase events;
  ended HTTP boundaries cannot acquire late events.
  For the completion/parse workload, the entire calibrated cancellation-send
  interval must fall between that upload's EOF and parsed receipts. This
  conservative parsing interval excludes all later preparation and response wait.
- Each owner admits at most 16 live Agent SSE observers across selected
  Sessions, keeps at most 32 Agent and 32 Session journals, and retains up to
  256 KiB of replay suffix per journal. A slow observer has a 1 MiB
  pending-byte limit. Cold journals may be retired at capacity; when every
  journal is subscribed, new demand receives `429 stream_capacity_exceeded`. An
  expired cursor receives a fresh reset snapshot.
- Replay concurrency is one active load plus eight queued loads per owner;
  queue overflow returns `429 replay_capacity_exceeded`.
- `ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS` (default 16) limits scope cardinality.
  When full, the Bridge retires an idle owner before admitting a new scope; if
  every owner has an observer or retained work, new scopes receive
  `429 bridge_capacity_exceeded`. Existing owners continue serving their work.
- `ANTNEST_AGENT_UI_BRIDGE_IDLE_MS` (default 300000, may be zero) and
  `ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS` (default 30000, positive) control
  eviction. Each materialized Session has its own idle clock. Observation,
  replay, configuration, permissions and running work hold it; another
  Session's activity does not. A recovered ACP Run retains owner work until a
  terminal observation. After all holds end, the Session gets a full idle grace
  period before eviction. A later materialization receives a new incarnation,
  fencing old tokens and continuations. Closing an owner fences late callbacks
  and leaves durable ACP execution independent.

`antnest.ui.bridge.cached_history_bytes` estimates currently retained logical
content, metadata and Session overhead; it is not a Node heap limit.

## Testing

Service unit and component tests live under `web/src` and `web/server/test`.
HTTP/SSE, SSR and Gateway contracts live under root `tests/integration/agent-ui/`;
deployed browser and container checks live under root `tests/e2e/agent-ui/`.
There is no browser ACP or Nginx compatibility mode.

- The HTTP integration test sustains throttled SSE output for at least one
  minute; the extended soak runs three minutes with three slow observers, then
  one minute across two identities and Sessions. Each publish checks the
  pending queue and retained suffix limits. The fixture renews bounded CCT
  leases between load waves, checks real overflow in every lease, and requires
  every old subscription to release before attaching its replacement.
- The account browser tests use built assets and Gateway response fixtures for
  desktop/mobile controls, session replacement, genuine input and quiet idle
  expiry. The receipt Docker test adds a real held Run observed for 95 seconds:
  the browser renews its original SSE delegation and receives the terminal
  state without another Prompt, model request or test-side Workspace read.
- The external-identity browser helper runs the same desktop/mobile journeys
  against local production assets and the owning Docker container. Only Gateway
  browser-session APIs are doubled; authenticated SSR, assets and Workspace
  bootstrap use the actual Node service. The Docker helper uses the harness's
  existing signing authority and runs after capacity checks, before normal
  shutdown. Contexts and Chromium close in `finally`, including interruption.
  Real Identity grants, persistent transactions and two-browser HTTPS behavior
  remain a separate integration gate.
- `test:bridge:memory` samples V8 allocation and post-GC retained heap for small
  updates beside a large unchanged tool body; its RSS values are diagnostic,
  not a container memory limit. `test:bridge:runtime-memory` samples the
  Runtime HTTP View and SSE handler path with four observers; it does not
  include Node sockets or Docker RSS.
- `test:bridge:capacity` runs the real authenticated Node HTTP boundary,
  WorkspaceRuntime, operation coordinator and official ACP HTTP client in a
  separate process from the client and the ACP execution double. Two signed
  user/Agent scopes exercise operation cancellation and `/stop` during one and
  four concurrent uploads. Every upload contains four valid text attachments
  filling more than 99% of the default 16 MiB ACP envelope; all four uploads
  remain admitted within the principal budget.
  Native incoming EOF, handler entry and SDK request dispatch receipts distinguish
  unfinished uploads from strict parsing, and bracketed monotonic clock samples
  prove actual overlap. Each case requires the same held operation's cancelled
  receipt and double-work release within one second. This component test is part
  of `test:bridge:integration`; real Runtime termination remains a Docker gate.
  The same integration command verifies the container gate's listener startup,
  child-process exit, SSE cancellation and complete cleanup using real local
  sockets/processes plus explicit Docker inventory failures.
- `test:bridge:docker` uses the production image with an official ACP HTTP
  fixture for slow-observer reset, multi-owner history, 17 MiB content paging,
  and four-observer small updates beside a 1 MiB tool body with a
  container-memory sample. `test:bridge:docker:soak` runs 180 paced SSE observer
  attach/detach cycles with six peak/post-GC container-memory samples.
- `tests/e2e/agent-ui/fullstack-current.test.mjs` runs an isolated six-service
  Docker/Chromium stack (Gateway, Identity, Node Bridge, ACP, Controller,
  Runtime). It covers accepted Runs across page close, Bridge and Gateway
  restart, pending permissions, targeted Stop, ambiguous responses, identity
  expiry/revocation, independent browser sessions, and Gateway SSE clients
  reading at 1 KiB per 50 ms through 80 real Runs with a fixed Bridge memory
  budget after disconnect. `fullstack-history.test.mjs` verifies complete large
  answers and continued submission through the same stack.
- The [permission profile](../../../tests/e2e/acp-permissions/README.md) covers
  allow once, reject once, Chat mode, completion unlocking, default collapsed
  Tool details and mobile wrapping through the deployed browser.

Screen-reader/keyboard review and capacity beyond these fixed loads are not
covered by automated tests.

## Service authentication rollout

The [platform authentication contract](../../../contracts/platform/service-authentication.md)
and this service's [caller catalog](../../../contracts/agent-ui/callers.json) are
enforced before business handling. Native HTTP checks actual raw header fields,
accepts only Gateway workload identity, and verifies CCT using protected Identity
JWKS. HTML/bootstrap are Organization-scoped discovery; Agent API paths require
matching signed `agt`. Assets require workload identity only. Health exceptions
never construct an owner. Strict JSON media/UTF-8/member checks precede business
dispatch and share the ordinary HTTP deadline.

Verified delegation lives in private request/scope maps. SSR explicitly carries
it into bootstrap. Owner reuse accepts context from newer ordinary authenticated
requests in the same user/Organization/Agent scope; SDK HTTP and observation calls
use that context unchanged with UI's own workload credentials. Invalid or expired
context cannot initiate a new upstream request; accepted model work and existing
notification delivery retain their independent lifetime. Each Node Workspace
SSE subscription ends at the original verified CCT expiry, including quiet,
backpressured and still-opening subscriptions. This ends only the HTTP observer.
The browser reconnects through a fresh authorized View and SSE request, retaining
its draft and accepted operation without resubmission. Gateway independently
enforces the browser session's 30-second stale bound and absolute deadline.
When no browser remains, no synthetic activity or credential renewal is created;
later authorized requests refresh the owner context. If the last execution
observation was active, expired delegation can prevent terminal reconciliation
and keep the local owner retained until a fresh authorized request or retirement.
Bounding that headless retention is pending lifecycle work. No credential is
encoded in a browser cursor or View.

Dependency origins are distinct and pinned, native TLS verifies DNS/chain and
service URI, and outgoing tokens are validated before listen and reread each
request. The container health probe uses the configured transport and port. See
[Agent UI authentication](../../../contracts/agent-ui/service-authentication.md).
Controller/deployment consumers and final cross-service Docker security and
business acceptance remain their owning batches in the
[rollout ledger](../../../contracts/platform/service-authentication-rollout.json).
