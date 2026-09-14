ALTER TABLE agent_controller.agent_lifecycle_operations
    ADD COLUMN drain_deadline_at timestamptz,
    ADD COLUMN settlement_outcome text NOT NULL DEFAULT ''
        CHECK (settlement_outcome IN ('', 'settled', 'runtime_barrier_required'));
