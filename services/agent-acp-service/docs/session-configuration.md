# Session Configuration

ACP owns Session overrides, not management of the organization model catalog,
Agent defaults, credentials or Runtime lifecycle. Controller publishes current
configuration through the [execution snapshot contract](../../../contracts/agent-acp/execution-api.md).
The [execution-boundary batch](execution-configuration.md) is not yet accepted
as a complete platform deployment.

## Boundaries

1. New/load/resume/fork return the current configuration. Read all enabled
   organization models from the complete local directory; never expose
   credentials or provider endpoints. Model option IDs are `profile:<id>`;
   `agent_default` means inherit the Agent's configured default, not the catalog head.
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
   Database CAS is the persistence authority. A short per-organization boundary
   orders local configuration commits against access publication. Model calls,
   Runtime work and user approval never hold that boundary. Each response is the snapshot of its own operation, while
   notifications follow the committed Session sequence. JSON-RPC concurrent or
   batched responses are not a last-arrival-wins state feed: clients correlate
   request IDs and serialize their own edits. Read fresh configuration on resume.
   Replacing output subscriptions never rewinds a delivered cursor; the new
   sender's own-message filter also applies to a pending old read.
5. Capture overrides under the Session lock in `runs.session_configuration` when
   creating the local Run intent. The accepted execution configuration and digest
   are retained as audit facts, independent of the Agent build digest. Startup
   cleanup never resends a captured payload or executes the latest Session
   selection. A new admission without the required configuration rejects.
6. Chat supplies no tools, including the local plan tool. Auto permits execution.
   Approve/SmartApprove honor exact-source allow/deny rules. F06 now supplies
   [permission interaction](tool-permissions.md); missing clients never imply
   approval. Smart Approve conservatively trusts non-conflicting read-only hints.
   Session-only always rules are not copied by Fork; model/mode overrides are.

## Verification

Cover snapshot publication and completeness, inherited versus
explicit selections, ownership denial, revision conflicts, Session restart/fork,
preserved audit configuration after a concurrent setting change, v1/v2 option responses and
notifications, the v1 mode alias, unchanged active snapshots, Chat tool
exclusion and authorization rules. Use deterministic component tests and real
PostgreSQL tests before the separate Gateway/Runtime/Jaeger integration batch.

Configuration operations have ACP and local database spans. Attributes identify
Agent/Session/request and operation only; rule bodies and secrets are not logged.
Configuration writes use transaction-local 5s lock and 10s statement timeouts;
a blocked write rolls back its event and releases the local publication boundary.

Prior deployed-baseline evidence (2026-09-09), not acceptance of the boundary refactor:
401 ACP unit/component tests and 114 PostgreSQL
protocol/integration tests pass. The full Node admission suite passes 725 tests,
including Console, Agent UI and shared test oracles. No external Provider or
new Gateway/Jaeger deployment was exercised in this batch.
