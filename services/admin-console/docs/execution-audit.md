# Execution Audit And Configuration Synchronization

This document describes how Admin Console reads execution audit records directly
from Agent ACP Service and configuration synchronization state from Agent
Controller, and how the browser audit view presents them.

## Read Routes

All routes require the existing verified administrator context from Gateway.
They are read-only, use the request dependency timeout, never retry upstream
calls automatically, and return `Cache-Control: no-store`.

| Browser BFF route | Owning RPC | Input |
| --- | --- | --- |
| `GET /api/admin/execution-audits` | ACP `POST /rpc/agent-acp/list-execution-audits` | optional `agent_id`, `session_id`, `created_from`, `created_until`, `limit`, `cursor` query fields |
| `GET /api/admin/execution-audits/{run_id}` | ACP `POST /rpc/agent-acp/get-execution-audit` | Run ID in the path |
| `GET /api/admin/execution-audits/{run_id}/events` | ACP `POST /rpc/agent-acp/list-execution-events` | Run ID, optional `stream`, `limit`, `cursor`; execution and permissions have independent cursors |
| `GET /api/admin/execution-synchronization` | Controller `GET /internal/execution-synchronization` | organization from the verified context, never browser input |

The ACP routes do not fetch an Agent from Controller, load a Session, or invoke
an execution command. Deleted-Agent history remains queryable when Controller
is unavailable. ACP owns historical organization isolation, permissions,
pagination, and execution records. BFF shapes browser DTOs; it does not infer
execution facts from Controller events or reconstruct an execution state machine.

## Identity And Transport

`ANTNEST_AGENT_ACP_SERVICE_URL` is the required internal ACP base URL. Console
first authenticates Gateway, then verifies the Identity signature, Console
audience, lifetime and route scope of `Antnest-Caller-Context`. Administrator
roles come from those claims; browser or Gateway presentation hints are not
an authorization source. The unchanged CCT and separately authenticated Console
workload connection reach ACP. No legacy management identity headers are emitted;
valid signed identities are not restricted by the old header encoding.

There is no Agent-owner impersonation, browser cookie/token forwarding or
browser-selected upstream. Redirects are not followed. Normal HTTP client
instrumentation propagates the incoming trace without capturing credentials.
`/status` remains local and never probes ACP or another dependency. See the
[authentication contract](../../../contracts/admin-console/service-authentication.md).

Unknown/duplicate query fields are rejected. Body/query identity cannot replace
the principal. Audit input, non-secret execution snapshots, Tool payloads and
permission records are intentionally visible to the administrator; future
internal fields outside these browser DTOs are not automatically exposed.
The platform-owned execution snapshot has a nested browser projection: model
parameters/pricing, system instructions, Skill instructions, authorization and
build/configuration references. Access revisions, Runtime connection identity,
internal endpoints and future nested fields are omitted. The original snapshot
stays in ACP storage. Original input and Tool/permission content are not subject
to generic field-name redaction. Required nullable fields must be present;
missing values never become a fabricated zero, false or null.
Invalid upstream shapes and transport errors are failures, never empty history.
Controller synchronization is a stored acknowledgement, not live ACP health,
Agent readiness or Run occupancy. An absent record stays null.

## Browser View Contract

`#audits` is independent of the current Agent inventory and Controller health.
`#audits?agent_id=...` filters retained execution history, including deleted
Agents. `#audits/{encoded_run_id}` opens one record without activating its
Session. Agent detail links to the filtered list; a permanent navigation entry
remains usable after the Agent has been deleted.

The list supports Agent and Session filters and chronological bounds, preserving
the server's opaque cursor. Detail, execution events and permission records are
independent reads with independent failures and cursors. No global merged event
sequence is invented. Original input, platform configuration snapshot, usage,
Tool payloads and permission decisions remain inspectable. Detail JSON is text,
never executable HTML. Refresh and pagination are explicit; there is no polling,
automatic execution, retry of mutations or dependence on a management refresh.
Leaving the page or changing its resource cancels pending reads and discards late
responses. Failed pagination preserves the already loaded records and retries the
same cursor; it never substitutes empty history for a dependency failure.
Refreshing execution detail does not remount the two streams or reset their
pagination. Lifecycle events remain a separate Controller view; their DTO no
longer carries the removed per-Run `admission_id`.

## Testing

Service tests cover the real BFF and traced upstream adapter, all three ACP
routes, exact identity propagation, absence of Controller/Identity fan-out,
organization-admin access, rejected untrusted/ordinary-user access, query
shaping, read-only pagination, upstream failures and cancellation. Controller
synchronization has a separate route and data source.

For the browser UI test, build with `npm --prefix web run build`, then run
`npm --prefix web run test:browser:audit` from this service directory. The test
uses the pinned Playwright dev dependency and Chromium (`npm --prefix web exec
-- playwright install chromium` installs the browser if absent). It starts a
loopback-only static server on a free port and intercepts only synthetic browser
API responses. It checks desktop/mobile overflow, collapsed/expanded content,
opaque-ID routing and refresh independence, then closes its browser and server.
Screenshots are written to `artifacts/verification/console-audit-browser/`. The
test source is
[`tests/integration/admin-console/execution-audit-browser.mjs`](../../../tests/integration/admin-console/execution-audit-browser.mjs).
It is a Console-only UI test; real Gateway login, deleted-Agent audit reads and
authorization rejections are covered by the platform Docker end-to-end suite.

The owner contracts are [ACP audit](../../agent-acp-service/docs/execution-audit.md)
and [Controller synchronization](../../../contracts/agent-controller/control-api.md#execution-configuration-synchronization).
