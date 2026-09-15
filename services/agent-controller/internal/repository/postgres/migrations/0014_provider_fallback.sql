ALTER TABLE agent_controller.provider_connections
    DROP CONSTRAINT provider_connections_provider_key_check;
ALTER TABLE agent_controller.provider_connections
    ADD CONSTRAINT provider_connections_provider_key_check
    CHECK (provider_key IN ('deepseek', 'openrouter'));

ALTER TABLE agent_controller.agent_template_revisions
    ADD COLUMN fallback_model_profile_ids TEXT[] NOT NULL DEFAULT '{}';
