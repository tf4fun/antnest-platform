CREATE TABLE learning_change_sequences (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    last_sequence bigint NOT NULL CHECK (last_sequence >= 1),
    PRIMARY KEY (organization_id,agent_id)
);

CREATE TABLE learning_changes (
    change_id text PRIMARY KEY,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    owner_principal_id text NOT NULL,
    sequence bigint NOT NULL CHECK (sequence >= 1),
    kind text NOT NULL CHECK (kind = 'applied'),
    source_run_id text REFERENCES runs(id) ON DELETE RESTRICT,
    source_session_id text REFERENCES acp_sessions(id) ON DELETE RESTRICT,
    task_id text REFERENCES learning_tasks(id) ON DELETE RESTRICT,
    candidate_id text REFERENCES learning_candidates(candidate_id) ON DELETE RESTRICT,
    effect_request_id text NOT NULL UNIQUE REFERENCES learning_maintenance_intents(request_id) ON DELETE RESTRICT,
    package_path text NOT NULL CHECK (package_path ~ '^\.antnest/skills/[a-z0-9]+(-[a-z0-9]+)*$'),
    before_digest text CHECK (before_digest IS NULL OR before_digest ~ '^sha256:[0-9a-f]{64}$'),
    after_digest text CHECK (after_digest IS NULL OR after_digest ~ '^sha256:[0-9a-f]{64}$'),
    policy_revision text NOT NULL CHECK (policy_revision ~ '^[0-9a-f]{64}$'),
    apply_basis text NOT NULL CHECK (apply_basis IN ('policy','user_action')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id,agent_id,sequence),
    CHECK (task_id IS NOT NULL AND candidate_id IS NOT NULL AND after_digest IS NOT NULL)
);

CREATE INDEX learning_changes_owner_page_idx
    ON learning_changes (organization_id,agent_id,owner_principal_id,sequence DESC);
