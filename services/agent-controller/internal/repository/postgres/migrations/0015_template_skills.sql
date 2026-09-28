ALTER TABLE agent_controller.agent_template_revisions
    ADD COLUMN skill_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(skill_refs) = 'array');
