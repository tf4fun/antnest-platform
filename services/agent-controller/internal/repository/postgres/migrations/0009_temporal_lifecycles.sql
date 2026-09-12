DROP INDEX IF EXISTS agent_controller.operations_recovery_claim_idx;
ALTER TABLE agent_controller.agent_lifecycle_operations
    DROP CONSTRAINT IF EXISTS agent_lifecycle_operations_recovery_pair_check,
    DROP CONSTRAINT IF EXISTS agent_lifecycle_operations_terminal_unclaimed_check,
    DROP COLUMN initial_attempt_trace_parent,
    DROP COLUMN previous_recovery_trace_parent,
    DROP COLUMN attempt,
    DROP COLUMN recovery_owner,
    DROP COLUMN recovery_lease_until,
    DROP COLUMN recovery_after,
    DROP COLUMN recovery_failure_count;
