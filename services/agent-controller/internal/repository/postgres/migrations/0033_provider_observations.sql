CREATE TABLE agent_controller.provider_observations (
    connection_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    source_revision BIGINT NOT NULL CHECK (source_revision >= 1 AND source_revision <= 9007199254740991),
    provider_key TEXT NOT NULL,
    request_protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    credential_revision TEXT NOT NULL,
    models JSONB NOT NULL CHECK (jsonb_typeof(models) = 'array'),
    FOREIGN KEY (connection_id, organization_id)
        REFERENCES agent_controller.provider_connections (id, organization_id)
);
