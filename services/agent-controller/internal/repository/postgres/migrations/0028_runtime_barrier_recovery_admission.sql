-- Original recovery identities are opaque UTF-8, including NUL. BYTEA keeps
-- them lossless; PostgreSQL TEXT and JSONB cannot represent that frozen wire.
ALTER TABLE agent_controller.agents
    ADD CONSTRAINT agents_organization_unique UNIQUE (id, organization_id);

CREATE TABLE agent_controller.runtime_barrier_recovery_receipts (
    organization_id TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    barrier_id BYTEA NOT NULL CHECK (octet_length(barrier_id) BETWEEN 1 AND 800),
    runtime_revision TEXT NOT NULL CHECK (runtime_revision <> ''),
    runtime_execution_id BYTEA NOT NULL CHECK (octet_length(runtime_execution_id) BETWEEN 1 AND 800),
    reason TEXT NOT NULL CHECK (reason = 'runtime_barrier_required'),
    request_id TEXT NOT NULL UNIQUE REFERENCES agent_controller.agent_lifecycle_operations(request_id),
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    policy_revision BIGINT NOT NULL CHECK (policy_revision BETWEEN 0 AND 9007199254740991),
    policy_mode TEXT NOT NULL CHECK (policy_mode IN ('auto', 'notify', 'manual')),
    policy_cooldown_ms BIGINT NOT NULL CHECK (policy_cooldown_ms BETWEEN 60000 AND 86400000),
    actor_principal_id TEXT NOT NULL CHECK (actor_principal_id <> ''),
    template_id TEXT NOT NULL,
    template_revision BIGINT NOT NULL CHECK (template_revision > 0),
    accepted_at TIMESTAMPTZ NOT NULL,
    cooldown_until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (organization_id, agent_id, barrier_id),
    FOREIGN KEY (agent_id, organization_id) REFERENCES agent_controller.agents(id, organization_id),
    FOREIGN KEY (template_id, organization_id, template_revision)
        REFERENCES agent_controller.agent_template_revisions(template_id, organization_id, revision),
    CHECK (cooldown_until = accepted_at + policy_cooldown_ms * INTERVAL '1 millisecond')
);

-- The Agent row lock serializes this row even when no previous cooldown exists.
CREATE TABLE agent_controller.runtime_barrier_recovery_cooldowns (
    agent_id TEXT PRIMARY KEY REFERENCES agent_controller.agents(id),
    organization_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE REFERENCES agent_controller.runtime_barrier_recovery_receipts(request_id),
    accepted_at TIMESTAMPTZ NOT NULL,
    cooldown_until TIMESTAMPTZ NOT NULL CHECK (cooldown_until > accepted_at),
    FOREIGN KEY (agent_id, organization_id) REFERENCES agent_controller.agents(id, organization_id)
);

-- The receipt retains the original command. Acknowledgement is monotonic, so
-- duplicate starts of the same immutable workflow need no renewable claim.
CREATE TABLE agent_controller.runtime_barrier_recovery_starts (
    request_id TEXT PRIMARY KEY REFERENCES agent_controller.runtime_barrier_recovery_receipts(request_id),
    started_at TIMESTAMPTZ
);
CREATE INDEX runtime_barrier_recovery_pending_starts_idx
    ON agent_controller.runtime_barrier_recovery_starts(request_id) WHERE started_at IS NULL;
