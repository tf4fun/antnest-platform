ALTER TABLE agent_controller.agents
    ADD COLUMN default_authorization JSONB NOT NULL DEFAULT '{"mode":"auto","tool_rules":[]}',
    ADD COLUMN authorization_revision BIGINT NOT NULL DEFAULT 1 CHECK (authorization_revision > 0),
    ADD CONSTRAINT agents_authorization_shape CHECK (
        jsonb_typeof(default_authorization) = 'object'
        AND default_authorization ? 'mode' AND default_authorization ? 'tool_rules'
        AND jsonb_typeof(default_authorization->'mode') = 'string'
        AND default_authorization->>'mode' IN ('auto', 'approve', 'smart_approve', 'chat')
        AND jsonb_typeof(default_authorization->'tool_rules') = 'array'
    );

ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_type_known;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_type_known CHECK (event_type IN (
    'agent_create_requested', 'agent_ready', 'agent_build_failed',
    'agent_rebuild_requested', 'agent_rebuilt',
    'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
    'agent_enable_requested', 'agent_enabled', 'agent_enable_failed',
    'agent_delete_requested', 'agent_deleted',
    'agent_lifecycle_quarantined', 'agent_runtime_restarted', 'agent_owner_revoked',
    'agent_authorization_updated'
));
