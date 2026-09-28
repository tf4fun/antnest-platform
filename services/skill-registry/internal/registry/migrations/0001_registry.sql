CREATE TABLE skills (
    skill_id TEXT PRIMARY KEY CHECK (skill_id ~ '^skill_[0-9a-f]{32}$'),
    organization_id TEXT NOT NULL CHECK (organization_id ~ '^org_[0-9a-f]{32}$'),
    name TEXT NOT NULL,
    current_version BIGINT NOT NULL CHECK (current_version >= 1),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE INDEX skills_organization_page ON skills (organization_id, skill_id);

CREATE TABLE skill_versions (
    skill_id TEXT NOT NULL REFERENCES skills (skill_id) ON DELETE RESTRICT,
    version BIGINT NOT NULL CHECK (version >= 1),
    metadata JSONB NOT NULL,
    file_manifest JSONB NOT NULL,
    artifact BYTEA NOT NULL CHECK (octet_length(artifact) BETWEEN 1 AND 8388608),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (skill_id, version)
);

CREATE TABLE command_receipts (
    organization_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result JSONB NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, request_id)
);
