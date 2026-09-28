ALTER TABLE agent_controller.agent_skill_preparation_intents
    ADD COLUMN preparation_attempt INTEGER NOT NULL DEFAULT 0 CHECK (preparation_attempt >= 0);

ALTER TABLE agent_controller.agent_skill_preparation_intents
    DROP CONSTRAINT agent_skill_preparation_intents_state_check;

ALTER TABLE agent_controller.agent_skill_preparation_intents
    ADD CONSTRAINT agent_skill_preparation_intents_state_check
    CHECK (state IN ('preparing', 'ready', 'invalidated', 'consumed', 'released', 'abandoned'));

DROP INDEX agent_controller.agent_skill_preparation_one_active_per_agent;
CREATE UNIQUE INDEX agent_skill_preparation_one_active_per_agent
    ON agent_controller.agent_skill_preparation_intents (agent_id)
    WHERE state IN ('preparing', 'ready', 'invalidated');
