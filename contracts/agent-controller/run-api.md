# Agent Controller Run Admission Contract

> Status: Stage 2 contract<br>
> Transport: trusted internal JSON over HTTP<br>
> Owner: Agent Controller

This contract is the complete Agent Controller surface consumed by Agent ACP
Service: one readiness endpoint plus the Run admission methods. The business
methods resolve an authenticated connection to one Agent, admit exactly one
serialized Run, resolve one admission-scoped Provider secret, and close the
admission. Agent ACP Service must not read Agent Controller tables or
reconstruct current Agent configuration from separate calls.

The machine-readable request and response shapes are in
[`run-contract.json`](run-contract.json).

## Trust And Identity

The caller is an internal service on a trusted deployment network. Transport
authentication is intentionally deferred to Edge Gateway. Domain
authorization is not deferred: `resolve_agent_access` maps the already
authenticated subject to exactly one principal and Agent.

An ACP connection binds the returned `principal_id`, `agent_id`, and
`access_revision` for its lifetime. An existing Session also stores that pair;
credential remapping cannot silently move a Session to another Agent.

## Methods

### `GET /status`

Reports whether Agent Controller can accept its internal RPC traffic. Agent ACP
Service uses it only for startup and readiness; it is not a business method and
does not replace per-request failure handling.

### `resolve_agent_access`

Resolves a transport-authenticated subject before an ACP connection accepts
Session methods. It returns no model credential and no Runtime endpoint.

### `acquire_run`

Atomically admits a Run only when the Agent is ready and no other Run is
active. The stable `request_id` makes retry after an uncertain response
idempotent. A successful response is a complete, immutable, non-secret input
for one Run. The response is copied into Agent ACP Service's private
`RunExecutionSnapshot` before the prompt is acknowledged.

The snapshot includes one Runtime MCP endpoint and execution identity. Agent
ACP Service must never discover or refresh that endpoint through Docker,
Kubernetes, Runtime Controller, or DNS metadata.

The response also freezes `runtime_mcp_source_digest`,
`agent_execution_spec_digest`, and the non-secret `credential_version`. The
credential resolver must return that same version; a mismatch fails the Run
before the first model request rather than silently executing under configuration
that differs from the admitted snapshot.

### `resolve_credential`

Resolves one opaque `credential_ref` only while its `admission_id` is active.
The returned secret is held in memory for that Run and must not enter the ACP
database, logs, traces, errors, or Tool results.

### `finish_run`

Closes an admission idempotently. `runtime_effect_state=unknown` is a real
terminal report, not permission to replay a Tool. Timeout or connection loss
does not prove whether a Runtime side effect happened.

## Error Classes

Every non-success response uses the error envelope from the JSON contract.

| Code                     | Retry   | Meaning                                                                  |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `access_denied`          | no      | Subject is not mapped to the requested connection context                |
| `agent_not_found`        | no      | Mapped Agent no longer exists                                            |
| `agent_busy`             | yes     | Another Run owns the Agent admission                                     |
| `agent_rebuilding`       | yes     | Agent is temporarily unavailable during rebuild                          |
| `agent_build_failed`     | no      | Administrator action is required before another Run                      |
| `admission_not_found`    | inspect | Admission is absent or no longer visible                                 |
| `credential_not_allowed` | no      | Reference is not part of the admitted snapshot                           |
| `dependency_unavailable` | yes     | Request outcome is unknown unless the method is retried with the same ID |

## Compatibility Rules

1. Contract fields are `snake_case`; ACP wire fields remain the ACP-defined
   `camelCase` shapes.
2. New optional response fields may be added. Existing required fields cannot
   change meaning.
3. Secrets cannot be added to `acquire_run` merely to remove one RPC.
4. Agent ACP Service tests use a contract fixture until Agent Controller is
   implemented. A fake is not an alternate production authority.
5. Every method's HTTP verb, successful status, and content type are part of
   the machine contract rather than transport-adapter convention.
