CREATE TABLE agent_leases (
    organization_id text NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 200),
    agent_id text NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 200),
    owner_instance_id text NOT NULL CHECK (length(owner_instance_id) BETWEEN 1 AND 200),
    epoch bigint NOT NULL CHECK (epoch > 0),
    expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, agent_id)
);

-- Released rows retain their last epoch. The service never deletes a lease row.
