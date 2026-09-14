ALTER TABLE agent_controller.agents
    ADD COLUMN activation_state TEXT NOT NULL DEFAULT '',
    ADD COLUMN runtime_state TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN runtime_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN runtime_detail TEXT NOT NULL DEFAULT '',
    ADD COLUMN runtime_observed_at TIMESTAMPTZ;

ALTER TABLE agent_controller.agents DROP CONSTRAINT agents_lifecycle_state_check;

UPDATE agent_controller.agents a
SET activation_state = CASE
        WHEN lifecycle_state = 'disabled' THEN 'disabled'
        WHEN lifecycle_state <> 'deleted' AND (
            lifecycle_state = 'available' OR EXISTS (
                SELECT 1 FROM agent_controller.agent_lifecycle_operations op
                WHERE op.agent_id = a.id AND op.kind IN ('create','rebuild','enable','disable') AND op.state = 'completed'
            ) OR EXISTS (SELECT 1 FROM agent_controller.execution_revisions e WHERE e.agent_id = a.id)
        ) THEN 'enabled' ELSE '' END,
    runtime_state = CASE WHEN lifecycle_state = 'available' THEN 'available'
        WHEN lifecycle_state IN ('disabled','deleted') THEN 'absent' ELSE 'unknown' END;

UPDATE agent_controller.agents
SET lifecycle_state = CASE WHEN lifecycle_state = 'deleted' THEN 'deleted'
    WHEN activation_state <> '' THEN 'created' ELSE 'not_created' END;

ALTER TABLE agent_controller.agents
    ADD CONSTRAINT agents_lifecycle_state_check CHECK (lifecycle_state IN ('not_created','created','deleted')),
    ADD CONSTRAINT agents_activation_state_check CHECK (
        (lifecycle_state = 'created' AND activation_state IN ('enabled','disabled')) OR
        (lifecycle_state IN ('not_created','deleted') AND activation_state = '')
    ),
    ADD CONSTRAINT agents_runtime_state_check CHECK (runtime_state IN ('unknown','waiting','available','unhealthy','exited','absent'));

DROP INDEX agent_controller.agents_owner_revocation_pending_idx;
CREATE INDEX agents_owner_revocation_pending_idx ON agent_controller.agents (id)
    WHERE identity_revocation_sequence > owner_authorization_sequence
      AND lifecycle_state <> 'deleted' AND activation_state <> 'disabled';

ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_type_known;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_type_known CHECK (event_type IN (
    'agent_create_requested', 'agent_created', 'agent_ready', 'agent_build_failed',
    'agent_rebuild_requested', 'agent_rebuilt', 'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
    'agent_enable_requested', 'agent_enabled', 'agent_enable_failed', 'agent_delete_requested', 'agent_deleted',
    'agent_lifecycle_quarantined', 'agent_runtime_restarted', 'agent_runtime_missing', 'agent_runtime_condition_changed',
    'agent_owner_revoked', 'agent_authorization_updated'
));
