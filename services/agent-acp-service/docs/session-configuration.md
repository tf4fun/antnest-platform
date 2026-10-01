# Session Configuration

This document covers Session-scoped configuration options: model, thinking
effort and authorization mode overrides.

ACP owns Session overrides, not management of the organization model catalog,
Agent defaults, credentials or Runtime lifecycle. Controller publishes current
configuration through the [execution snapshot contract](../../../contracts/agent-acp/execution-api.md);
see [local execution configuration](execution-configuration.md) for how ACP applies it.

## Boundaries

1. New/load/resume/fork return the current configuration. Read all enabled
   organization models from the complete local directory; never expose
   credentials or provider endpoints. Model option IDs are `profile:<id>`;
   `agent_default` means inherit the Agent's configured default, not the catalog head.
2. `session/set_config_option` changes model, thinking effort or authorization mode. The v1
   `session/set_mode` adapter uses the same application command. There is no
   standard `session/set_model` method in the pinned SDK. `agent_default` clears that
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
   Approve/SmartApprove honor exact-source allow/deny rules and use
   [permission interaction](tool-permissions.md); missing clients never imply
   approval. Smart Approve conservatively trusts non-conflicting read-only hints.
   Session-only always rules are not copied by Fork; model/mode/thinking overrides are.

Provider-grouped model options and capability-driven `thinking_effort` are defined
in [Session model selection](session-model-selection.md). Their values are
Session-scoped, not Agent template or credential changes.

## Bridge Conditional Writes

The principal-scoped execution observation returns a non-null opaque
`configurationRevision` derived from the Session's persisted configuration
revision. When a Bridge client supplies
`session/set_config_option.params._meta["antnest.dev/configuration"].expectedRevision`,
ACP verifies that exact durable revision after access checks and before
changing the option. The repository's numeric revision CAS also rejects a
concurrent winner between the read and the write. The negotiated Bridge
capability advertises `configurationCas: 1`; standard ACP clients without the
metadata keep the ordinary method behavior. The
[shared contract](../../../contracts/agent-acp/workspace-bridge.md) fixes the
digest and error semantics.

The ACP service unit, SDK transport, isolated PostgreSQL and production-image
Docker tests cover the condition, stale writes and revision changes. The
production-image test races two independent ACP connections on one revision
and verifies one winner and one persisted increment. The Node
Bridge consumer forwards the observed producer revision and rejects writes
when the producer lacks the negotiated capability. The cross-service
Docker/Chromium regression races two separate Node Bridge owners, checks one
successful write and one conflict, then confirms both views show the winner.

## Verification

Tests cover snapshot publication and completeness, inherited versus
explicit selections, ownership denial, revision conflicts, Session restart/fork,
preserved audit configuration after a concurrent setting change, v1/v2 option responses and
notifications, the v1 mode alias, unchanged active snapshots, Chat tool
exclusion and authorization rules. They use deterministic component tests and
real PostgreSQL tests; Gateway/Runtime/Jaeger coverage comes from the
[tool permission deployment profile](../../../tests/e2e/acp-permissions/README.md).

Configuration operations have ACP and local database spans. Attributes identify
Agent/Session/request and operation only; rule bodies and secrets are not logged.
Configuration writes use transaction-local 5s lock and 10s statement timeouts;
a blocked write rolls back its event and releases the local publication boundary.
