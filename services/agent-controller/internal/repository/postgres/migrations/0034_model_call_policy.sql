CREATE TABLE agent_controller.model_call_policies (
    organization_id TEXT PRIMARY KEY CHECK (organization_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$'),
    revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object')
);

CREATE TABLE agent_controller.model_call_policy_requests (
    organization_id TEXT NOT NULL REFERENCES agent_controller.model_call_policies(organization_id),
    request_id TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$'),
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    PRIMARY KEY (organization_id, request_id)
);
