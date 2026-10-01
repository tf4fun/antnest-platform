CREATE TABLE learning_apply_bases (
    candidate_id text PRIMARY KEY REFERENCES learning_candidates(candidate_id) ON DELETE RESTRICT,
    task_id text NOT NULL REFERENCES learning_tasks(id) ON DELETE RESTRICT,
    check_request_id text NOT NULL REFERENCES learning_maintenance_intents(request_id) ON DELETE RESTRICT,
    policy_revision text NOT NULL CHECK (policy_revision ~ '^[0-9a-f]{64}$'),
    package_path text NOT NULL CHECK (package_path ~ '^\.antnest/skills/[a-z0-9]+(-[a-z0-9]+)*$'),
    expected_base_digest text CHECK (expected_base_digest IS NULL OR expected_base_digest ~ '^sha256:[0-9a-f]{64}$'),
    target_digest text NOT NULL CHECK (target_digest ~ '^sha256:[0-9a-f]{64}$'),
    evidence_ids text[] NOT NULL CHECK (cardinality(evidence_ids) BETWEEN 1 AND 64),
    execution_id text NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 200),
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learning_managed_skills (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    owner_principal_id text NOT NULL,
    package_path text NOT NULL CHECK (package_path ~ '^\.antnest/skills/[a-z0-9]+(-[a-z0-9]+)*$'),
    origin text NOT NULL CHECK (origin IN ('auto_generated','adopted')),
    state text NOT NULL CHECK (state IN ('active','paused')),
    last_digest text NOT NULL CHECK (last_digest ~ '^sha256:[0-9a-f]{64}$'),
    last_candidate_id text REFERENCES learning_candidates(candidate_id) ON DELETE RESTRICT,
    policy_revision text NOT NULL CHECK (policy_revision ~ '^[0-9a-f]{64}$'),
    pause_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,agent_id,package_path),
    CHECK ((state='paused' AND pause_reason IS NOT NULL) OR (state='active' AND pause_reason IS NULL))
);
