# Session Configuration Authority

Status: F05 Controller service batch accepted on 2026-09-09. ACP consumption, protocol option
notifications, Session persistence and permission execution were delivered in
separate F05/F06 batches and Gateway/Runtime integration. See
[ACP conformance](../../agent-acp-service/docs/protocol-conformance.md) for their
final evidence; this document describes Controller ownership.

## Ownership

Controller owns organization model availability, independent immutable model and credential
revisions and Agent default authorization. ACP owns Session overrides. No service
reads the other's tables. Session settings never rebuild a Runtime or change an
Agent/template model. Internal RPC callers are trusted services; these routes are
not public management APIs.

`get-session-configuration` and `set-agent-authorization` use the same
`request_id`, `agent_id`, `principal_id`, `expected_access_revision` identity as
Run admission. The principal must be the active Agent owner, with current Identity
membership and a live access binding. Clients cannot choose an organization to
widen the model directory. Gateway administrator editing is not added in this batch.

## RPC Contract

1. `POST /rpc/agent-controller/get-session-configuration`: optional `after_id`
   and `limit` (default 100, maximum 200). Returns `models`, `next_cursor`,
   `default_model` and `default_authorization` with `authorization_revision`.
   Models contain stable `model_profile_id`, current `revision_id`, `display_name`,
   model identifier, context/output limits, native input capabilities and
   optional pricing, never endpoints or
   credential identifiers/secrets. Enabled profiles of the Agent organization are
   selectable, including other Providers. Pagination does not make a multi-page
   catalog an atomic snapshot: admission always validates the chosen model again.
   `default_model` describes the current revision of the Agent's stable model identity;
   model and Provider connection must both be enabled. An unavailable default does not prevent
   reading alternatives or selecting one.
2. `POST /rpc/agent-controller/set-agent-authorization`: identity fields plus
   `expected_authorization_revision` and full `authorization` value. CAS updates
   Agent defaults and emits `agent_authorization_updated`; no Runtime call or
   access revision change. Stale CAS returns `configuration_conflict`; caller
   reloads before retrying, rather than treating request ID as a replay ledger.
   The event identity derives from Agent + authorization revision, so reusing
   a request ID after reloading does not collide with a committed event.
   `tool_rules` must be an explicit array; missing/null is not an erase command.
   Active Runs are not rewritten. Busy/rebuilding Agents may change preferences;
   deleted Agents and revoked/inactive owners may not.
3. `POST /rpc/agent-controller/acquire-run`: add optional
   `session_configuration`: `model_profile_id`, `authorization_mode`, `tool_rules`.
   Omitted model/mode inherit; explicit empty identifiers/modes are invalid.
   Rules override matching Agent defaults by exact `(source, source_id, tool_name)`;
   an empty list has no overrides, not a request to erase Agent defaults.
   Authorization modes: `auto`, `approve`, `smart_approve`, `chat`; Agent default
   is `auto` with no rules. Rule decisions are `allow` or `deny`, with no wildcard.
   Default rules and Session overrides each allow at most 128 entries; the merged
   effective snapshot can contain up to 256 distinct rules. Null optional
   selections mean inheritance, like omission; an empty object is still a distinct
   request payload for idempotency from an omitted `session_configuration`.
   `chat` means no tools, not read-only bash. These are execution preferences,
   never platform resource permissions. ACP enforces them through its F05/F06
   configuration and permission execution paths.

New admissions return `execution_spec.configuration` containing the effective
authorization, its default revision, resolved profile/revision identifiers and
`digest`. The digest covers actual model configuration and effective authorization, separate from `agent_execution_spec_digest` (the
unchanged Agent build spec). Model revision or authorization changes therefore
remain visible even when Runtime and Agent spec revisions are unchanged.
The ACP decoder is strict: deploy matching contract/consumer versions together.
The P2 producer uses Run contract revision 13; ACP and Console template consumers
remain separate pending batches. Historical F05 integration does not prove the
new Provider contract.

## Admission Boundary

Within the existing Agent admission transaction, validate identity/access and
occupancy, lock the chosen model head, resolve its immutable revision, and freeze
the full model + Provider binding + authorization snapshot. Explicit selection and
inheritance both resolve the current model head. Model and connection must be
enabled and owned by the organization. Unknown,
foreign or disabled profiles return `model_unavailable`, with no fallback.
Credential resolution authorizes the frozen Provider connection and returns its
current credential version. Rotation never modifies the admission or its digest.
Model-head updates/disable serialize with admission through a row lock.

An identical request replays its original snapshot even after defaults/catalog
change. Different overrides with the same request ID conflict. This is replay of
an already accepted admission, not permission for another execution. ACP retains
its existing current-access checks and durable Run replay rules.

```mermaid
sequenceDiagram
    participant ACP as ACP service
    participant C as Agent Controller
    participant I as Identity Service
    participant DB as Controller PostgreSQL
    ACP->>C: get-session-configuration (Agent owner binding)
    C->>I: Resolve current organization principal
    C->>DB: Recheck binding and read safe model options/defaults
    C-->>ACP: Options + current default + authorization revision
    Note over ACP: Persist Session selection in ACP storage
    ACP->>C: acquire-run (selected profile, mode/rule overrides)
    C->>I: Revalidate owner for a new admission
    C->>DB: Lock Agent and model head; freeze complete Run snapshot
    DB-->>C: Committed admission
    C-->>ACP: Effective configuration + Runtime binding
    ACP->>C: resolve-credential (admission, authorized connection)
    C-->>ACP: Current credential + actual version
```

## Persistence And Observability

Only `agent_controller` is accessed. `agents.default_authorization` and
`agents.authorization_revision` hold defaults; `run_admissions.snapshot` holds
the resolved configuration. No Session table or duplicate model allowlist is added.
The existing event journal records default revision changes with actor/Agent and
trace identity, not rule bodies. HTTP and automatic PostgreSQL driver spans
retain parent trace context; HTTP classifies business outcomes while driver
spans report database errors. RPC boundaries may optionally capture full
request/response bodies, including secrets; SQL bind parameters and result
bodies are not duplicated in driver spans. SQL text and driver diagnostics
follow the limits in [observability](observability.md).

## Acceptance

1. Unit tests: bounded modes/rules, exact-source override, no input mutation,
   missing versus invalid overrides, deterministic digest and request fingerprints.
2. RPC/application tests: strict fields, live owner checks, sanitized options,
   error codes, propagation of overrides, trace parenting and no payload leakage.
3. PostgreSQL component tests: same-organization cross-Provider selection,
   foreign/disabled denial, inherited and explicit current-head selection,
   credential isolation, replay immutability, CAS and active-Run defaults isolation.
4. Existing Controller lifecycle, identity, admission and schema suites regress.
   Root formatting/lint gates run serially. No external Provider is needed.
5. ACP consumer tests separately prove persisted Session selections, v1/v2
   option/mode responses and updates, and execution-snapshot consumption.
   Gateway/Runtime/Jaeger integration and F06 permission requests/responses are
   recorded in ACP conformance. Storing modes alone is not approval enforcement.

Prior session-configuration verification, before the driver migration: all 13 Controller Go packages passed normal and race
runs, with PostgreSQL integration enabled against a dedicated role/database on
the shared development PostgreSQL instance. The HTTP component fixture verifies
incoming context propagation into the Controller repository; this is not
a new Gateway/Jaeger deployment report. `make fmt-check`, `make lint` (Go: zero
issues; both Rust Clippy and TypeScript checks passed) and `git diff --check`
passed. Reviewers were read-only and closed after reporting. No external model
Provider was called; the two existing acceptance stacks were not rebuilt.
Those results do not validate the subsequent driver instrumentation change;
its PostgreSQL and admission checks await coordinator execution.
