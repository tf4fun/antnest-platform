-- Existing receipts were accepted only by the automatic observer. Preserve
-- that provenance without inferring it from a principal ID or a later policy.
ALTER TABLE agent_controller.runtime_barrier_recovery_receipts
    ADD COLUMN manual BOOLEAN NOT NULL DEFAULT false;
