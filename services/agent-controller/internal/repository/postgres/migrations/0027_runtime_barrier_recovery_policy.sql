-- The historical default is logical revision zero and has no persisted row.
CREATE TABLE agent_controller.runtime_barrier_recovery_policies (
    organization_id TEXT PRIMARY KEY CHECK (organization_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$'),
    revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    mode TEXT NOT NULL CHECK (mode IN ('auto', 'notify', 'manual')),
    cooldown_ms BIGINT NOT NULL CHECK (cooldown_ms BETWEEN 60000 AND 86400000)
);

-- Original mutation receipts and their policy snapshot commit atomically.
-- Request identities are scoped to the organization, independent of CCT expiry.
CREATE TABLE agent_controller.runtime_barrier_recovery_policy_requests (
    organization_id TEXT NOT NULL REFERENCES agent_controller.runtime_barrier_recovery_policies(organization_id),
    request_id TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$'),
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    result_revision BIGINT NOT NULL CHECK (result_revision BETWEEN 1 AND 9007199254740991),
    result_mode TEXT NOT NULL CHECK (result_mode IN ('auto', 'notify', 'manual')),
    result_cooldown_ms BIGINT NOT NULL CHECK (result_cooldown_ms BETWEEN 60000 AND 86400000),
    PRIMARY KEY (organization_id, request_id)
);
