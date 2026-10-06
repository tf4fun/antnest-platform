CREATE TABLE agent_controller.managed_mcp_secrets (
    organization_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{8}$'),
    ciphertext BYTEA NOT NULL,
    nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
    key_version TEXT NOT NULL,
    wrapped_data_key BYTEA NOT NULL CHECK (octet_length(wrapped_data_key) > 0),
    PRIMARY KEY (organization_id, template_id, revision, server_id, name),
    FOREIGN KEY (template_id, organization_id, revision)
        REFERENCES agent_controller.agent_template_revisions(template_id, organization_id, revision)
);
