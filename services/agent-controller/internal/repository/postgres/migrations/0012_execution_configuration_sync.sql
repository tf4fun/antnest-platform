CREATE TABLE agent_controller.execution_configuration_sync (
    organization_id TEXT PRIMARY KEY CHECK (char_length(organization_id) BETWEEN 1 AND 200),
    revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    applied_revision BIGINT NOT NULL DEFAULT 0 CHECK (applied_revision BETWEEN 0 AND revision),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at TIMESTAMPTZ,
    CHECK ((applied_revision = 0) = (applied_at IS NULL))
);
