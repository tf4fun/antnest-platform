package postgres

const provisionedEnvironmentSQL = `
ALTER TABLE runtime_controller.operations DROP CONSTRAINT operations_source_state_check;
ALTER TABLE runtime_controller.runtime_environments DROP CONSTRAINT runtime_environments_lifecycle_state_check;
UPDATE runtime_controller.operations SET source_state = 'provisioned' WHERE source_state = 'ready';
UPDATE runtime_controller.operations
SET inspection = jsonb_set(inspection, '{lifecycle_state}', '"provisioned"')
WHERE inspection->>'lifecycle_state' = 'ready';
UPDATE runtime_controller.runtime_environments SET lifecycle_state = 'provisioned' WHERE lifecycle_state = 'ready';
ALTER TABLE runtime_controller.operations ADD CONSTRAINT operations_source_state_check
    CHECK (source_state IN ('uninitialized', 'provisioned', 'disabled', 'failed'));
ALTER TABLE runtime_controller.runtime_environments ADD CONSTRAINT runtime_environments_lifecycle_state_check
    CHECK (lifecycle_state IN ('initializing', 'provisioned', 'updating', 'disabling', 'disabled',
        'enabling', 'deleting', 'deleted', 'failed', 'unknown'));
ALTER TABLE runtime_controller.observations DROP CONSTRAINT observations_kind_check,
    DROP CONSTRAINT observations_identity_scope_check;
ALTER TABLE runtime_controller.observations ADD CONSTRAINT observations_kind_check
    CHECK (kind IN ('initialized', 'updated', 'disabled', 'enabled', 'starting', 'healthy',
        'unhealthy', 'restarted', 'exited', 'deleted', 'runtime_deleted', 'status_unverified',
        'runtime_missing', 'storage_missing', 'storage_drift', 'observation_gap', 'reconciled')),
    ADD CONSTRAINT observations_identity_scope_check CHECK (
        (kind IN ('observation_gap', 'reconciled') AND agent_id = '' AND runtime_revision = ''
            AND generation = 0 AND spec_digest = '' AND platform_resource_id = '' AND runtime_execution_id = '')
        OR
        (kind IN ('initialized', 'updated', 'disabled', 'enabled', 'deleted', 'storage_missing', 'storage_drift')
            AND agent_id <> '' AND runtime_revision ~ '^rtv_[0-9a-f]{32}$'
            AND generation = 0 AND spec_digest = '' AND platform_resource_id = '' AND runtime_execution_id = '')
        OR
        (kind IN ('starting', 'healthy', 'unhealthy', 'restarted', 'exited', 'runtime_deleted',
                 'status_unverified', 'runtime_missing')
            AND agent_id <> '' AND runtime_revision ~ '^rtv_[0-9a-f]{32}$'
            AND generation > 0 AND spec_digest ~ '^sha256:[0-9a-fA-F]{64}$')
    );
`
