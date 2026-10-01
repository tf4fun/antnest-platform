-- Metadata-only durable heads double as a bounded, coalescing delivery outbox.
-- Candidate bytes remain in the existing Agent-owned learning store.
CREATE TABLE skill_source_projections (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    name text NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
    owner_id text NOT NULL,
    description text NOT NULL CHECK (octet_length(description) BETWEEN 1 AND 512),
    sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
    content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
    active boolean NOT NULL,
    candidate_id text NOT NULL REFERENCES learning_candidates(candidate_id) ON DELETE RESTRICT,
    sent_sequence bigint NOT NULL DEFAULT 0 CHECK (sent_sequence >= 0),
    failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 10),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,agent_id,name)
);
CREATE INDEX skill_source_projections_due_idx ON skill_source_projections (next_attempt_at,organization_id,agent_id,name);
