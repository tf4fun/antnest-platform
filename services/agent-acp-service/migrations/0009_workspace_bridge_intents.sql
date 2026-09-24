ALTER TABLE acp_sessions
    ADD COLUMN append_version bigint NOT NULL DEFAULT 0
    CHECK (append_version BETWEEN 0 AND 9007199254740991);

ALTER TABLE runs
    ADD COLUMN bridge_intent_id text,
    ADD COLUMN intent_digest text,
    ADD COLUMN expected_append_version bigint,
    ADD COLUMN append_version bigint,
    ADD CONSTRAINT runs_bridge_intent_shape CHECK (
        (bridge_intent_id IS NULL AND intent_digest IS NULL AND expected_append_version IS NULL)
        OR
        (bridge_intent_id IS NOT NULL AND char_length(bridge_intent_id) BETWEEN 1 AND 200
            AND intent_digest ~ '^[a-f0-9]{64}$'
            AND expected_append_version BETWEEN 0 AND 9007199254740991)
    ),
    ADD CONSTRAINT runs_append_version_range CHECK (
        append_version IS NULL OR append_version BETWEEN 1 AND 9007199254740991
    );

CREATE UNIQUE INDEX runs_session_bridge_intent_unique
    ON runs (session_id, bridge_intent_id)
    WHERE bridge_intent_id IS NOT NULL;
