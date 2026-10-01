CREATE TABLE learning_candidates (
    candidate_id text PRIMARY KEY CHECK (length(candidate_id) BETWEEN 1 AND 200),
    task_id text NOT NULL UNIQUE REFERENCES learning_tasks(id) ON DELETE RESTRICT,
    claim_id text NOT NULL,
    generation integer NOT NULL CHECK (generation > 0),
    package_path text NOT NULL CHECK (package_path ~ '^\.antnest/skills/[a-z0-9]+(-[a-z0-9]+)*$'),
    expected_base_digest text CHECK (expected_base_digest IS NULL OR expected_base_digest ~ '^sha256:[0-9a-f]{64}$'),
    target_digest text NOT NULL CHECK (target_digest ~ '^sha256:[0-9a-f]{64}$'),
    artifact_digest text NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    package_rules_version integer NOT NULL CHECK (package_rules_version = 1),
    skill_text text NOT NULL CHECK (octet_length(skill_text) BETWEEN 1 AND 16384),
    artifact bytea NOT NULL CHECK (octet_length(artifact) BETWEEN 1 AND 8388608),
    evidence_ids text[] NOT NULL CHECK (cardinality(evidence_ids) BETWEEN 1 AND 64),
    state text NOT NULL CHECK (state IN ('draft','check_failed','ready_waiting_idle',
        'awaiting_confirmation','applied','rejected','conflict')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
