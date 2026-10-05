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
   browser hydrates that exact shell and starts observing the selected Agent.
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
CCT claims and the two display headers from Gateway revision 15. Signed claims
determine Organization/Principal IDs and administrator status; raw identity and
administrator hints grant nothing. Each label must be canonical unpadded Base64URL over
valid UTF-8 and decode to a non-whitespace string. Invalid or missing metadata
returns `401` before discovery or rendering. The real bootstrap principal uses
the central `verifiedWorkspacePrincipal` schema, including `organizationSlug`
and `organizationName`. Both browser bootstrap decoders preserve those fields;
the chooser and account footer render the name as escaped text. SSR serializes
the same response for hydration; there is no successful placeholder fallback.

Labels are excluded from owner keys, Agent/Session admission and identity-change
comparisons. Node does not cache Organization metadata. Each new Gateway-authenticated
bootstrap/reload observes the current Identity row; a display-only rename
updates presentation while retaining a same-identity Agent/Session selection.
See the [projection contract](../../../contracts/agent-ui/organization-projection.md)
for the #92 producer → #93 consumer → explicit integration order.

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

The browser never receives the ACP access subject, provider credentials,
internal service addresses or Runtime endpoints. Gateway owns browser identity
and CSRF; Node scopes its owners and private caches to that identity. Access
loss clears the browser's private view and redirects through the Gateway login
entry with the selected route preserved. If an authorized bootstrap replaces
the principal without a redirect, the browser also clears in-memory drafts and
unsent attachments before the new identity can select the same Agent ID.

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
unready while `/live` remains available; then it closes observers and flushes
telemetry without cancelling ACP Runs. Single-replica deployment is the current model. Multi-replica
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
independent span links.

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

Both intent receipts and nested execution observations require `errorClass`:
either `null` or a 1–128 character ASCII code matching `^[a-z][a-z0-9_]*$`.
Only `failed`, `cancelled` and `unknown` receipts may carry a non-null code.
Node validates both response paths against the same receipt parser and keeps
the classification in its operation projection. The vocabulary remains open:
an unfamiliar valid code uses the ordinary failed-turn presentation, without
automatic retry or a model capability hint. `intentReceipt: 1` is unchanged.
See the [shared receipt contract](../../../contracts/agent-acp/workspace-bridge.md#receipt-failure-classification)
and [shared validation fixtures](../../../tests/support/fixtures/agent-acp/bridge-receipts.json).

Selected-Session cold replay retries transient ACP failures up to four total
attempts under one server-owned work lease. The lease spans each backoff and
keeps concurrent readers on the same recovery workflow; permanent missing or
revoked Session errors stop immediately. Exhausted recovery returns an error
without replacing an earlier sealed transcript.

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
  pending queue and retained suffix limits.
- `test:bridge:memory` samples V8 allocation and post-GC retained heap for small
  updates beside a large unchanged tool body; its RSS values are diagnostic,
  not a container memory limit. `test:bridge:runtime-memory` samples the
  Runtime HTTP View and SSE handler path with four observers; it does not
  include Node sockets or Docker RSS.
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
notification delivery retain their independent lifetime. #58 owns future
long-lived renewal. No credential is encoded in a browser cursor or View.

Dependency origins are distinct and pinned, native TLS verifies DNS/chain and
service URI, and outgoing tokens are validated before listen and reread each
request. The container health probe uses the configured transport and port. See
[Agent UI authentication](../../../contracts/agent-ui/service-authentication.md).
Controller/deployment consumers and final cross-service Docker security and
business acceptance remain their owning batches in the
[rollout ledger](../../../contracts/platform/service-authentication-rollout.json).
