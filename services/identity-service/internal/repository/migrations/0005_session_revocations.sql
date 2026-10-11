-- Deliberately no parent FKs: feed writers run after business row locks and
-- must not acquire User/Organization/token locks in the opposite order.
CREATE TABLE session_revocations (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY (CACHE 1 NO CYCLE) PRIMARY KEY,
    token_id TEXT NOT NULL CHECK (token_id <> ''),
    user_id TEXT NOT NULL CHECK (user_id <> ''),
    organization_id TEXT NOT NULL CHECK (organization_id <> ''),
    reason TEXT NOT NULL CHECK (reason IN (
        'session_revoked', 'password_changed', 'role_changed',
        'user_deactivated', 'membership_deactivated', 'membership_deleted'
    )),
    occurred_at TIMESTAMPTZ NOT NULL,
    traceparent TEXT NOT NULL DEFAULT ''
);
