CREATE TABLE agent_controller.identity_revocation_cursor (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);
INSERT INTO agent_controller.identity_revocation_cursor (singleton) VALUES (TRUE);

CREATE TABLE agent_controller.owner_revocations (
    user_id TEXT NOT NULL CHECK (user_id <> ''),
    organization_id TEXT NOT NULL DEFAULT '',
    sequence BIGINT NOT NULL UNIQUE CHECK (sequence > 0),
    reason TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    trace_parent TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, organization_id),
    CHECK ((reason = 'user_deactivated' AND organization_id = '') OR
           (reason IN ('membership_deactivated', 'membership_deleted') AND organization_id <> ''))
);

ALTER TABLE agent_controller.agents
    ADD COLUMN owner_authorization_sequence BIGINT NOT NULL DEFAULT 0 CHECK (owner_authorization_sequence >= 0),
    ADD COLUMN identity_revocation_sequence BIGINT NOT NULL DEFAULT 0 CHECK (identity_revocation_sequence >= 0);
CREATE INDEX agents_owner_revocation_pending_idx ON agent_controller.agents (id)
    WHERE identity_revocation_sequence > owner_authorization_sequence
      AND lifecycle_state NOT IN ('deleted', 'disabled');

ALTER TABLE agent_controller.agent_lifecycle_operations
    ADD COLUMN owner_revocation_sequence BIGINT NOT NULL DEFAULT 0
    CHECK (owner_revocation_sequence >= 0 AND (owner_revocation_sequence = 0 OR kind = 'disable'));
CREATE INDEX owner_disable_retry_cooldown_idx
    ON agent_controller.agent_lifecycle_operations (agent_id, owner_revocation_sequence, updated_at DESC)
    WHERE kind = 'disable' AND state = 'failed';

ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_type_known;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_type_known CHECK (event_type IN (
    'agent_create_requested', 'agent_ready', 'agent_build_failed',
    'agent_rebuild_requested', 'agent_rebuilt',
    'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
    'agent_enable_requested', 'agent_enabled', 'agent_enable_failed',
    'agent_delete_requested', 'agent_deleted',
    'agent_lifecycle_quarantined', 'agent_runtime_restarted', 'agent_owner_revoked'
));
