ALTER TABLE runtime_egress.runtime_attachments
    ADD COLUMN tunnel_key_id TEXT,
    ADD CONSTRAINT runtime_attachment_key_format
        CHECK (tunnel_key_id IS NULL OR tunnel_key_id ~ '^rtk_[0-9a-f]{32}$');

CREATE TABLE runtime_egress.runtime_tunnel_keys (
    key_id TEXT PRIMARY KEY CHECK (key_id ~ '^rtk_[0-9a-f]{32}$'),
    agent_id TEXT NOT NULL REFERENCES runtime_egress.agent_networks(agent_id) ON DELETE CASCADE,
    runtime_revision TEXT NOT NULL CHECK (runtime_revision ~ '^rtv_[0-9a-f]{32}$'),
    tunnel_ipv4 INET NOT NULL CHECK (family(tunnel_ipv4)=4 AND masklen(tunnel_ipv4)=32),
    role TEXT NOT NULL CHECK (role IN ('current','candidate')),
    nonce BYTEA NOT NULL CHECK (octet_length(nonce)=12),
    sealed BYTEA NOT NULL CHECK (octet_length(sealed)=112),
    UNIQUE(agent_id,role)
);
