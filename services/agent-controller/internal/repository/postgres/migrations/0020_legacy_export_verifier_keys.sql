CREATE TABLE agent_controller.legacy_export_verifier_keys (
    key_id TEXT PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
    public_key BYTEA NOT NULL UNIQUE CHECK (octet_length(public_key) = 32),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);
