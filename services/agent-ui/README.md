# Agent UI

Agent UI is Antnest Platform's end-user conversation workspace. It presents
Agents, Sessions, messages, tool activity, and attachments without owning Agent
execution or exposing internal service credentials to the browser.

## Status

The [full-stack Bridge refactor](docs/fullstack-bridge-refactor.md) uses one
TypeScript/Node service for the ACP Bridge, business HTTP/SSE and streaming
React SSR. The browser holds presentation state and never opens an ACP socket.
The standard Dockerfile and development command use this same Node path; Edge
Gateway authenticates HTML and business requests before forwarding them. The
official ACP SDK is pinned to the tested 1.4.0 HTTP transport.

Service tests, HTTP/SSE contracts, Chromium browser/SSR integration and the
isolated Gateway/Identity/Node/ACP/Controller/Runtime Docker regression pass.
The real stack covers accepted Runs across page close, Bridge and Gateway
restart, pending permissions, targeted Stop, ambiguous responses, identity
expiry/revocation and independent browser sessions. A fixed 80-Run load and
bounded slow SSE observers pass the measured memory and first-screen gates;
local extended tests also cover sustained throttled streams across identities.
The plan records the exact evidence and remaining acceptance work: complete
screen-reader/keyboard review and capacity behavior beyond these fixed loads.

Session-first workspace behind Edge Gateway at `/workspace/`. The entry selects
an Agent explicitly; Console may deep-link to `/workspace/?agent=<id>`. A Session
is selected with `&session=<id>`. There is no project hierarchy and ACP always
uses `/workspace` as cwd. See the [refactor contract](docs/session-workspace-refactor.md).

The browser is an in-memory presentation layer. Global discovery/connection
state and each Session's history, draft and interaction phase are separate.
No business state is written to localStorage, sessionStorage or IndexedDB.
Reload restores Agent/Session selection from the URL and authoritative content
through the Node Bridge, which rebuilds its view from ACP.

## Owns

- page-local navigation, selection, composer, attachment, and disclosure state;
- end-user presentation of ACP messages, attachments, and tool activity;
- server-advertised provider-grouped model, thinking effort and mode selection;
  settings appear automatically before the first message without an activation button;
  configuration responses/notifications remain the only option authority;
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
Prompt admission checks the full serialized ACP request against the ACP POST
body limit before returning `202`. The default is 16 MiB; Compose passes
`ANTNEST_ACP_MAX_PROMPT_BYTES` to ACP and the same value to Node as
`ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES`. An oversized Prompt returns
`413 request_too_large` without reserving an operation.
An uncached selected Session shows a non-interactive history placeholder until
replay completes. The mounted, disabled composer preserves its draft; cached
transcripts remain readable during refresh. Completed turns build folded process
messages only when opened. A process already read stays mounted while expanded
and for five minutes after folding, then releases its DOM while keeping the
prompt, final answer and process summary. This does not discard ACP history or
reduce its transport payload. See the [attyd optimization review](docs/attyd-optimization-review-20260923.md).
The Node history API now returns both `nextCursor` (older) and `newerCursor`
(newer) for each turn page. Each cursor is signed for one identity, Session
incarnation, and output watermark. The browser keeps the latest View plus one
history page, evicts the previous page on navigation, and can fetch adjacent
older or newer pages or jump back to the latest View. The real-stack browser
E2E covers both directions.
After a sealed replay, live output that exceeds the Session or shared Bridge
history budget changes the Node projection to `view_limited`: it continues
receiving delivery watermarks, publishes a bounded incomplete preview and
operation/permission state, and withholds a history token. Cold replay over
budget still returns `history_capacity_exceeded`. The browser clears old turns,
shows the incomplete preview separately, and disables Prompt submission in
the limited View. A complete View is required before submission resumes. An
isolated low-budget six-service Docker/Chromium run verifies this state after
real ACP output and a browser reload.
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
cached and reserved history bytes, stream subscribers, queued and retained
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

`ANTNEST_AGENT_UI_BRIDGE_SESSION_HISTORY_BYTES` defaults to 64 MiB and
`ANTNEST_AGENT_UI_BRIDGE_CACHE_BYTES` to 256 MiB per owner, and
`ANTNEST_AGENT_UI_BRIDGE_TOTAL_HISTORY_BYTES` to 512 MiB across owners. These
are encoded-history estimates and replay reservations. A new replay can evict cold Session
views; subscribed, active or permission-blocked Sessions remain pinned, so a
request may receive `history_capacity_exceeded` when no safe eviction exists.
After a sealed replay, live output that cannot fit changes the affected View to
`view_limited` while continuing to consume delivery watermarks.
These estimates are not a measured Node heap limit.
The production container fixture repeatedly replays 320 KiB of ACP text
against a 256 KiB Session budget: twelve requests return
`history_capacity_exceeded` while a separate Session remains readable. Its
container memory samples are recorded under `artifacts/verification/`.
`ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS` defaults to 16. When full, the Bridge
retires an idle owner before admitting a new scope; if every owner has an
observer or retained work, new scopes receive `bridge_capacity_exceeded` (429).
Existing owners continue serving their work. The owner count separately limits
scope cardinality.
`ANTNEST_AGENT_UI_BRIDGE_IDLE_MS` defaults to 300000 (5 minutes) and
`ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS` to 30000. Both accept integer
milliseconds; the idle lifetime may be zero, while the sweep interval must be
positive. A sweep retires owners only after all observers and retained work
have ended. The production container E2E exercises a short interval and
checks that the same Session is readable with a new owner incarnation.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:bridge:integration
npm run test:browser
npm run test:bridge:soak
```

The extended soak takes about four minutes. From the repository root, run
`node --test tests/e2e/agent-ui/fullstack-current.test.mjs` for the isolated
six-service Docker/Chromium regression; it builds temporary images and cleans
up its Compose project after completion.

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
