ALTER TABLE agent_controller.agent_lifecycle_operations
    DROP CONSTRAINT agent_lifecycle_operation_sources_check,
    ADD CONSTRAINT agent_lifecycle_operation_sources_check CHECK (
        (kind = 'create' AND source_spec_revision_id = '' AND source_execution_revision_id = ''
            AND source_runtime_revision = '' AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'rebuild' AND source_spec_revision_id <> ''
            AND source_runtime_revision <> '' AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'disable' AND source_spec_revision_id <> ''
            AND source_runtime_revision <> '' AND NOT source_runtime_absent AND target_spec_revision_id = '') OR
        (kind = 'enable' AND source_spec_revision_id <> ''
            AND source_runtime_revision <> '' AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'delete' AND source_spec_revision_id = '' AND source_execution_revision_id = '' AND target_spec_revision_id = '' AND (
            (source_runtime_revision <> '' AND NOT source_runtime_absent) OR
            (source_runtime_revision = '' AND source_runtime_absent) OR
            (source_runtime_revision = '' AND NOT source_runtime_absent
                AND source_runtime_inspection IS NULL AND source_runtime_absence_proof IS NULL
                AND phase IN ('drain', 'network_fence') AND state <> 'completed')
        ))
    );

ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_type_known;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_type_known CHECK (event_type IN (
    'agent_create_requested', 'agent_created', 'agent_ready', 'agent_build_failed',
    'agent_rebuild_requested', 'agent_rebuilt',
    'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
    'agent_enable_requested', 'agent_enabled', 'agent_enable_failed',
    'agent_delete_requested', 'agent_deleted',
    'agent_lifecycle_quarantined', 'agent_runtime_restarted', 'agent_runtime_missing',
    'agent_owner_revoked',
    'agent_authorization_updated'
));
