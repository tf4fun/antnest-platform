CREATE TABLE tool_permissions (
    run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    tool_call_id text NOT NULL,
    request_payload jsonb NOT NULL,
    decision text CHECK (decision IN ('allow_once', 'allow_always', 'reject_once', 'reject_always', 'cancelled')),
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    PRIMARY KEY (run_id, tool_call_id),
    CHECK ((decision IS NULL AND reason IS NULL AND decided_at IS NULL)
        OR (decision IS NOT NULL AND reason IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE INDEX tool_permissions_pending_idx ON tool_permissions(run_id) WHERE decision IS NULL;
