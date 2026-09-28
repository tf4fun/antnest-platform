CREATE TABLE agent_controller.legacy_source_recoveries (
    request_id TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    organization_id TEXT NOT NULL,
    actor_principal_id TEXT NOT NULL,
    admitted_agent_sequence BIGINT NOT NULL CHECK (admitted_agent_sequence > 0),
    source_spec_revision_id TEXT NOT NULL,
    source_runtime_revision TEXT NOT NULL,
    observed_runtime_execution_id TEXT NOT NULL,
    observed_attachment_version BIGINT NOT NULL CHECK (observed_attachment_version > 0),
    closed_attachment_version BIGINT NOT NULL DEFAULT 0 CHECK (closed_attachment_version >= 0),
    child_request_id TEXT NOT NULL,
    drain_deadline_at TIMESTAMPTZ NOT NULL,
    disabled_runtime_revision TEXT NOT NULL DEFAULT '',
    disabled_runtime_result JSONB,
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'manual_recovery_required')),
    phase TEXT NOT NULL CHECK (phase IN ('drain', 'network_fence', 'disable_runtime', 'publish', 'done')),
    error_code TEXT NOT NULL DEFAULT '',
    manual_reason TEXT NOT NULL DEFAULT '' CHECK (manual_reason IN ('', 'drain_not_settled', 'runtime_disable_rejected', 'network_attachment_changed', 'publication_conflict')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK ((state = 'completed') = (phase = 'done')),
    CHECK ((state = 'manual_recovery_required') = (error_code = 'legacy_source_manual_recovery_required')),
    CHECK ((state = 'manual_recovery_required') = (manual_reason <> '')),
    CHECK ((phase IN ('drain', 'network_fence', 'disable_runtime')) = (disabled_runtime_result IS NULL)),
    CHECK ((disabled_runtime_result IS NULL) = (disabled_runtime_revision = ''))
);

CREATE UNIQUE INDEX legacy_source_recoveries_active_agent_idx
    ON agent_controller.legacy_source_recoveries(agent_id)
    WHERE state = 'running';

ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_type_known;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_type_known CHECK (event_type IN (
    'agent_create_requested', 'agent_created', 'agent_ready', 'agent_build_failed',
    'agent_rebuild_requested', 'agent_rebuilt', 'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
    'agent_enable_requested', 'agent_enabled', 'agent_enable_failed', 'agent_delete_requested', 'agent_deleted',
    'agent_lifecycle_quarantined', 'agent_runtime_restarted', 'agent_runtime_missing', 'agent_runtime_condition_changed',
    'agent_owner_revoked', 'agent_authorization_updated', 'agent_legacy_proof_loss_recovered', 'agent_legacy_source_recovered'
));
