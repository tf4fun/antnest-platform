ALTER TABLE acp_sessions
    ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(configuration) = 'object'),
    ADD COLUMN configuration_revision bigint NOT NULL DEFAULT 0 CHECK (configuration_revision >= 0);

-- NULL preserves the exact request envelope of pre-configuration admission intents.
ALTER TABLE runs ADD COLUMN session_configuration jsonb
    CHECK (session_configuration IS NULL OR jsonb_typeof(session_configuration) = 'object');
