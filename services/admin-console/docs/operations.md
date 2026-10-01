# Admin Console Operations

This document covers Admin Console configuration, network requirements,
shutdown behavior, and lifecycle and network-policy recovery from an
operator's point of view.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTNEST_ADMIN_CONSOLE_LISTEN` | no | `:8080` | HTTP listen address |
| `ANTNEST_IDENTITY_SERVICE_URL` | yes | - | trusted Identity Service base URL |
| `ANTNEST_AGENT_CONTROLLER_URL` | yes | - | trusted Agent Controller base URL |
| `ANTNEST_AGENT_ACP_SERVICE_URL` | yes | - | trusted ACP execution-audit base URL |
| `ANTNEST_SKILL_REGISTRY_URL` | no | empty | Skill Registry base URL; when empty, Skill routes return `503 dependency_unavailable` |
| `ANTNEST_SKILL_REGISTRY_API_TOKEN` | with Registry URL | - | Registry service token, at least 32 bytes without surrounding whitespace; must be set together with the URL and rejected without it |
| `ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF` | no | empty | platform default image reference for Template creation; revisions retain their pinned value without a digest editor |
| `ANTNEST_ADMIN_DEPENDENCY_TIMEOUT` | no | `15s` | bounded non-streaming dependency timeout, including Provider model discovery |
| `ANTNEST_ADMIN_SHUTDOWN_TIMEOUT` | no | `15s` | graceful HTTP drain budget |
| `ANTNEST_ENVIRONMENT` | no | empty | deployment environment telemetry attribute |
| `OTEL_*` | no | - | standard OTLP HTTP/protobuf signal configuration |

Edge Gateway forwards admin requests with its own 10-second
`ANTNEST_EDGE_REQUEST_TIMEOUT`, which is shorter than the 15-second Console
dependency timeout. A slow dependency can therefore produce a Gateway `503`
before Console returns its own error.

`GET /status` checks local initialization and stopping state only. It never
probes Identity, Agent Controller, ACP or Skill Registry; downstream failures
are reported by the actual business request. The compiled React assets are
embedded into the binary, so no writable web volume is required. See
[observability](observability.md) for capture guarantees and limits.

## Outbound Network Access

Provider model discovery runs in Console, not in Controller. It makes outbound
HTTP(S) `GET {base_url}/models` requests to the base URL an administrator enters
for a Provider connection, using that connection's API key. Console therefore
needs outbound network access to the Provider endpoints in use. There is no
host allowlist: any absolute HTTP(S) base URL without credentials, query or
fragment is accepted, so an administrator can direct these requests at any
host reachable from the Console container, including internal addresses.
Restrict Console egress at the network layer if that is not acceptable.
Redirects are not followed and responses are limited to 8 MiB.

The default Runtime image is a Template input, not an already published
execution binding. `ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF` may contain a local
repository/tag such as `antnest/antnest-runtime:local` or an immutable image
reference; it may also be empty. Console trims and forwards this default.
Agent Controller validates it and resolves tags through Runtime Controller when
publishing a Template revision. Console startup neither inspects Docker nor
requires a digest; an invalid or missing image is reported by Template creation.

Admin Console must not be published directly. Edge Gateway is its only
supported external path. The service has no database, migrations, backup, or
persistent volume.

The browser derives OIDC and SCIM setup addresses from the public Edge origin,
so there is deliberately no Admin Console environment variable for either
external URL. A reverse proxy must preserve the public origin seen by the
browser and route `/protocol/oidc/callback` and `/scim/v2` to Edge Gateway.

Local password rotation has no service-side configuration. Credential fields
are request-only and must not be added to access logs, traces, environment
variables, or retry storage. Existing browser sessions remain governed by
Identity access-token lifetime and explicit logout.
An incorrect current password returns `401 invalid_current_password` from the
BFF and stays in the password dialog. A Gateway `401 unauthenticated` means the
browser must sign in again, including when changing its password. Unknown or
malformed `401` responses are not exempted. Dependency `503` failures keep the
session and allow an explicit retry; no password command is retried automatically.

An overview with unavailable Agent inventory is never emitted: that failure
fails the request. Optional section envelopes should be surfaced as partial-data
notices by the UI. Repeated degradation indicates an owning service or network
fault; there is no aggregate cache to repair.

## Shutdown Contract

On SIGTERM or SIGINT, Console closes its upstream event Watches before waiting
for HTTP requests to drain. A quiet Watch must not keep the process alive until
the shutdown deadline. Client disconnection cancels only that client's Watch;
service shutdown cancels all Watches and does not accept new ones. Cancellation
also expires that stream's downstream write deadline, releasing a Watch blocked
by an unread response. Event history remains owned by Agent Controller and is
replayed after browser reconnection.

Ordinary in-flight requests keep their existing request and dependency timeout
and may finish within the shutdown budget. If they cannot drain, the server
closes their connections and reports the shutdown failure. After forced close,
Console allows up to five additional seconds for cancelled handlers to finish
before shutting down telemetry. A handler that still cannot exit produces a
separate drain error; its unfinished telemetry is not guaranteed. Expected Watch
cancellation is not an invalid-upstream-response warning. Telemetry shutdown
follows the HTTP drain so completed request spans can be exported.

Regression coverage uses real HTTP connections through the production BFF
and upstream client: stop with a quiet Watch still open, drain a concurrent
ordinary request, and preserve an actual shutdown-deadline error, including
downstream write backpressure and handler/trace completion after forced close.

From the repository root, build the current image and run the bounded container
regression serially:

```sh
docker build -t antnest/admin-console:local -f services/admin-console/Dockerfile .
node tests/e2e/admin-console/shutdown-docker.mjs
```

The runner reuses the repository's bounded Docker-command helpers; install the
Agent ACP Service Node dependencies (`npm --prefix services/agent-acp-service ci`)
before running it. The
controlled upstream container itself uses only Node built-ins.

The regression uses two disposable containers on its own labelled network,
synthetic trusted headers and a quiet controlled upstream. It tests SIGTERM,
restart and SIGINT with an open Watch, exit codes and stream cancellation. It
does not start PostgreSQL, call model providers or inspect integration secrets.
Success, failure and interruption clean only its own labelled resources. It
tests service shutdown only, not Gateway-rooted tracing.

## Lifecycle Recovery

`202` acknowledges a durable lifecycle request, not a ready Runtime. The detail
page reads the operation and Agent independently, displays the failure phase
and diagnostic detail from the operation, and never retries a mutation merely
because an event stream or follow-up read failed.

An idle `unavailable` Agent may be deleted even when initial construction never
published an execution or Runtime binding. The Controller owns discovery and
cleanup of its retained resources. Without successful execution history, Console
offers Delete, not Rebuild/Enable/Disable. Correct the Template or deployment
configuration and create a new Agent after cleanup.

An enabled unavailable Agent with retained spec and last-successful execution
identifiers can instead request explicit Rebuild using an enabled Template
revision. Those identifiers are history, never a published execution binding or
current executable configuration. The BFF projects only those safe identifiers;
the Controller owns source integrity, identity and locked admission checks.
Quarantined Agents, unexpected retained executable bindings, active operations
and uncertain reads do not expose this recovery action. Disable/Enable are not
unavailable-Agent recovery commands. Runtime loss/restart has a distinct failure
explanation and retained event label; it is not reported as a failed user change.
The ordinary Rebuild dialog and asynchronous operation/event flow apply. No
automatic retry is triggered by reconnect, event replay, or a failed refresh.
Active lifecycle operations and uncertain Agent reads keep all mutations closed.
The last operation retains its phase, error code and diagnostic detail after
completion or failure. The Agent snapshot selects the current request and gates
actions; it cannot erase an acknowledged operation just because an older snapshot
has no active request. Operation reads own progress, and a known terminal result
cannot regress to running when an admission response arrives late. Delete is
shown as removing until the Agent actually reaches deleted.
An idle unavailable Agent shows its requested state without claiming an ongoing
transition. A deleted Agent's absent configuration is removal, not a build error.

After successful event replay, refresh the authoritative Agent and its operation
again before reopening the stream, closing the read-before-replay race. A failed
refresh remains a separate read error and keeps mutations closed.

Initial history and explicit event retry also compare the per-Agent aggregate
sequence against the loaded Agent. When history is newer, reread the Agent;
if the initial read is still pending, finish that read before deciding whether
another is needed. A still-lagging or failed read keeps mutations closed with a
manual state refresh, without adding periodic polling. Events never manufacture
Agent state. Historical operation hints advance monotonically and cannot replace
an acknowledged unfinished command. Dialog confirmation and submission use the
same current action gate as their entry buttons.

The retained lifecycle record and events remain available after
refresh. Deleting a failed Agent retains its record and ordered events for audit.

On an event-stream disconnect, the page closes that stream, refreshes the Agent
and replays List from its last applied **global** sequence. A transient List
failure retries only that read; terminal access/resource failures stop automatic
recovery. The replacement Watch begins at the returned `next_sequence`.
History is merged by event identity, not replaced on reconnect. Leaving the page
disposes the stream and retry timer; late replay responses must not reopen it.

For EventSource reconnect requests the BFF translates `Last-Event-ID` to the
upstream Watch cursor, taking precedence over a stale `after_sequence` URL.
Malformed or repeated header values must fail instead of silently replaying
from zero. Organization scope always comes from the trusted Gateway principal.

Console Go tests and `npm --prefix services/admin-console/web test` cover the
BFF and components with controlled upstreams and events. Docker startup,
workspace retention/deletion, lifecycle worker restart and cross-service traces
are covered by the platform Docker end-to-end suite; see
[Docker single-node operations](../../../docs/docker-single-node-operations.md).

## Network Policy Recovery

The Agent Network section is independent of lifecycle progress. A policy change
does not rebuild or enable an Agent. `Network policy saved` confirms the
assignment command, not an end-to-end traffic probe. A paused attachment remains
visible separately.

Unconfirmed writes retain non-secret action/version/request-key entries in
browser local storage, scoped to organization, administrator and Agent. Do not
clear those entries to resolve `cleanup_failed`: use the explicit retry so the
same command can finish its cleanup fence. A matching GET cannot confirm that
work. Conflicts require a fresh read and deliberate new selection. Account
changes require reloading; the original account's pending entries are retained.
Lifecycle/reconnect refreshes are independent reads and never resubmit a write.
See [network policy contract](network-policy.md) for the full state model.

Console does not follow dependency redirects. Incoming W3C trace context is
continued through the BFF and its single Controller request; body, credential,
policy internals and packet data are not logged as trace attributes. Real
HTTP component tests validate parentage without a Collector; deployed
Gateway-rooted traces and live packet enforcement are verified by the platform
Docker end-to-end suite.
