# Controller And ACP Execution Boundary

This document describes how Edge Gateway splits responsibilities between Agent
Controller (management metadata) and Agent ACP Service (execution authority).

## Ownership

Gateway authenticates browser sessions and establishes a trusted
`(organization_id, principal_id, agent_id)` tuple. Organization and principal
come from Identity; Agent ID comes from the target route. ACP owns resource
authorization and protocol errors. Neither an administrator role nor an Agent
appearing in a discovery list authorizes a Session operation.

Controller supplies metadata for first-load discovery only. The list/bootstrap
contains Agent ID, name and Controller lifecycle/activation/Runtime metadata,
without an opaque subject or ACP execution availability. Management state never
unlocks input; execution availability comes from ACP.
Gateway does not query that list to route ACP or synthesize ACP readiness errors.
Once discovery has completed, Controller unavailability does not prevent later
protocol requests or execution-state reconnection. State reads and watches use
the ACP internal contract only; there is no Controller execution-state fallback.

## Protocol Transport

The public v1 HTTP/SSE and v1/v2 WebSocket routes are stable.
Gateway overwrites `X-Antnest-Organization-Id`, `X-Antnest-Principal-Id` and
`X-Antnest-Agent-Id` from verified context. Caller-supplied identity, cookies,
bearer tokens and the retired access-subject header are not forwarded to ACP.
Transport connection and Session IDs remain opaque and are validated by ACP.

JSON-RPC requests, reverse requests, notifications, errors and streaming frames
are forwarded without interpreting methods or retrying prompts. An unavailable
Agent can still reach ACP to receive its protocol error or read authorized history.
Authentication, CSRF, same-origin validation, payload and connection limits,
shutdown cancellation and trace propagation remain Gateway responsibilities.

Route classification preserves escaped path segment boundaries, so IDs that
contain encoded separators cannot escape shutdown tracking. State IDs use
header-safety and length checks rather than a Gateway-owned namespace grammar.

The state contract is the
[ACP internal execution contract](../../../contracts/agent-acp/execution-api.md).

## Testing

Tests use synthetic HTTP/WebSocket dependencies and assert that no Controller
call occurs during protocol and state flows, including when Controller is down,
and that forged identity headers are not forwarded. Gateway owns no execution
database or protocol state.
