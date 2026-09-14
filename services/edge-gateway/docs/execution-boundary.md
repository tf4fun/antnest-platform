# Controller And ACP Execution Boundary

## Ownership

Gateway authenticates browser sessions and establishes a trusted
`(organization_id, principal_id, agent_id)` tuple. Organization and principal
come from Identity; Agent ID comes from the target route. ACP owns resource
authorization and protocol errors. Neither an administrator role nor an Agent
appearing in a discovery list authorizes a Session operation.

Controller supplies metadata for first-load discovery only. The list/bootstrap
contains Agent ID and name, without an opaque subject or execution availability.
Gateway must not query that list to route ACP or synthesize ACP readiness errors.
Once discovery has completed, Controller unavailability must not prevent later
protocol requests or execution-state reconnection.

## Protocol Transport

The existing public v1 HTTP/SSE and v1/v2 WebSocket routes remain unchanged.
Gateway overwrites `X-Antnest-Organization-Id`, `X-Antnest-Principal-Id` and
`X-Antnest-Agent-Id` from verified context. Caller-supplied identity, cookies,
bearer tokens and the retired access-subject header are not forwarded to ACP.
Transport connection and Session IDs remain opaque and are validated by ACP.

JSON-RPC requests, reverse requests, notifications, errors and streaming frames
are forwarded without interpreting methods or retrying prompts. An unavailable
Agent can still reach ACP to receive its protocol error or read authorized history.
Authentication, CSRF, same-origin validation, payload and connection limits,
shutdown cancellation and trace propagation remain Gateway responsibilities.

## Implementation Batches

1. Metadata-only Controller list/bootstrap and direct protocol routing, including
   HTTP and WebSocket trusted identity, negative forgery tests and Controller outage.
2. Move state reads/watch to the ACP internal contract. Preserve bounded streams,
   identity revalidation, cancellation and exact state/error semantics. Do not
   retain Controller execution-state fallback.
3. Complete service gates and readonly review. Agent UI/bootstrap consumption,
   Console audit queries and actual Docker/Jaeger integration follow their own
   batches; do not deploy unmatched consumers.

The shared plan and state contract remain authoritative:
[boundary plan](../../../docs/controller-acp-execution-boundary-plan.md),
[ACP internal contract](../../../contracts/agent-acp/execution-api.md).

Tests use synthetic HTTP/WebSocket dependencies and assert no Controller call
during protocol/state flows. Gateway owns no execution database or protocol state.

## Local Delivery Status

Gateway production routing and execution-state consumption are switched to this
contract. The local race suite and isolated Docker shutdown fixture passed;
the latter uses synthetic upstream services, not the complete platform.
B4/B4U consumers and B5 real-stack acceptance remain outstanding.

Readonly review found encoded-separator IDs escaping shutdown tracking; route
classification now preserves escaped segment boundaries and real HTTP tests
verify cancellation. State IDs use header-safety and length checks rather than
a Gateway-owned namespace grammar. The subsequent ACP-owned batch aligned its
trusted identity, configuration and audit schemas, with HTTP, WebSocket, local
authorization and PostgreSQL regression coverage. This closes that producer-side
contract mismatch, not the remaining B4/B4U consumer or B5 integration work.
