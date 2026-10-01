# Agent UI Architecture

Agent UI is one TypeScript/Node service. Its Node process owns the ACP Bridge,
HTTP API, SSE streams, static assets and React SSR. The browser uses same-origin
HTTP commands and SSE observation; it does not connect to ACP. The Edge Gateway
authenticates requests and proxies them to the Node service. See the
[full-stack Bridge plan](fullstack-bridge-refactor.md) for contracts, delivery
batches and remaining acceptance work.

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
execution and persisted output. Node keeps bounded Session, owner and global
history budgets, and rejects a replay that cannot fit without replacing the
previous readable view.

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

The [Skill learning system notices](../../../docs/skill-learning-notifications-design.md)
use SDK 1.5.0's `notice` for live delivery from ACP, then reuse this HTTP/SSE
browser path. ACP persists learning changes before publishing; Node advertises
notice support, handles it independently of cached Session transcripts,
deduplicates by namespaced change identity and reconciles bounded records after
gaps. FE restores the separate system-notice field from Agent View snapshots/
deltas. These are not model messages, Run process entries or ACP delivery marks.
There is no notification long-poll, second browser stream or notification service.
Paused-review diagnostics use the existing Agent View endpoint only when the
user opens learning results; ordinary View and stream refreshes do not query
them. Backend, 144 frontend component tests, five browser integration tests and
two real Docker-stack browser gates pass. Development follows existing styles;
visual refinements follow during human acceptance, as recorded in the
[learning audit](../../../docs/skill-learning-acceptance-audit-20260930.md).

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
Background work deliberately omits an ended HTTP parent; independent span links
for that work remain pending.

If React fails before producing its SSR shell, Node sends a safe loading shell
with no serialized bootstrap. The browser mounts with `createRoot` for that
response and fetches a fresh authorized bootstrap; successfully rendered pages
continue to use `hydrateRoot`.

## Verification

Service unit and component tests live under `web/src` and `web/server/test`.
HTTP/SSE, SSR and Gateway contracts live under root `tests/integration/`;
deployed browser and container checks live under root `tests/e2e/agent-ui/`.
The [refactor plan](fullstack-bridge-refactor.md) records acceptance gaps and
durable evidence locations. Development does not retain a browser ACP/Nginx
compatibility mode.
