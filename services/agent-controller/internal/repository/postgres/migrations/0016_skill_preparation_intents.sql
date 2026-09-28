CREATE TABLE agent_controller.agent_skill_preparation_intents (
    request_id TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('create', 'rebuild', 'enable')),
    agent_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    target_spec JSONB NOT NULL,
    target_spec_digest TEXT NOT NULL CHECK (target_spec_digest ~ '^[0-9a-f]{64}$'),
    expected_aggregate_sequence BIGINT NOT NULL DEFAULT 0,
    expected_spec_revision_id TEXT NOT NULL DEFAULT '',
    expected_execution_revision_id TEXT NOT NULL DEFAULT '',
    expected_runtime_revision TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'consumed', 'released', 'abandoned')),
    prepared_reference_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK ((state IN ('ready', 'consumed') AND prepared_reference_id <> '') OR
           (state NOT IN ('ready', 'consumed')))
);

CREATE UNIQUE INDEX agent_skill_preparation_one_active_per_agent
    ON agent_controller.agent_skill_preparation_intents (agent_id)
    WHERE state IN ('preparing', 'ready');
