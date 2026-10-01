ALTER TABLE tool_attempts DROP CONSTRAINT tool_attempts_agent_discovery_read_only;
ALTER TABLE tool_attempts ADD CONSTRAINT tool_attempts_agent_discovery_effect
 CHECK (source <> 'agent' OR (source_id = 'skill_registry'
   AND ((tool_name = 'find_skill' AND tool_effect_state = 'none') OR tool_name = 'load_skill')));

CREATE TABLE temporary_skill_scopes (
 run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 organization_id text NOT NULL,
 agent_id text NOT NULL,
 execution_id text NOT NULL,
 mcp_endpoint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz
);
CREATE INDEX temporary_skill_scopes_pending ON temporary_skill_scopes(run_id)
 WHERE released_at IS NULL;
CREATE INDEX temporary_skill_scopes_agent_pending ON temporary_skill_scopes(organization_id,agent_id)
 WHERE released_at IS NULL;
