CREATE TABLE skill_projections (
 organization_id TEXT NOT NULL CHECK (organization_id ~ '^org_[0-9a-f]{32}$'),
 agent_id TEXT NOT NULL CHECK (agent_id ~ '^agent_[0-9a-f]{32}$'),
 name TEXT NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 64 AND name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 owner_id TEXT NOT NULL CHECK (owner_id ~ '^user_[0-9a-f]{32}$'),
 description TEXT NOT NULL CHECK (octet_length(description) BETWEEN 1 AND 512),
 sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
 content_digest TEXT NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
 active BOOLEAN NOT NULL,
 PRIMARY KEY (organization_id,agent_id,name)
);
CREATE INDEX skill_projections_owner_search ON skill_projections (organization_id,owner_id,name) WHERE active;

CREATE TABLE skill_version_sources (
 skill_id TEXT NOT NULL,
 version BIGINT NOT NULL,
 provenance JSONB NOT NULL,
 PRIMARY KEY (skill_id,version),
 FOREIGN KEY (skill_id,version) REFERENCES skill_versions(skill_id,version) ON DELETE RESTRICT
);
