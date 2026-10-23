-- A binding's threshold is an organization publication revision, never the
-- Agent-local execution counter. Historical v1 ready events remain history.
CREATE TABLE agent_controller.agent_runtime_readiness (
    agent_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    execution_revision_id TEXT NOT NULL REFERENCES agent_controller.execution_revisions(id),
    agent_spec_revision_id TEXT NOT NULL REFERENCES agent_controller.agent_spec_revisions(id),
    runtime_revision TEXT NOT NULL CHECK (runtime_revision <> ''),
    runtime_execution_id TEXT NOT NULL CHECK (runtime_execution_id <> ''),
    owner_user_id TEXT NOT NULL CHECK (owner_user_id <> ''),
    access_revision TEXT NOT NULL CHECK (access_revision <> ''),
    owner_authorization_sequence BIGINT NOT NULL CHECK (owner_authorization_sequence >= 0),
    ready_after_revision BIGINT NOT NULL CHECK (ready_after_revision BETWEEN 1 AND 9007199254740991),
    reopen_after_revision BIGINT NOT NULL DEFAULT 0 CHECK (
        reopen_after_revision = 0 OR reopen_after_revision BETWEEN ready_after_revision AND 9007199254740991
    ),
    applied_revision BIGINT CHECK (applied_revision BETWEEN ready_after_revision AND 9007199254740991),
    bound_at TIMESTAMPTZ NOT NULL,
    ready_at TIMESTAMPTZ,
    PRIMARY KEY (agent_id, execution_revision_id),
    FOREIGN KEY (agent_id, organization_id) REFERENCES agent_controller.agents(id, organization_id),
    CHECK ((applied_revision IS NULL) = (ready_at IS NULL))
);

ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_schema_version_check;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_schema_version_check CHECK (
    (schema_version = 1 AND event_type <> 'runtime_bound') OR
    (schema_version = 2 AND event_type IN ('runtime_bound', 'agent_ready'))
);
ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_type_known;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_type_known CHECK (event_type IN (
    'agent_create_requested', 'agent_created', 'agent_ready', 'agent_build_failed',
    'agent_rebuild_requested', 'agent_rebuilt', 'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
    'agent_enable_requested', 'agent_enabled', 'agent_enable_failed', 'agent_delete_requested', 'agent_deleted',
    'agent_lifecycle_quarantined', 'agent_runtime_restarted', 'agent_runtime_missing', 'agent_runtime_condition_changed',
    'agent_owner_revoked', 'agent_authorization_updated', 'agent_runtime_barrier_required', 'runtime_bound'
));
