-- Retire old Controller publishers before this migration. Different binaries
-- must not publish different effective policy under one organization revision.
LOCK TABLE agent_controller.execution_configuration_sync IN EXCLUSIVE MODE;

ALTER TABLE agent_controller.agent_template_revisions
    ADD COLUMN model_retry JSONB CHECK (model_retry IS NULL OR jsonb_typeof(model_retry) = 'object'),
    ADD COLUMN failover TEXT CHECK (failover IS NULL OR failover IN ('before_output', 'never')),
    ADD COLUMN run_budget JSONB CHECK (run_budget IS NULL OR jsonb_typeof(run_budget) = 'object');

-- Migrate owns one transaction, including DDL and its journal. Fail the entire
-- upgrade if any organization cannot obtain a new safe publication revision.
DO $policy$
BEGIN
    IF EXISTS (SELECT 1 FROM agent_controller.execution_configuration_sync
               WHERE revision >= 9007199254740991) THEN
        RAISE EXCEPTION 'model-call policy publication revision exhausted';
    END IF;
END
$policy$;

UPDATE agent_controller.execution_configuration_sync
SET revision = revision + 1, updated_at = NOW();

INSERT INTO agent_controller.execution_configuration_sync (organization_id, revision)
SELECT DISTINCT organization_id, 1 FROM agent_controller.agents
ON CONFLICT (organization_id) DO NOTHING;

-- No history or applied acknowledgement is rewritten. Startup publication uses
-- the new projection, and only ACP's actual receipt may advance applied_revision.
