ALTER TABLE api_tokens
    ADD COLUMN public_session_id TEXT,
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser',
    ADD COLUMN idle_expires_at TIMESTAMPTZ,
    ADD COLUMN user_agent_hint TEXT NOT NULL DEFAULT '';

UPDATE api_tokens
SET public_session_id = 'browsersession_' || replace(gen_random_uuid()::text, '-', ''),
    idle_expires_at = expires_at,
    last_used_at = COALESCE(last_used_at, issued_at);

ALTER TABLE api_tokens
    ALTER COLUMN public_session_id SET NOT NULL,
    ALTER COLUMN idle_expires_at SET NOT NULL,
    ALTER COLUMN last_used_at SET NOT NULL,
    ADD CONSTRAINT api_tokens_public_session_unique UNIQUE (public_session_id),
    ADD CONSTRAINT api_tokens_public_session_nonempty CHECK (length(btrim(public_session_id)) > 0),
    ADD CONSTRAINT api_tokens_browser_kind CHECK (kind = 'browser'),
    ADD CONSTRAINT api_tokens_user_agent_hint_bounded CHECK (char_length(user_agent_hint) <= 256);

CREATE INDEX api_tokens_browser_inventory_idx ON api_tokens (user_id, public_session_id)
    WHERE kind = 'browser' AND revoked_at IS NULL;

ALTER TABLE oidc_auth_sessions
    ADD COLUMN user_agent_hint TEXT NOT NULL DEFAULT '',
    ADD CONSTRAINT oidc_auth_sessions_user_agent_hint_bounded CHECK (char_length(user_agent_hint) <= 256);
