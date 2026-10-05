ALTER TABLE oidc_providers
    ADD COLUMN client_secret_key_id TEXT NOT NULL DEFAULT 'local-v1',
    ADD COLUMN client_secret_wrapped_data_key BYTEA;

ALTER TABLE oidc_auth_sessions
    ADD COLUMN secret_key_id TEXT NOT NULL DEFAULT 'local-v1',
    ADD COLUMN secret_wrapped_data_key BYTEA;
