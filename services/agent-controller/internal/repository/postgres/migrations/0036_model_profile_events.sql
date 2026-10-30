CREATE TABLE agent_controller.model_profile_events (
    organization_id TEXT NOT NULL,
    model_profile_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 2 AND revision <= 9007199254740991),
    previous_revision BIGINT NOT NULL CHECK (previous_revision >= 1 AND revision = previous_revision + 1),
    revision_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    occurred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (organization_id, model_profile_id, revision),
    FOREIGN KEY (model_profile_id) REFERENCES agent_controller.model_profiles(id)
);
