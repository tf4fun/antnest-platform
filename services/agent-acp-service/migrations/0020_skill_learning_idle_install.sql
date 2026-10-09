-- Install is the only Runtime Skill effect. Retired actions stay readable as history.
ALTER TABLE learning_maintenance_intents
    DROP CONSTRAINT learning_maintenance_intents_action_check,
    ADD CONSTRAINT learning_maintenance_intents_action_check CHECK (
        action IN ('install','prepare','check','commit','observe','cancel','release')
    );

-- Admission no longer depends on a Runtime check receipt.
ALTER TABLE learning_apply_bases
    ALTER COLUMN check_request_id DROP NOT NULL;
