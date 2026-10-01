# Agent UI

The `/` menu includes each preset and personal Runtime Skill, including in a new
conversation before Session creation. Selecting a Skill completes an unsent task
draft; sending it uses the normal Prompt path. See the
[Skill command contract](../../contracts/agent-acp/skill-commands.md).

Agent UI is Antnest Platform's end-user conversation workspace. It presents
Agents, Sessions, messages, tool activity, and attachments without owning Agent
execution or exposing internal service credentials to the browser.

## Status

The [2026-09-26 dependency refresh](../../docs/dependency-refresh-20260926.md)
upgrades the official ACP SDK to 1.5.0, React to 19.3.0, Vite to 8.3.1,
Vitest to 5.0.2 and Playwright to 1.63.0. Production uses Node 24.21.0 LTS.
The user has authorized full regression, including the outstanding control and
layout browser checks; the new dependency candidate is undergoing those gates.

Human acceptance on 2026-09-26 identified three UX changes. An Agent without a
selected Session now accepts a local draft and creates a Session on first send;
the sidebar starts with the current Agent's workspace, followed by its new
conversation action, search and history, plus a collapsible desktop rail.
Workspace selection uses a floating picker and also works from the rail;
running Tool/process content keeps its spacing and
remains expanded while its Turn is active. The
[remediation record](docs/human-acceptance-remediation-20260926.md) tracks
verification and the remaining human review.

The subsequent [control-command preparation](../../docs/stage4-command-preparation-20260926.md)
adds 11 deterministic Node controls alongside the Session's ACP commands.
Typing `/` filters the server-advertised catalogue; Enter/Tab complete without
submission. Help, status and navigation work before the first Session exists;
controls remain usable during Agent execution. Configuration and Stop reuse
existing conditional/targeted operations. The latest command result is transient
feedback outside model history. Backend service/HTTP gates and backend-only
Docker acceptance pass, including all 11 controls through real Gateway, ACP and
Runtime services. Browser UI regression is included in the authorized full run.

The [full-stack Bridge refactor](docs/fullstack-bridge-refactor.md) uses one
TypeScript/Node service for the ACP Bridge, business HTTP/SSE and streaming
React SSR. The browser holds presentation state and never opens an ACP socket.
The standard Dockerfile and development command use this same Node path; Edge
Gateway authenticates HTML and business requests before forwarding them. The
official ACP SDK uses its HTTP transport; the previous refactor evidence below
used 1.4.0 and the dependency refresh validates 1.5.0 separately.

For the earlier refactor candidate, service tests, HTTP/SSE contracts, Chromium browser/SSR integration and the
isolated Gateway/Identity/Node/ACP/Controller/Runtime Docker regression pass.
The real stack covers accepted Runs across page close, Bridge and Gateway
restart, pending permissions, targeted Stop, ambiguous responses, identity
expiry/revocation and independent browser sessions. A fixed 80-Run load and
bounded slow SSE observers pass the measured memory and first-screen gates;
local extended tests also cover sustained throttled streams across identities.
The plan records the exact evidence and remaining acceptance work: complete
screen-reader/keyboard review and capacity behavior beyond these fixed loads.

Session-first workspace behind Edge Gateway at `/workspace/`. The entry selects
an Agent explicitly; Console deep-links to `/workspace/<agentId>/`. A Session
uses `/workspace/<agentId>/sessions/<sessionId>`. There is no project hierarchy
and ACP always uses `/workspace` as cwd. See the
[navigation contract](../../contracts/agent-ui/workspace-navigation.md).
In navigation, a workspace is the selected Agent's conversation context. Switching
workspaces selects that Agent's local draft and scoped history, resets the history
search, and preserves per-Agent drafts through the existing presentation store.
Selecting the already active workspace leaves the current Session open.

The browser is an in-memory presentation layer. Global discovery/connection
state and each Session's history, draft and interaction phase are separate.
No business state is written to localStorage, sessionStorage or IndexedDB.
Reload restores Agent/Session selection from the URL and authoritative content
through the Node Bridge, which rebuilds its view from ACP.

Skill learning results use SDK notices and bounded recovery through Agent
View/SSE. Only applied changes produce a toast and result count; source links
use the existing conversation route. Background deferral diagnostics are read
on demand when learning results open, via `GET /agents/A/view?learningStatus=1`.
Ordinary Views, stream refreshes and runtime sweeps do not poll this status.
Unknown reads remain unavailable rather than reporting successful learning.
Unavailability describes a prior unfinished review; diagnostics do not promise
to replay an unknown model request. New completed tasks can still be reviewed
when the service recovers, subject to existing idle, cooldown and budget limits.
The result-panel presentation passes 144 frontend component tests and both
real-stack browser gates. Backend gates pass 253 Node tests,
13 HTTP-client tests, the SDK HTTP component test and type checking.
The root opt-in gates `make e2e-skill-learning-browser` and
`make e2e-skill-learning-diagnostics-browser` pass real Docker-stack Playwright
acceptance for create/update/read, source navigation, notices, on-demand diagnostics,
model recovery and reload/mobile restoration. The existing five browser
integration tests, production client/SSR build and type checking also pass.
Development keeps the existing style; visual refinements follow during human acceptance.

## Owns

- page-local navigation, selection, composer, attachment, and disclosure state;
- end-user presentation of ACP messages, attachments, and tool activity;
- Session-scoped ACP command discovery, completion and argument hints;
- workspace control-command discovery and deterministic dispatch through
  existing ACP lifecycle, observation, configuration and cancellation interfaces;
- server-advertised provider-grouped model, thinking effort and mode selection;
  an uncreated draft uses Agent defaults, and Session settings appear once its
  authoritative View is available; configuration responses/notifications remain
  the only option authority;
- current context usage and cumulative known Session cost from authorized Bridge views;
- exact Tool approval requests, once/Session decisions, cancellation and reissued
  requests after reconnect; no approval is stored as a user message;
- connection, unavailable, cancellation, and retry feedback in the browser;
- leased, authenticated Agent-state observation and read-only reconnection;
- account exit, administrator application switching, and usable no-Agent states;
- the `Antnest / Workspace` implementation of the shared design language.

## Does Not Own

- users, browser sessions, Agent access policy, or credentials;
- Agent configuration authority, Run admission, Runtime endpoints, or MCP dispatch;
- ACP Session or message persistence;
- any PostgreSQL schema or direct internal-service connection.

## Production Boundary

The browser talks only to Edge Gateway on the same origin. Edge Gateway must:

1. resolve the browser session through Identity Service;
2. send authenticated HTML and Workspace HTTP/SSE to the Node `agent-ui`
   service with verified organization/principal identity;
3. leave ACP admission, execution, and persistence to ACP Service while Node
   holds the official SDK connection independently of browser tabs;
4. never return credentials or an internal Runtime endpoint to JavaScript.

The browser contract is
[`../../contracts/agent-ui/workspace-api.md`](../../contracts/agent-ui/workspace-api.md).
Gateway's active route and trusted-header inventory is
[`../../contracts/edge-gateway/session-contract.json`](../../contracts/edge-gateway/session-contract.json)
version 13.
The official ACP TypeScript SDK runs in Node behind the Bridge adapter; browser
code consumes only business HTTP responses and SSE projections.

HTTP `202` confirms Bridge admission; the operation and ACP receipt determine
execution status. ACP owns the authoritative replay: loading a Session builds
a replacement projection while keeping the cached transcript readable. Only a
successful replay replaces that transcript; failed replay retains it.
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
placeholder with Retry loading and Back to agent actions. Completed turns build folded process
messages only when opened. Running turns open their process automatically and
follow its versioned pages until folded by the reader. A complete live process
uses a one-revision View/SSE item delta for consecutive updates; a missed delta or released
cache falls back to versioned pages. A process already read
stays mounted while expanded
and for five minutes after folding, then releases its DOM while keeping the
prompt, final answer and process summary. This does not discard ACP history or
reduce its transport payload. See the [attyd optimization review](docs/attyd-optimization-review-20260923.md).
Intermediate Agent replies stay in process order before the final answer, even
when a later process page arrives while an earlier thought is expanded.
The Node history API now returns both `nextCursor` (older) and `newerCursor`
(newer) for each turn page. Each cursor is signed for one identity, Session
incarnation, and output watermark. The browser keeps the latest View plus one
history page, evicts the previous page on navigation, and can fetch adjacent
older or newer pages or jump back to the latest View. The real-stack browser
E2E covers both directions.
History size does not reject a Session or disable Prompt submission. The Bridge
retains complete ACP content and serves large content through exact, signed
continuations. Tool patches replace supplied fields, omitted fields retain their
current values, and each Run has one current plan. Collapsed turn pages do not
format unrelated tool results.
Normal SSE publications are atomic Agent View deltas. A browser applies them to
its HTTP snapshot using `fromCursor`, stream revision, Session incarnation and
Session revision fences. Gaps, replacement incarnations, oversized deltas and
slow observers recover through reset snapshots. Unchanged Views publish nothing;
local output and metadata updates do not trigger ACP observation GETs.
Each owner admits at most 16 live Agent SSE observers across selected Sessions,
keeps at most 32 Agent and 32 Session journals, and retains up to 256 KiB of
replay suffix per journal. A slow observer has a 1 MiB pending-byte limit.
Cold journals may be retired at capacity; when every journal is subscribed,
new demand receives `429 stream_capacity_exceeded`. An expired cursor receives
a fresh reset snapshot. These limits keep inactive tabs and old cursors from
growing Bridge memory without bound.
The HTTP integration gate sustains throttled SSE output for at least one minute;
the extended gate runs three minutes with three slow observers, then one minute
across two identities and Sessions. Each publish checks the pending queue and
retained suffix limits. A six-service Docker/Chromium run also keeps Gateway
SSE clients reading at 1 KiB per 50 ms through 80 real Runs and checks the
fixed Bridge memory budget after disconnect.
Stop remains bound to the outstanding prompt or the authenticated snapshot's
active Session even when another conversation is selected. Completion obtains
a fresh state subscription; Refresh workspace reloads access and reconnects
without resending a prompt. See [Workspace state](docs/workspace-state.md) and the
[recovery contract](docs/architecture.md#conversation-recovery-and-cancellation)
for the service boundaries. Earlier cross-connection Docker evidence is tracked
in [C4 closeout](../../docs/docker-single-node-closeout.md). Wire-fixture browser
checks and later real-stack model-selection/fallback checks have distinct scopes;
their recorded results are in [current status](../../docs/current-status.md).
Native WAV/MP3, PDF and UTF-8 documents follow the negotiated ACP input contract;
images and audio have bounded inline history presentation. See
[multimodal input](docs/multimodal-input.md) for file limits, lifecycle and
service-versus-deployment verification boundaries.
See [Session usage](docs/session-usage.md) for unknown-versus-zero cost, replay,
freshness and Agent/session isolation. The UI does not calculate a bill or use
model prices; it replaces the server's cumulative snapshot.

## Local Development

```sh
cd services/agent-ui/web
npm ci
ANTNEST_AGENT_ACP_SERVICE_URL=http://127.0.0.1:8081 \
ANTNEST_AGENT_CONTROLLER_URL=http://127.0.0.1:8082 \
npm run dev
```

`npm run dev` builds and starts the same Node Bridge used by the container;
it serves SSR, assets, workspace HTTP APIs and SSE on port 8080. Set the ACP
and Controller URLs to the actual local service ports. Open the workspace
through Edge Gateway so the Bridge receives verified identity headers; a
direct unauthenticated `/workspace/` request returns 401. After source changes,
restart the command to rebuild and reload the service.

The listener defaults to `0.0.0.0:8080`; `ANTNEST_AGENT_UI_BRIDGE_HOST` and
`ANTNEST_AGENT_UI_BRIDGE_PORT` override it. `/status` is readiness: it returns
503 while the Bridge drains. `/live` remains 200 until the listener closes;
neither probe opens an ACP owner. Gateway serves this Node implementation.
Set `OTEL_SDK_DISABLED=false` and `OTEL_EXPORTER_OTLP_ENDPOINT` to export
HTTP request spans plus `antnest.ui.http.requests` and
`antnest.ui.http.duration` metrics over OTLP/HTTP. `OTEL_SERVICE_NAME`
defaults to `agent-ui`. Route labels use fixed patterns and omit Agent,
Session and principal identifiers. Normal shutdown waits for telemetry export
after Bridge drain; exporters have a 5-second timeout.
The same exporter reports aggregate owner count, observer leases, held work,
retained logical history bytes, stream subscribers, queued and retained
journal bytes, active and queued Session replays, and Node heap/RSS without
identity labels.
The HTTP server continues a valid W3C `traceparent`/`tracestate` supplied by
Gateway. Controller and ACP requests made while that HTTP span is active
continue it; later background calls omit the ended parent context.
Gateway must inject the verified `X-Antnest-Administrator` identity flag on
the private Bridge proxy; Node rejects Bootstrap requests without it.
For a standalone deployment, set `ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES` to
ACP's `ANTNEST_ACP_MAX_PROMPT_BYTES`; both default to 16777216 bytes and
accept values from 1024 through 67108864 bytes. Compose sets them together.

Cumulative Session, owner and global history byte quotas have been removed.
`antnest.ui.bridge.cached_history_bytes` estimates currently retained logical
content, metadata and Session overhead; it is not a Node heap limit. Identical
metadata and replacement tool results do not accumulate wire-traffic bytes.
Expanded content follows all advancing signed pages, including single blocks
above 64 MiB. Each response stays bounded; cancellation and repeated-cursor
checks still apply. Collapsed projections avoid copying hidden large text and
formatting tool results, and browser fragments are assembled once at completion.
Replay concurrency remains one active load plus eight queued loads per owner;
queue overflow returns `429 replay_capacity_exceeded`.
`ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS` defaults to 16. When full, the Bridge
retires an idle owner before admitting a new scope; if every owner has an
observer or retained work, new scopes receive `bridge_capacity_exceeded` (429).
Existing owners continue serving their work. The owner count separately limits
scope cardinality.
`ANTNEST_AGENT_UI_BRIDGE_IDLE_MS` defaults to 300000 (5 minutes) and
`ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS` to 30000. Both accept integer
milliseconds; the idle lifetime may be zero, while the sweep interval must be
positive. Each materialized Session has its own idle clock. Observation, replay,
configuration, permissions and running work hold it; another Session's activity
does not. A recovered ACP Run retains owner work until a terminal observation.
After all holds end, the Session gets a full idle grace period before eviction.
A later materialization receives a new incarnation, fencing old tokens and
continuations. Closing an owner fences late callbacks and leaves durable ACP
execution independent.

Ordinary workspace HTTP requests have a 60-second total handler/body deadline;
expiration returns `504 workspace_deadline_exceeded`. Prompt/cancel ambiguity
uses `query_operation`, never automatic resubmission. SSE and accepted Run work
have independent lifetimes. The authenticated SSR shell keeps its separate
150 ms bootstrap budget.

The [alignment batch ledger](docs/attyd-alignment-fixes.md) records the implementation
and verified local integration evidence against the pinned attyd revision.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:bridge:integration
npm run test:bridge:memory
npm run test:bridge:runtime-memory
npm run test:browser
npm run test:bridge:soak
```

The extended soak takes about four minutes. `test:bridge:memory` samples V8
allocation and post-GC retained heap for small updates beside a large unchanged
tool body; its RSS values are diagnostic, not a container memory limit.
`test:bridge:runtime-memory` samples the Runtime HTTP View and SSE handler
path with four observers; it does not include Node sockets or Docker RSS.
From the repository root, run
`node --test tests/e2e/agent-ui/fullstack-current.test.mjs` for the isolated
six-service Docker/Chromium regression; it builds temporary images and cleans
up its Compose project after completion.
`node --test tests/e2e/agent-ui/fullstack-history.test.mjs` verifies complete
large answers and continued submission through the same real stack.
`npm run test:bridge:docker` uses the production image with an official ACP
HTTP fixture for slow-observer reset, multi-owner history, 17 MiB content
paging, and four-observer small updates beside a 1 MiB tool body with a
container-memory sample. The optional `npm run test:bridge:docker:soak` runs
the same production-image gate with 180 paced SSE observer attach/detach cycles
and six peak/post-GC container-memory samples; allow about seven minutes.

See [architecture](docs/architecture.md) and the platform
[design language](../../docs/design-language.md).
The service's [UI design rules](docs/ui-design.md) define shared controls,
disclosures, responsive navigation, accessibility, and visual regression checks.

`test:browser` runs the root-level
[Bridge browser suite](../../tests/integration/agent-ui/workspace-bridge-browser.test.mjs)
and [SSR browser suite](../../tests/integration/agent-ui/workspace-ssr-browser.test.mjs)
with Chromium and deterministic HTTP/SSE fixtures. Unit and component tests
remain in `web/src/`. The [deployed browser E2E](../../tests/e2e/agent-ui/fullstack-current.test.mjs)
checks the real Gateway, Identity, Node Bridge, ACP, Controller and Runtime path.

F06 uses the [deployed permission profile](../../tests/e2e/acp-permissions/README.md).
Pure tests cover approval inbox cleanup, stale replies, configuration response
ordering and disabled submission during configuration. The deployed browser profile
covers allow once, reject once, Chat mode, completion unlocking, default
collapsed Tool details and mobile wrapping; it supplements, not replaces, tests.
