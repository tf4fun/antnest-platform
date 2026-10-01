CREATE TABLE agent_controller.skill_learning_policies (
    agent_id TEXT PRIMARY KEY REFERENCES agent_controller.agents(id),
    organization_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    revision TEXT NOT NULL CHECK (revision ~ '^[0-9a-f]{64}$'),
    policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_controller.skill_learning_policy_requests (
    request_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
