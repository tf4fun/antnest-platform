CREATE TABLE acp_sessions (
    id text PRIMARY KEY,
    organization_id text NOT NULL CHECK (organization_id <> ''),
    principal_id text NOT NULL,
    agent_id text NOT NULL,
    cwd text NOT NULL CHECK (cwd = '/workspace'),
    state text NOT NULL CHECK (state IN ('active', 'closed', 'deleted')),
    title text CHECK (title IS NULL OR (char_length(title) BETWEEN 1 AND 200)),
    forked_from_session_id text REFERENCES acp_sessions(id) ON DELETE RESTRICT,
    client_mcp_revision_id text,
    last_execution_revision text,
    last_message_sequence bigint NOT NULL DEFAULT 0 CHECK (last_message_sequence >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (forked_from_session_id IS NULL OR forked_from_session_id <> id)
);

CREATE INDEX acp_sessions_owner_updated_idx
    ON acp_sessions (organization_id, principal_id, agent_id, updated_at DESC, id DESC)
    WHERE state <> 'deleted';

CREATE TABLE client_mcp_revisions (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,
    revision bigint NOT NULL CHECK (revision > 0),
    encrypted_sources bytea NOT NULL,
    nonce bytea NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (session_id, revision)
);

ALTER TABLE acp_sessions
    ADD CONSTRAINT acp_sessions_current_mcp_revision_fk
    FOREIGN KEY (client_mcp_revision_id) REFERENCES client_mcp_revisions(id);

CREATE TABLE runs (
    id text PRIMARY KEY,
    request_id text NOT NULL UNIQUE,
    session_id text NOT NULL REFERENCES acp_sessions(id) ON DELETE RESTRICT,
    client_mcp_revision_id text NOT NULL REFERENCES client_mcp_revisions(id) ON DELETE RESTRICT,
    expected_access_revision text NOT NULL,
    state text NOT NULL CHECK (state IN ('admitting', 'running', 'completed', 'cancelled', 'failed', 'unresolved')),
    pending_user_message_id text,
    input_prompt jsonb NOT NULL,
    deadline_at timestamptz,
    execution_snapshot jsonb,
    terminal_class text CHECK (terminal_class IS NULL OR terminal_class IN ('completed', 'cancelled', 'failed', 'unresolved')),
    executor_state text CHECK (executor_state IS NULL OR executor_state IN ('quiescent', 'cancellation_requested', 'unknown')),
    tool_effect_state text CHECK (tool_effect_state IS NULL OR tool_effect_state IN ('none', 'settled', 'unknown')),
    stop_reason text CHECK (stop_reason IS NULL OR stop_reason IN ('end_turn', 'max_tokens', 'max_turn_requests', 'refusal')),
    error_class text,
    cancel_requested_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (
        (state = 'admitting' AND pending_user_message_id IS NOT NULL)
        OR
        (state <> 'admitting' AND pending_user_message_id IS NULL)
    ),
    CHECK ((deadline_at IS NULL) = (execution_snapshot IS NULL)),
    CHECK (state <> 'admitting' OR execution_snapshot IS NULL),
    CHECK (state <> 'running' OR execution_snapshot IS NOT NULL),
    CHECK (
        (terminal_class IS NULL AND executor_state IS NULL AND tool_effect_state IS NULL)
        OR
        (terminal_class IS NOT NULL AND executor_state IS NOT NULL
            AND tool_effect_state IS NOT NULL AND terminal_class = state)
    ),
    CHECK (
        (terminal_class = 'completed' AND stop_reason IS NOT NULL)
        OR (terminal_class IS DISTINCT FROM 'completed' AND stop_reason IS NULL)
    ),
    CHECK (
        terminal_class IS NULL
        OR (terminal_class = 'completed' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled') AND error_class IS NULL)
        OR (terminal_class = 'cancelled' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled'))
        OR (terminal_class = 'failed' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled') AND error_class IS NOT NULL)
        OR (terminal_class = 'unresolved' AND executor_state = 'unknown'
            AND tool_effect_state = 'unknown' AND error_class IS NOT NULL)
    ),
    CHECK (
        state IN ('admitting', 'running')
        OR terminal_class IS NOT NULL
        OR (state = 'failed' AND execution_snapshot IS NULL AND error_class IS NOT NULL)
    )
);

CREATE INDEX runs_session_created_idx ON runs (session_id, created_at DESC, id DESC);
CREATE INDEX runs_recovery_idx ON runs (state, created_at) WHERE state IN ('admitting', 'running');
CREATE UNIQUE INDEX runs_session_nonterminal_unique
    ON runs (session_id)
    WHERE state IN ('admitting', 'running');

CREATE TABLE session_messages (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,
    run_id text REFERENCES runs(id) ON DELETE SET NULL,
    sequence bigint NOT NULL CHECK (sequence > 0),
    kind text NOT NULL,
    visible boolean NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (session_id, sequence),
    UNIQUE (session_id, id)
);

CREATE INDEX session_messages_replay_idx
    ON session_messages (session_id, sequence)
    WHERE visible;

CREATE TABLE context_checkpoints (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,
    through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
    summary text NOT NULL,
    token_count integer NOT NULL CHECK (token_count >= 0),
    created_at timestamptz NOT NULL,
    UNIQUE (session_id, through_sequence)
);

CREATE TABLE tool_attempts (
    id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    tool_call_id text NOT NULL,
    source text NOT NULL CHECK (source IN ('runtime', 'client')),
    source_id text NOT NULL,
    tool_name text NOT NULL,
    request_digest text NOT NULL,
    state text NOT NULL CHECK (state IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    result_summary jsonb,
    tool_effect_state text NOT NULL CHECK (tool_effect_state IN ('none', 'settled', 'unknown')),
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (run_id, tool_call_id),
    CHECK (
        (state = 'pending' AND started_at IS NULL AND finished_at IS NULL)
        OR (state = 'in_progress' AND started_at IS NOT NULL AND finished_at IS NULL)
        OR (state IN ('completed', 'failed', 'cancelled')
            AND started_at IS NOT NULL AND finished_at IS NOT NULL)
    ),
    CHECK (state IN ('pending', 'in_progress') OR result_summary IS NOT NULL)
);
