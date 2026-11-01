# ACP Connection Liveness And Permission Resolution (#54)

This document defines the shared WebSocket liveness, permission connection
fan-out, permission resolution notice and approval timeout contract. It is a
contract-first batch: ACP producer implementation and Agent UI consumers
remain pending, and the contract alone does not advertise a running capability
or a complete business workflow. The Gateway WebSocket relay was removed by
#64; Agent UI consumes ACP over Streamable HTTP/SSE, and this contract does
not reintroduce a relay transport or a Gateway service change.

## Scope And Status

- Producer pending: ACP WebSocket liveness timers, `PermissionConnections`
  multi-attachment fan-out, decision withdrawal, resolution notice
  publication and approval timeout enforcement.
- Consumer pending: Agent UI handling of the resolution notice and the
  `permission_stale` decision rejection.
- Resolution notices are auxiliary live diagnostics. They cannot pick,
  record or commit a permission outcome, and they are not part of transcript
  replay.

## WebSocket Liveness

The ACP WebSocket server and each directed owner-peer connection run
liveness detection in both directions under the
[owner-peer transport contract](owner-peer.md). Each side sends a WebSocket
ping every configured interval and must receive the matching pong.

| Scope                                        | Environment variable           | Default |
| -------------------------------------------- | ------------------------------ | ------- |
| ACP WebSocket ping interval, server and peer | `ANTNEST_ACP_WS_PING_INTERVAL` | `20s`   |

The configured interval must be a positive duration whose effective value is
from 1 through 300000 milliseconds; invalid values fail startup. If no
matching pong arrives within two intervals from the last acknowledged
activity — or from connection start when nothing has been acknowledged — the
connection is terminated. Application data frames do not count as a pong;
only a protocol pong satisfies liveness. All liveness timers and listeners
are cleared on close or error, and a normal shutdown still uses close code 1001. Termination detaches the affected permission attachment without
blocking the remaining attachments.

## Permission Connection Fan-Out

`PermissionConnections` fans an outstanding permission request out to every
attached Session connection whose binding matches the request's
organization, principal and Agent. Attaching a new connection does not evict
other connection IDs, and an attachment added while a request is outstanding
receives that request. A dead or detached peer does not block the remaining
attachments.

The first valid authorized response wins and is submitted for exactly one
durable decision; selecting it emits a cancellation signal that withdraws the
outstanding request on the other attachments. The existing pre-request and
post-response access checks and authority fencing keep their current
boundaries, and a losing or withdrawn reply cannot overwrite the persisted
decision.

A JSON-RPC response frame cannot itself receive a protocol error, so a peer
that answered too late cannot be told through that response that it lost.
Withdrawal is therefore signalled by SDK cancellation of the outstanding
request, and the browser decision endpoint rejects a late or stale decision
with HTTP 409 `permission_stale` under the
[error catalog](errors.json) and the
[workspace decision contract](../agent-ui/workspace-api.md).

## Permission Resolution Notice

Permission request correlation rides the existing `_meta` extension used by
the [workspace bridge contract](workspace-bridge.md). Each
`session/request_permission` request carries:

```json
{
  "_meta": {
    "antnest.dev/permission-request": {
      "version": 1,
      "runId": "run-1",
      "toolCallId": "call-1"
    }
  }
}
```

When a request is durably resolved or times out, ACP may publish one live
`session/update` notice on each attachment that received the request:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-1",
    "update": {
      "sessionUpdate": "notice",
      "severity": "info",
      "title": "Permission request resolved",
      "_meta": {
        "antnest.dev/permission-resolution": {
          "version": 1,
          "runId": "run-1",
          "toolCallId": "call-1",
          "reason": "permission_resolved"
        }
      }
    }
  }
}
```

The `_meta["antnest.dev/permission-resolution"]` payload is the closed
[permission resolution schema](permission-resolution.schema.json): a literal
`version: 1`, opaque `runId` and `toolCallId` strings of 1 to 200 characters,
and a `reason` of `permission_resolved` or `permission_timeout`. The payload
correlates a resolved or expired request; it is not an approval and not a
tool completion, and `session/load` replay never includes notices. On ACP v1
the notice is sent only when the client advertises
`clientCapabilities.session.notices`; on ACP v2 the notice Session update is
supported without that requirement.

## Approval Timeout

| Scope                        | Environment variable             | Default                  |
| ---------------------------- | -------------------------------- | ------------------------ |
| Permission approval deadline | `ANTNEST_ACP_PERMISSION_TIMEOUT` | `min(10m, runTimeout/2)` |

An explicit value must be a positive duration strictly below the configured
Run timeout, and the effective timer never exceeds 2147483647 milliseconds.
An unanswered request that reaches the deadline commits a durable cancelled
outcome with reason `permission_timeout` and no tool effect, classified by
the [error catalog](errors.json) `permission_timeout` entry as `availability`
`-32039` with HTTP 408 and `refresh_permission` recovery. The existing
RunToolAuthorization refusal and continuation policy is unchanged; the #76
permission-outcome handling is not implemented by this contract.

Reconnection does not restart an outstanding approval timeout, and a
cancelled, expired or revoked request can never grant a tool rule.
`retryable: true` on `permission_timeout` applies to refreshing permission
or submitting new eligible work; it never authorizes replaying an accepted
Prompt, model request or Tool effect.

## Consumer Replica Requirements

Agent UI permission decisions are volatile and require a single UI replica;
owner-sticky assignment is not currently implemented. A restart loses the
volatile attachment and notice caches and rebuilds views through authoritative
Session/Run reads and reissued outstanding ACP permission requests, without
resubmitting prompts or decisions.

## Delivery Order

Each owning-service batch requires its own tests and documentation before
the explicit integration batch; local checks do not establish complete
acceptance and Docker end-to-end evidence stays with its dedicated workflow.

1. Freeze this contract, the catalog entry and the notice schema before
   producers or consumers implement them (this batch).
2. ACP producer batch: implement WebSocket liveness, multi-attachment
   fan-out, cancellation withdrawal, the decision `permission_stale`
   mapping, notice publication and the approval timeout, with the
   authorization and fencing checks above unchanged.
3. Agent UI consumer batch: withdraw the matching inbox entry on an optional
   resolution notice and surface the
   `permission_stale` rejection without selecting a default answer.
4. Explicit integration batch: prove fan-out, first-decision wins,
   withdrawal and timeout durability across the real components. Span and
   Trace diagnostics remain auxiliary; business results, authorization,
   persistence and actual cleanup are the blocking checks.
