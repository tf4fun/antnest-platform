# Agent Controller Run Admission Contract

> Status: Stage 2 contract<br>
> Transport: trusted internal JSON over HTTP<br>
> Owner: Agent Controller

This contract is the complete Agent Controller surface consumed by Agent ACP
Service and Edge Gateway: one readiness endpoint, a browser-workspace access
projection, and the Run admission methods. The business methods resolve an
authenticated connection to one Agent, admit exactly one
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

### `list_workspace_agents`

Returns the active Agent access bindings for one already authenticated
organization principal. Edge Gateway is the only browser-facing consumer. It
projects `agent_id`, display name, and the authoritative `ready|busy|offline`
availability to JavaScript, while retaining `agent_access_subject` exclusively
on the server for the later ACP WebSocket upgrade. Pagination uses the same
opaque `(created_at, agent_id)` cursor as the management projection.

`busy` means an active Run owns Agent admission. A blocked unknown Tool effect
and every non-available lifecycle state are `offline`, because they require
recovery or administrator action rather than another user submission. The
method never returns Runtime endpoints, model credentials, immutable execution
snapshots, or organization-wide Agents without an active binding for the
principal.

### `resolve_agent_access`

Resolves an Agent-scoped access subject before an ACP connection accepts
Session methods and during request-time revalidation. Agent Controller also
revalidates that the frozen owner is still an active member of the Agent's
organization through Identity Service. A definitive inactive or absent binding
is `access_denied`; an unavailable or contract-invalid Identity response is
`dependency_unavailable`. It returns no model credential and no Runtime
endpoint.

### `acquire_run`

An exact replay first returns the already admitted immutable snapshot without
reinterpreting it under current Identity state. A new admission revalidates the
Agent owner through Identity Service, then atomically admits the Run only when
the Agent is ready and no other Run is active. In that transaction it verifies
that `principal_id` is still authorized for `agent_id` at
`expected_access_revision`. The Identity response and local transaction form
the admission authorization boundary; `resolve_agent_access` remains a fast
failure and connection-routing check, not the authority for a later Run. The
stable `request_id` makes retry after an uncertain response idempotent. A
successful response is a complete, immutable, non-secret input for one Run. The
response is copied into Agent ACP Service's private `RunExecutionSnapshot`
before the prompt is acknowledged.

The snapshot includes one opaque Runtime revision, MCP endpoint, and execution
identity. Physical Runtime generation and instance identifiers are private to
Runtime Controller and never appear here. Agent ACP Service must never discover
or refresh that endpoint through Docker, Kubernetes, Runtime Controller, or DNS
metadata.

The response also freezes `runtime_mcp_source_digest`,
`agent_execution_spec_digest`, `context_policy_version`, and the non-secret
`credential_version`. Stage 2 supports `context-v1`; an unknown version is
rejected before execution rather than interpreted as the current policy. The
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
an effect happened. `unknown_effect_source` is null for every settled outcome;
an unresolved outcome requires `runtime_mcp`, `client_mcp`, or `unclassified`.

The terminal facts form one closed union:

- `completed`: `none|settled` Tool effect, required
  `stop_reason`, no error class;
- `cancelled`: `none|settled` Tool effect, no stop reason;
- `failed`: `none|settled` Tool effect, required error
  class, no stop reason;
- `unresolved`: unknown Tool effect, required source and error class, no stop
  reason.

`finish_run` is accepted only after the local executor is quiescent and can no
longer issue model or MCP requests. That is a method precondition, not a second
state field in the terminal union.

Repeating the same request is idempotent. Reusing an admission with different
terminal facts is a contract violation, not a second successful finish.

The immutable executor report and the admission's coordination occupancy are
separate facts. Completed, cancelled, and failed reports release admission. An
unresolved report is sealed once, while admission becomes
`blocked_unknown_effect` and continues excluding new Runs. A rebuild/delete
barrier may later prove the bound Runtime absent and release that occupancy only
for `runtime_mcp`; it must not rewrite the original executor report. Disable has
the same authority after Runtime Controller proves the source Runtime has no
running compute. `client_mcp` and `unclassified` effects remain blocked because
Runtime absence is unrelated evidence. The barrier transition, admission
release, Agent aggregate-sequence advance, and `run_admission_released` event
are one transaction. Its event envelope carries both `operation_request_id`
and `admission_id`; no event is synthesized when there is no releasable
admission.

## Error Classes

Every non-success response uses the error envelope from the JSON contract.

| Code                     | Retry   | Meaning                                                                  |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `access_denied`          | no      | Subject mapping or current owner membership is no longer authorized      |
| `agent_not_found`        | no      | Mapped Agent no longer exists                                            |
| `agent_busy`             | yes     | Another Run owns the Agent admission                                     |
| `agent_rebuilding`       | yes     | Agent is temporarily unavailable during rebuild                          |
| `agent_build_failed`     | no      | Administrator action is required before another Run                      |
| `agent_not_ready`        | yes     | Agent is disabled, deleting, or otherwise not executable                 |
| `admission_not_found`    | inspect | Admission is absent or no longer visible                                 |
| `credential_not_allowed` | no      | Reference is not part of the admitted snapshot                           |
| `invalid_request`        | no      | Request shape or immutable terminal facts violate the contract           |
| `dependency_unavailable` | yes     | A required service could not provide a trustworthy response; retry later |
| `internal_error`         | yes     | Request outcome is unknown unless the method is retried with the same ID |

## Compatibility Rules

1. This document and machine catalog describe contract revision 9.
2. Contract fields are `snake_case`; ACP wire fields remain the ACP-defined
   `camelCase` shapes.
3. New optional response fields may be added. Existing required fields cannot
   change meaning.
4. Secrets cannot be added to `acquire_run` merely to remove one RPC.
5. Agent ACP Service tests use a contract fixture until Agent Controller is
   implemented. A fake is not an alternate production authority.
6. Every method's HTTP verb, successful status, and content type are part of
   the machine contract rather than transport-adapter convention.

## Admission Lifetime

Agent Controller assigns one bounded deadline from
`ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL` (default `30m`). Expiration never
releases occupancy by itself because it does not prove that a dispatched Tool
has stopped. Agent ACP Service must recover the Run and call `finish_run`; an
unknown Tool effect remains blocked. Only a `runtime_mcp` effect can later use
the Runtime-absence barrier. Client MCP and unclassified effects remain
fail-closed pending an explicit recovery decision. The deadline bounds model
and Tool calls, not the durability of the admission fact.
