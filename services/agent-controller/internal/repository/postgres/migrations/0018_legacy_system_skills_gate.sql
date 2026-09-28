CREATE TABLE agent_controller.legacy_system_skills_migrations (
    agent_id TEXT PRIMARY KEY REFERENCES agent_controller.agents(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'resolved')),
    evidence_ref TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    CHECK ((state = 'pending' AND resolved_at IS NULL) OR
           (state = 'resolved' AND evidence_ref <> '' AND resolved_at IS NOT NULL))
);

CREATE INDEX legacy_system_skills_migrations_pending_idx
    ON agent_controller.legacy_system_skills_migrations (organization_id, agent_id)
    WHERE state = 'pending';

-- An empty historical Template Skill list does not prove that the old shared
-- Docker volume was empty. Every pre-cutover Agent requires an explicit choice.
INSERT INTO agent_controller.legacy_system_skills_migrations (agent_id, organization_id, state)
SELECT id, organization_id, 'pending'
FROM agent_controller.agents
WHERE lifecycle_state <> 'deleted';
