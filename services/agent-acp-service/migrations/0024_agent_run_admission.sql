-- Derive admission scope from the immutable Session identity, including history.
ALTER TABLE runs
    ADD COLUMN organization_id text,
    ADD COLUMN agent_id text;

UPDATE runs AS run
SET organization_id = session.organization_id,
    agent_id = session.agent_id
FROM acp_sessions AS session
WHERE session.id = run.session_id;

ALTER TABLE runs
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN agent_id SET NOT NULL;

ALTER TABLE acp_sessions
    ADD CONSTRAINT acp_sessions_run_scope_unique
    UNIQUE (id, organization_id, agent_id);

ALTER TABLE runs
    ADD CONSTRAINT runs_session_scope_fk
    FOREIGN KEY (session_id, organization_id, agent_id)
    REFERENCES acp_sessions (id, organization_id, agent_id)
    ON DELETE RESTRICT;

-- Conflicting historical reservations must roll back the entire migration.
CREATE UNIQUE INDEX runs_agent_nonterminal_unique
    ON runs (organization_id, agent_id)
    WHERE state IN ('admitting', 'running');
