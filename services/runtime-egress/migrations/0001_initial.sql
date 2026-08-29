CREATE TABLE runtime_egress.address_pools (
    pool_id text PRIMARY KEY,
    cidr cidr NOT NULL,
    resolver_ipv4 inet NOT NULL,
    next_slot bigint NOT NULL CHECK (next_slot > 0),
    quarantine_seconds bigint NOT NULL CHECK (quarantine_seconds >= 0),
    resource_version bigint NOT NULL CHECK (resource_version > 0)
);

CREATE TABLE runtime_egress.agent_networks (
    agent_id text PRIMARY KEY
        CHECK (octet_length(agent_id) BETWEEN 1 AND 255 AND agent_id ~ '^[!-~]+$'),
    pool_id text NOT NULL REFERENCES runtime_egress.address_pools(pool_id),
    tunnel_ipv4 inet NOT NULL UNIQUE,
    state text NOT NULL CHECK (state IN ('active', 'quarantined')),
    resource_version bigint NOT NULL CHECK (resource_version > 0),
    quarantine_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE runtime_egress.policy_revisions (
    policy_id text NOT NULL
        CHECK (octet_length(policy_id) BETWEEN 1 AND 255 AND policy_id ~ '^[!-~]+$'),
    revision bigint NOT NULL CHECK (revision > 0),
    schema_version bigint NOT NULL CHECK (schema_version > 0),
    canonical_spec jsonb NOT NULL,
    digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (policy_id, revision)
);

CREATE TABLE runtime_egress.agent_policy_assignments (
    agent_id text PRIMARY KEY
        REFERENCES runtime_egress.agent_networks(agent_id) ON DELETE CASCADE,
    policy_id text NOT NULL,
    revision bigint NOT NULL,
    resource_version bigint NOT NULL CHECK (resource_version > 0),
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (policy_id, revision)
        REFERENCES runtime_egress.policy_revisions(policy_id, revision)
);
