# Session Configuration

F05 consumer batch: ACP owns Session overrides, not the organization model
catalog, Agent defaults, credentials or Runtime lifecycle. The Controller
[run contract](../../../contracts/agent-controller/run-api.md) is the authority.

## Boundaries

1. New/load/resume/fork return the current configuration. Fetch all enabled
   organization model pages through `get-session-configuration`; never expose
   credentials or provider endpoints. Model option IDs are `profile:<id>`;
   `agent_default` means inherit the Agent's pinned default, not the catalog head.
2. `session/set_config_option` changes model or authorization mode. The v1
   `session/set_mode` adapter uses the same application command. There is no
   standard `session/set_model` method in SDK 1.4.0. `agent_default` clears that
   override through set_config_option. Actual modes remain `auto`,
   `approve`, `smart_approve`, `chat`. No invented boolean setting is advertised.
3. Persist overrides in `acp_sessions.configuration`, with a local revision for
   concurrent update detection. Fork copies overrides; new Sessions start empty.
   Session ownership and live access are checked before catalog access or writes.
   Invalid/disabled selections fail, without silently selecting another model.
4. A configuration write and its ordered Session notification commit together.
   Notifications are configuration state, never LLM conversation content.
   Load/resume return fresh configuration rather than replaying historical choices.
   Changes while a Run is active affect subsequent admissions only.
   Database CAS is the persistence authority; there is no process-wide config
   request queue. Each response is the snapshot of its own operation, while
   notifications follow the committed Session sequence. JSON-RPC concurrent or
   batched responses are not a last-arrival-wins state feed: clients correlate
   request IDs and serialize their own edits. Read fresh configuration on resume.
   Replacing output subscriptions never rewinds a delivered cursor; the new
   sender's own-message filter also applies to a pending old read.
5. Capture overrides under the Session lock in `runs.session_configuration` when
   creating the admission intent. Recovery resends that captured payload, never
   the latest Session selection. The admitted execution configuration and digest
   are retained in the execution snapshot, independent of the Agent build digest.
   A new admission without the required configuration rejects; historical intents
   alone may omit the field so their original request can be replayed unchanged.
6. Chat supplies no tools, including the local plan tool. Auto permits execution.
   Approve/SmartApprove honor exact-source allow/deny rules. F06 now supplies
   [permission interaction](tool-permissions.md); missing clients never imply
   approval. Smart Approve conservatively trusts non-conflicting read-only hints.
   Session-only always rules are not copied by Fork; model/mode overrides are.

## Verification

Cover Controller request/response contract, catalog pagination, inherited versus
explicit selections, ownership denial, revision conflicts, Session restart/fork,
admission recovery after a concurrent setting change, v1/v2 option responses and
notifications, the v1 mode alias, unchanged active snapshots, Chat tool
exclusion and authorization rules. Use deterministic component tests and real
PostgreSQL tests before the separate Gateway/Runtime/Jaeger integration batch.

Configuration operations have ACP and Controller RPC spans. Attributes identify
Agent/Session/request and operation only; rule bodies and secrets are not logged.
Configuration writes use transaction-local 5s lock and 10s statement timeouts;
a blocked write rolls back its event and does not queue later configuration reads.

Service evidence (2026-09-09): 401 ACP unit/component tests and 114 PostgreSQL
protocol/integration tests pass. The full Node admission suite passes 725 tests,
including Console, Agent UI and shared test oracles. No external Provider or
new Gateway/Jaeger deployment was exercised in this batch.
