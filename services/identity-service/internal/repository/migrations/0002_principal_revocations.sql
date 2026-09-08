CREATE TABLE principal_revocations (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY (CACHE 1 NO CYCLE) PRIMARY KEY,
    user_id TEXT NOT NULL CHECK (user_id <> ''),
    organization_id TEXT,
    reason TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    traceparent TEXT NOT NULL DEFAULT '',
    CONSTRAINT principal_revocations_scope CHECK (
        (reason = 'user_deactivated' AND organization_id IS NULL)
        OR (reason IN ('membership_deactivated', 'membership_deleted')
            AND organization_id IS NOT NULL AND organization_id <> '')
    )
);

CREATE INDEX principal_revocations_owner_sequence_idx
    ON principal_revocations (user_id, sequence DESC);
