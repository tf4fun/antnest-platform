CREATE TABLE agent_controller.legacy_system_skill_choices (
    request_id TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    agent_id TEXT NOT NULL REFERENCES agent_controller.legacy_system_skills_migrations(agent_id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    actor_principal_id TEXT NOT NULL CHECK (actor_principal_id <> ''),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    kind TEXT NOT NULL CHECK (kind IN ('empty', 'template_revision')),
    volume_name TEXT NOT NULL CHECK (volume_name <> ''),
    inventory_digest TEXT NOT NULL CHECK (inventory_digest ~ '^sha256:[0-9a-f]{64}$'),
    backup_ref TEXT NOT NULL CHECK (backup_ref <> ''),
    backup_digest TEXT NOT NULL CHECK (backup_digest ~ '^sha256:[0-9a-f]{64}$'),
    template_id TEXT NOT NULL DEFAULT '',
    template_revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (agent_id, sequence),
    CHECK ((kind = 'empty' AND template_id = '' AND template_revision = 0) OR
           (kind = 'template_revision' AND template_id <> '' AND template_revision > 0))
);

CREATE INDEX legacy_system_skill_choices_latest_idx
    ON agent_controller.legacy_system_skill_choices (agent_id, sequence DESC);
