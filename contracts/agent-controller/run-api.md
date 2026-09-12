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

F05 adds the owner-scoped Session configuration directory and Agent default
authorization CAS. Controller production, ACP consumption and the scoped
Gateway/Runtime deployment profile have passed; later capability/pricing
extensions are included in the current machine contract. The machine-readable
request and response shapes are in
[`run-contract.json`](run-contract.json).

## Identity Changes And Lifecycle State

Identity authorization and Agent lifecycle are separate authorities. A valid
Agent access binding is necessary but does not override an inactive or missing
organization Membership. Both `resolve_agent_access` and every new `acquire_run`
read the current organization principal, fail closed on Identity dependency
failure, and leave lifecycle state, executable revisions and access bindings
unchanged on rejection. No Identity event delivery is needed for these checks.

If Identity access is restored and Agent Controller's own binding and Runtime
are still available, a new Run can use them without a rebuild or access-revision
change. An explicitly disabled/deleted Agent or revoked binding remains
unusable: Identity reactivation is not an Agent enable command. Ownership uses
the stable User/Organization pair, not the replaceable Membership ID or profile.

The preceding describes synchronous admission checks. The separate implemented
offboarding workflow consumes owner revocations and disables associated Agents
and Runtime with retained data. The
[revocation contract](../identity/principal-revocations.md) records its producer,
consumer and scoped C2-05 integration acceptance. Once consumed, restoration
must not automatically undo that disable; uncertain Runtime effects remain
fenced/pending instead of being reported as stopped.

An exact retry of a committed admission returns the original snapshot, not a
second authorization or a new Run. Admission-scoped credential resolution and
`finish_run` continue to use the existing admission, without requiring current
owner activity. This lets already-admitted work release its occupancy even when
Identity changes or is unavailable; it does not promise completion despite
other failures or bypass ACP's own request-time checks. Identity validation and
the local admission commit are not one cross-service transaction: a concurrent
Identity change can overlap an admission that was just validated.

Replaying admission is not necessarily a history-only read. If Controller
committed admission but ACP was interrupted before accepting it, ACP recovery
can obtain that snapshot and start its first model/Tool execution after the
Identity change. This is an already-committed admission, not a fresh admission
for a new request ID. Do not describe Identity deactivation as an immediate
execution, background-process, or credential-revocation barrier.

## Trust And Identity

The caller is an internal service on a trusted deployment network. Transport
authentication is intentionally deferred to Edge Gateway. Domain
authorization is not deferred: `resolve_agent_access` maps an opaque,
Agent-scoped access subject to exactly one principal and Agent. The subject is
not a general user bearer token and must not select an Agent through ACP
Session parameters.

An ACP connection binds the returned `principal_id`, `agent_id`, and
`access_revision` for its lifetime. Agent ACP Service calls
`resolve_agent_access` before Session-management operations. Prompt admission
instead validates the same binding through authoritative `acquire_run`, without
a duplicate preliminary access call. A changed binding rejects the old
connection. Agent Controller must advance the
revision whenever access or Agent mapping changes. Image/audio input availability
includes only enabled organization model heads on enabled Provider connections,
not stale access-binding flags or arbitrary historical revisions. Audio is an
optional boolean (omitted means false). Embedded context is declared for built-in
UTF-8 text, not universal binary support. This metadata is not an access grant.
ACP must validate `supports_images`, optional `supports_audio` and `supports_pdf`
(omitted means false) from each admitted model snapshot. See
[multimodal authority](../../services/agent-controller/docs/multimodal-input.md).
An
existing Session also stores the principal/Agent pair; remapping cannot
silently move a Session to another Agent.

## Methods

### Session Configuration

`get_session_configuration` returns a sanitized, paginated organization model
directory plus Agent default authorization. `set_agent_authorization` updates
defaults with a revision CAS, without Runtime changes or modifying active Runs.
Both require a current Agent owner binding and Identity membership. See the
[service contract and sequence](../../services/agent-controller/docs/session-configuration.md)
for exact ownership, inheritance and errors.

`acquire_run.session_configuration` optionally selects a model profile and
overrides authorization. New admissions return `execution_spec.configuration`;
its digest identifies the effective model/authorization, separately
from the unchanged Agent build digest. Omitted configuration on historical
admission replay remains valid. Clients must not substitute current settings
into an already accepted Run. Admission deadlines are rendered in UTC.

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

The optional `execution_spec.model.pricing` contains frozen USD per-million-token
input/output rates and optional cache-read/cache-write rates. Both ordinary
rates are required when present; explicit zero is valid, absence is unknown.
The selected model revision is the only authority. Session callers cannot
submit rates. Revising a Model Profile does not reprice an admitted Run or an
Agent's build audit snapshot. Default and explicit model selections both take the
current enabled head at the next admission. Recovery and replay return the originally saved
rates; ACP may use them for cost estimates, not invoicing.

The snapshot includes one opaque Runtime revision, MCP endpoint, and execution
identity. Physical Runtime generation and instance identifiers are private to
Runtime Controller and never appear here. Agent ACP Service must never discover
or refresh that endpoint through Docker, Kubernetes, Runtime Controller, or DNS
metadata.

The response also freezes `runtime_mcp_source_digest`,
`agent_execution_spec_digest` and `context_policy_version`. It also freezes
`execution_spec.provider`: `connection_id`, `provider_key`,
`credential_method`, `request_protocol`. Only DeepSeek / api_key /
openai_chat_completions is currently supported. Stage 2 supports `context-v1`;
unknown protocol/Provider combinations fail rather than falling back. Credential
versions are not execution configuration and are not returned by admission.

### `resolve_credential`

Accepts `admission_id` and `provider_connection_id`. The connection must match
the admitted Provider binding, belong to the Agent organization and be enabled.
Admission must be active/unexpired and retain its current owner/access binding.
The response contains `provider`, the actual `credential_version`,
`secret_type=bearer` and `secret`. It reads the current credential at each
resolution: rotation does not invalidate the model snapshot or require rebuilding
the Agent/Runtime. Consumers must resolve again before a later model call, not
cache the initial key for the entire Run or compare it to a build-time version.
This is a local lookup, not a remote authentication refresh.

Secrets must not enter ACP persistence, errors or Tool results. Development full
RPC payload capture can include them in local Jaeger, as explicitly configured in
the shared observability policy; repository spans do not collect secret bodies.

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
| `model_unavailable`      | no      | Select another enabled model from the Agent organization                 |
| `configuration_conflict` | reload  | Authorization CAS is stale; reload before issuing a new revision update  |
| `invalid_request`        | no      | Request shape or immutable terminal facts violate the contract           |
| `dependency_unavailable` | yes     | A required service could not provide a trustworthy response; retry later |
| `internal_error`         | yes     | Request outcome is unknown unless the method is retried with the same ID |

## Compatibility Rules

1. This document and machine catalog describe contract revision 13. P2 updates
   the Controller producer only; the matching ACP consumer remains pending.
   Do not deploy mixed versions. The current
   strict ACP consumer must be upgraded before deployment with this producer.
2. Contract fields are `snake_case`; ACP wire fields remain the ACP-defined
   `camelCase` shapes.
3. New optional response fields may be added. Existing required fields cannot
   change meaning.
4. Secrets cannot be added to `acquire_run` merely to remove one RPC.
5. Contract fixtures complement Controller HTTP/PostgreSQL tests and deployment
   integration. A fake is not an alternate production authority.
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
