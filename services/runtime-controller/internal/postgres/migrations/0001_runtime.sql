CREATE TABLE IF NOT EXISTS runtimes (
    agent_id TEXT PRIMARY KEY,
    image_ref TEXT NOT NULL,
    network_mode TEXT NOT NULL CHECK (network_mode IN ('restricted', 'unrestricted')),
    desired_state TEXT NOT NULL CHECK (desired_state IN ('active', 'stopped', 'retired', 'purged')),
    status TEXT NOT NULL,
    desired_generation BIGINT NOT NULL CHECK (desired_generation > 0),
    observed_generation BIGINT NOT NULL DEFAULT 0 CHECK (observed_generation >= 0),
    connection_epoch BIGINT NOT NULL DEFAULT 0 CHECK (connection_epoch >= 0),
    network_policy_epoch BIGINT NOT NULL CHECK (network_policy_epoch > 0),
    observed_policy_epoch BIGINT NOT NULL DEFAULT 0 CHECK (observed_policy_epoch >= 0),
    spec_digest TEXT NOT NULL,
    failure_code TEXT NOT NULL DEFAULT '',
    failure_detail TEXT NOT NULL DEFAULT '',
    resource_version BIGINT NOT NULL CHECK (resource_version > 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_generations (
    agent_id TEXT NOT NULL REFERENCES runtimes(agent_id) ON DELETE CASCADE,
    generation BIGINT NOT NULL CHECK (generation > 0),
    image_ref TEXT NOT NULL,
    spec_digest TEXT NOT NULL,
    network_policy_epoch BIGINT NOT NULL CHECK (network_policy_epoch > 0),
    tunnel_ipv4 INET NOT NULL,
    allocator_epoch BIGINT NOT NULL CHECK (allocator_epoch > 0),
    status TEXT NOT NULL,
    container_id TEXT NOT NULL DEFAULT '',
    runtime_instance_id TEXT NOT NULL DEFAULT '',
    connection_epoch BIGINT NOT NULL DEFAULT 0 CHECK (connection_epoch >= 0),
    work_epoch_floor BIGINT NOT NULL DEFAULT 1 CHECK (work_epoch_floor > 0),
    last_work_id TEXT NOT NULL DEFAULT '',
    last_work_epoch BIGINT NOT NULL DEFAULT 0 CHECK (last_work_epoch >= 0),
    last_work_session_id TEXT NOT NULL DEFAULT '',
    failure_code TEXT NOT NULL DEFAULT '',
    failure_detail TEXT NOT NULL DEFAULT '',
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    next_attempt_at TIMESTAMPTZ,
    resource_version BIGINT NOT NULL CHECK (resource_version > 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (agent_id, generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_generations_instance_idx
    ON runtime_generations (runtime_instance_id);

CREATE TABLE IF NOT EXISTS runtime_operations (
    operation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES runtimes(agent_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    generation BIGINT NOT NULL CHECK (generation > 0),
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    error_code TEXT NOT NULL DEFAULT '',
    error_detail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (kind, agent_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS runtime_operations_open_idx
    ON runtime_operations (agent_id, generation, created_at DESC)
    WHERE status IN ('pending', 'running', 'unknown');

CREATE UNIQUE INDEX IF NOT EXISTS runtime_operations_one_open_idx
    ON runtime_operations (agent_id, generation)
    WHERE status IN ('pending', 'running', 'unknown');

CREATE TABLE IF NOT EXISTS network_allocator (
    allocator_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (allocator_id),
    high_watermark BIGINT NOT NULL DEFAULT 0 CHECK (high_watermark >= 0),
    resource_version BIGINT NOT NULL DEFAULT 1 CHECK (resource_version > 0)
);

INSERT INTO network_allocator (allocator_id) VALUES (TRUE)
ON CONFLICT (allocator_id) DO NOTHING;
