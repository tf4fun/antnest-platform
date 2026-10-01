CREATE TABLE learning_scan_cursors (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    owner_principal_id text NOT NULL,
    policy_revision text NOT NULL CHECK (policy_revision ~ '^[0-9a-f]{64}$'),
    activated_at timestamptz NOT NULL,
    cursor_created_at timestamptz,
    cursor_run_id text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, agent_id),
    CHECK ((cursor_created_at IS NULL) = (cursor_run_id IS NULL))
);

CREATE TABLE learning_tasks (
    id text PRIMARY KEY,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    owner_principal_id text NOT NULL,
    source_run_id text NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
    trigger_kind text NOT NULL CHECK (trigger_kind = 'run_completed'),
    policy_revision text NOT NULL CHECK (policy_revision ~ '^[0-9a-f]{64}$'),
    frozen_policy jsonb NOT NULL CHECK (jsonb_typeof(frozen_policy) = 'object'),
    review_prompt_version integer NOT NULL CHECK (review_prompt_version = 1),
    package_rules_version integer NOT NULL CHECK (package_rules_version = 1),
    state text NOT NULL CHECK (state IN ('pending', 'running', 'paused', 'skipped', 'completed', 'cancelled', 'failed')),
    pause_reason text,
    cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 64),
    generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
    claim_id text,
    started_at timestamptz,
    model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls BETWEEN 0 AND 2),
    input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    model_time_ms integer NOT NULL DEFAULT 0 CHECK (model_time_ms >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, agent_id, source_run_id, trigger_kind),
    CHECK (state <> 'running' OR (generation > 0 AND claim_id IS NOT NULL AND started_at IS NOT NULL)),
    CHECK (state <> 'paused' OR pause_reason IS NOT NULL),
    CHECK (state <> 'cancelled' OR cancel_reason IS NOT NULL)
);

CREATE INDEX learning_tasks_pending_idx ON learning_tasks (created_at, id) WHERE state = 'pending';
CREATE INDEX learning_tasks_agent_pending_idx ON learning_tasks (organization_id, agent_id, created_at, id) WHERE state = 'pending';

CREATE TABLE learning_review_attempts (
    task_id text NOT NULL REFERENCES learning_tasks(id) ON DELETE RESTRICT,
    generation integer NOT NULL CHECK (generation > 0),
    started_at timestamptz NOT NULL,
    PRIMARY KEY (task_id, generation)
);

CREATE INDEX learning_review_attempts_day_idx ON learning_review_attempts (started_at, task_id);

CREATE TABLE learning_model_calls (
    task_id text NOT NULL REFERENCES learning_tasks(id) ON DELETE RESTRICT,
    call_index integer NOT NULL CHECK (call_index BETWEEN 1 AND 2),
    request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
    claim_id text NOT NULL,
    generation integer NOT NULL CHECK (generation > 0),
    reserved_input_tokens integer NOT NULL CHECK (reserved_input_tokens BETWEEN 1 AND 16000),
    reserved_output_tokens integer NOT NULL CHECK (reserved_output_tokens BETWEEN 1 AND 4000),
    reserved_duration_ms integer NOT NULL CHECK (reserved_duration_ms BETWEEN 1 AND 90000),
    state text NOT NULL CHECK (state IN ('reserved', 'settled', 'unknown')),
    actual_input_tokens integer CHECK (actual_input_tokens >= 0),
    actual_output_tokens integer CHECK (actual_output_tokens >= 0),
    actual_duration_ms integer CHECK (actual_duration_ms >= 0),
    review_decision jsonb CHECK (review_decision IS NULL OR
        (jsonb_typeof(review_decision) = 'object' AND
         octet_length(review_decision::text) <= 24576)),
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    PRIMARY KEY (task_id, call_index),
    UNIQUE (task_id, request_id),
    CHECK ((state = 'settled' AND actual_input_tokens IS NOT NULL
        AND actual_output_tokens IS NOT NULL AND actual_duration_ms IS NOT NULL AND settled_at IS NOT NULL)
        OR (state <> 'settled' AND actual_input_tokens IS NULL
            AND actual_output_tokens IS NULL AND actual_duration_ms IS NULL AND settled_at IS NULL
            AND review_decision IS NULL))
);

CREATE TABLE learning_evidence_snapshots (
    task_id text PRIMARY KEY REFERENCES learning_tasks(id) ON DELETE RESTRICT,
    source_run_id text NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
    claim_id text NOT NULL,
    generation integer NOT NULL CHECK (generation > 0),
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    truncated boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learning_evidence_items (
    task_id text NOT NULL REFERENCES learning_evidence_snapshots(task_id) ON DELETE RESTRICT,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
    evidence_id text NOT NULL CHECK (evidence_id ~ '^evidence_[0-9a-f]{32}$'),
    source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
    kind text NOT NULL CHECK (kind IN ('authenticated_user','observed_execution','untrusted_material')),
    scope text NOT NULL CHECK (scope IN ('user_prompt','tool_attempt','tool_output')),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8192),
    PRIMARY KEY (task_id, evidence_id),
    UNIQUE (task_id, ordinal)
);

CREATE INDEX learning_tool_round_messages_idx ON session_messages (run_id, sequence)
    WHERE kind = 'agent_message';

CREATE TABLE learning_source_decisions (
    run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    owner_principal_id text NOT NULL,
    policy_revision text NOT NULL CHECK (policy_revision ~ '^[0-9a-f]{64}$'),
    disposition text NOT NULL CHECK (disposition IN ('skipped', 'queued')),
    reason text CHECK (reason IS NULL OR reason IN ('no_review_cue', 'failed_run', 'policy_off', 'access_revoked', 'source_unavailable')),
    task_id text REFERENCES learning_tasks(id) ON DELETE RESTRICT,
    decided_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((disposition = 'skipped' AND reason IS NOT NULL AND task_id IS NULL)
        OR (disposition = 'queued' AND reason IS NULL AND task_id IS NOT NULL))
);

CREATE INDEX learning_source_decisions_agent_idx
    ON learning_source_decisions (organization_id, agent_id, decided_at, run_id);
