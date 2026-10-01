ALTER TABLE tool_attempts DROP CONSTRAINT tool_attempts_source_check;
ALTER TABLE tool_attempts ADD CONSTRAINT tool_attempts_source_check
    CHECK (source IN ('runtime', 'client', 'agent'));
ALTER TABLE tool_attempts ADD CONSTRAINT tool_attempts_agent_discovery_read_only
    CHECK (source <> 'agent' OR (
        source_id = 'skill_registry'
        AND tool_name IN ('find_skill', 'load_skill')
        AND tool_effect_state = 'none'
    ));
