CREATE TABLE agent_controller.legacy_skill_migration_bindings (
    operation_request_id TEXT PRIMARY KEY REFERENCES agent_controller.agent_lifecycle_operations(request_id),
    agent_id TEXT NOT NULL REFERENCES agent_controller.legacy_system_skills_migrations(agent_id),
    choice_request_id TEXT NOT NULL REFERENCES agent_controller.legacy_system_skill_choices(request_id),
    choice_sequence BIGINT NOT NULL CHECK (choice_sequence > 0),
    key_id TEXT NOT NULL REFERENCES agent_controller.legacy_export_verifier_keys(key_id),
    attestation BYTEA NOT NULL CHECK (octet_length(attestation) BETWEEN 1 AND 8192),
    attestation_digest TEXT NOT NULL CHECK (attestation_digest ~ '^[0-9a-f]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (agent_id, operation_request_id)
);
