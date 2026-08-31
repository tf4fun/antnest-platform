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
authorization is not deferred: `resolve_agent_access` maps an opaque,
Agent-scoped access subject to exactly one principal and Agent. The subject is
not a general user bearer token and must not select an Agent through ACP
Session parameters.

An ACP connection binds the returned `principal_id`, `agent_id`, and
`access_revision` for its lifetime. Agent ACP Service calls
`resolve_agent_access` before every ACP business operation and rejects the
connection if any bound fact changed. Agent Controller must advance the
revision whenever access, Agent mapping, or prompt capabilities change. An
existing Session also stores the principal/Agent pair; remapping cannot
silently move a Session to another Agent.

## Methods

### `GET /status`

Reports whether Agent Controller can accept its internal RPC traffic. Agent ACP
Service uses it only for startup and readiness; it is not a business method and
does not replace per-request failure handling.

### `resolve_agent_access`

Resolves an Agent-scoped access subject before an ACP connection accepts
Session methods and during request-time revalidation. It returns no model
credential and no Runtime endpoint.

### `acquire_run`

Atomically admits a Run only when the Agent is ready and no other Run is
active. In that same transaction it verifies that `principal_id` is still
authorized for `agent_id` at `expected_access_revision`. The non-secret access
facts are captured in the durable Run intent so startup recovery performs the
same check; a pre-admission access check is only a fast failure path, not the
authorization authority. The stable `request_id` makes retry after an uncertain
response idempotent. A successful response is a complete, immutable, non-secret
input for one Run. The response is copied into Agent ACP Service's private
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

Closes an admission idempotently. `tool_effect_state` covers every dispatched
Tool source, not only Runtime MCP. `unknown` is a real terminal report, not
permission to replay a Tool. Timeout or connection loss does not prove whether
an effect happened.

The terminal facts form one closed union:

- `completed`: quiescent executor, `none|settled` Tool effect, required
  `stop_reason`, no error class;
- `cancelled`: quiescent executor, `none|settled` Tool effect, no stop reason;
- `failed`: quiescent executor, `none|settled` Tool effect, required error
  class, no stop reason;
- `unresolved`: unknown executor and Tool effect, required error class, no stop
  reason.

Repeating the same request is idempotent. Reusing an admission with different
terminal facts is a contract violation, not a second successful finish.

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

1. This document and machine catalog describe contract revision 3.
2. Contract fields are `snake_case`; ACP wire fields remain the ACP-defined
   `camelCase` shapes.
3. New optional response fields may be added. Existing required fields cannot
   change meaning.
4. Secrets cannot be added to `acquire_run` merely to remove one RPC.
5. Agent ACP Service tests use a contract fixture until Agent Controller is
   implemented. A fake is not an alternate production authority.
6. Every method's HTTP verb, successful status, and content type are part of
   the machine contract rather than transport-adapter convention.
