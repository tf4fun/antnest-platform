-- Tombstones retain their version so older ACP results cannot erase a newer
-- barrier or resurrect one after a newer clear.
CREATE TABLE agent_controller.runtime_barrier_recovery_observations (
    agent_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    observation_revision BIGINT NOT NULL CHECK (observation_revision > 0),
    barrier_id BYTEA CHECK (octet_length(barrier_id) BETWEEN 1 AND 800),
    runtime_execution_id BYTEA CHECK (octet_length(runtime_execution_id) BETWEEN 1 AND 800),
    runtime_revision TEXT NOT NULL CHECK (runtime_revision <> ''),
    agent_spec_revision_id TEXT NOT NULL CHECK (agent_spec_revision_id <> ''),
    execution_revision_id TEXT NOT NULL,
    access_revision TEXT NOT NULL CHECK (access_revision <> ''),
    owner_user_id TEXT NOT NULL CHECK (owner_user_id <> ''),
    owner_authorization_sequence BIGINT NOT NULL CHECK (owner_authorization_sequence >= 0),
    identity_revocation_sequence BIGINT NOT NULL CHECK (identity_revocation_sequence >= 0),
    policy_revision BIGINT NOT NULL CHECK (policy_revision BETWEEN 0 AND 9007199254740991),
    policy_mode TEXT NOT NULL CHECK (policy_mode IN ('auto', 'notify', 'manual')),
    policy_cooldown_ms BIGINT NOT NULL CHECK (policy_cooldown_ms BETWEEN 60000 AND 86400000),
    observed_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (agent_id, organization_id) REFERENCES agent_controller.agents(id, organization_id),
    CHECK ((barrier_id IS NULL) = (runtime_execution_id IS NULL))
);

-- Notification deduplication is independent of recovery operations. Journal
-- JSONB stores the other four public fields; readers join the opaque BYTEA ID.
CREATE TABLE agent_controller.runtime_barrier_recovery_notifications (
    organization_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    barrier_id BYTEA NOT NULL CHECK (octet_length(barrier_id) BETWEEN 1 AND 800),
    event_id TEXT NOT NULL UNIQUE REFERENCES agent_controller.agent_events(event_id),
    runtime_revision TEXT NOT NULL CHECK (runtime_revision <> ''),
    policy_revision BIGINT NOT NULL CHECK (policy_revision BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (organization_id, agent_id, barrier_id),
    FOREIGN KEY (agent_id, organization_id) REFERENCES agent_controller.agents(id, organization_id)
);

ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_type_known;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_type_known CHECK (event_type IN (
    'agent_create_requested', 'agent_created', 'agent_ready', 'agent_build_failed',
    'agent_rebuild_requested', 'agent_rebuilt', 'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
    'agent_enable_requested', 'agent_enabled', 'agent_enable_failed', 'agent_delete_requested', 'agent_deleted',
    'agent_lifecycle_quarantined', 'agent_runtime_restarted', 'agent_runtime_missing', 'agent_runtime_condition_changed',
    'agent_owner_revoked', 'agent_authorization_updated', 'agent_runtime_barrier_required'
));
