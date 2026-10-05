package postgres

const instanceAuthenticationSQL = `
ALTER TABLE runtime_controller.operations
    ADD COLUMN instance_authentication JSONB,
    ADD CONSTRAINT instance_authentication_shape CHECK (
        instance_authentication IS NULL OR (
            kind IN ('initialize_runtime', 'update_runtime', 'enable_runtime') AND
            jsonb_typeof(instance_authentication) = 'object' AND
            instance_authentication->>'connection_id' ~ '^rci_[0-9a-f]{32}$' AND
            instance_authentication->>'receiver_digest' ~ '^sha256:[0-9a-f]{64}$'
        )
    );
CREATE UNIQUE INDEX operations_compute_generation_unique
    ON runtime_controller.operations (agent_id, target_generation)
    WHERE kind IN ('initialize_runtime', 'update_runtime', 'enable_runtime');
`
