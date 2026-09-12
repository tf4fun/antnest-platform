ALTER TABLE agent_controller.agent_lifecycle_operations
    DROP CONSTRAINT agent_lifecycle_operations_check2,
    ADD CONSTRAINT agent_lifecycle_operation_sources_check CHECK (
        (kind = 'create' AND source_spec_revision_id = '' AND source_execution_revision_id = ''
            AND source_runtime_revision = '' AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'rebuild' AND source_spec_revision_id <> '' AND source_execution_revision_id <> ''
            AND source_runtime_revision <> '' AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'disable' AND source_spec_revision_id <> '' AND source_execution_revision_id <> ''
            AND source_runtime_revision <> '' AND NOT source_runtime_absent AND target_spec_revision_id = '') OR
        (kind = 'enable' AND source_spec_revision_id <> '' AND source_execution_revision_id <> ''
            AND source_runtime_revision <> '' AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'delete' AND source_spec_revision_id = '' AND source_execution_revision_id = '' AND target_spec_revision_id = '' AND (
            (source_runtime_revision <> '' AND NOT source_runtime_absent) OR
            (source_runtime_revision = '' AND source_runtime_absent) OR
            (source_runtime_revision = '' AND NOT source_runtime_absent
                AND source_runtime_inspection IS NULL AND source_runtime_absence_proof IS NULL
                AND phase IN ('drain', 'network_fence') AND state <> 'completed')
        ))
    );
