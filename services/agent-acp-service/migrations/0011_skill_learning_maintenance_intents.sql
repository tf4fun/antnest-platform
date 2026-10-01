CREATE TABLE learning_maintenance_intents (
    request_id text PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 128),
    task_id text NOT NULL REFERENCES learning_tasks(id) ON DELETE RESTRICT,
    claim_id text NOT NULL,
    generation integer NOT NULL CHECK (generation > 0),
    action text NOT NULL CHECK (action IN ('prepare','check','commit','observe','cancel','release')),
    execution_id text NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 200),
    mcp_endpoint text NOT NULL CHECK (length(mcp_endpoint) BETWEEN 1 AND 2048),
    body_sha256 text NOT NULL CHECK (body_sha256 ~ '^sha256:[0-9a-f]{64}$'),
    request_facts jsonb NOT NULL CHECK (jsonb_typeof(request_facts) = 'object'
        AND octet_length(request_facts::text) <= 16384),
    state text NOT NULL CHECK (state IN ('pending','unknown','settled')),
    receipt jsonb CHECK (receipt IS NULL OR
        (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 16384)),
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    CHECK ((state = 'settled' AND receipt IS NOT NULL AND settled_at IS NOT NULL)
        OR (state <> 'settled' AND receipt IS NULL AND settled_at IS NULL))
);

CREATE INDEX learning_maintenance_intents_unresolved_idx
    ON learning_maintenance_intents (task_id, created_at, request_id)
    WHERE state <> 'settled';
