ALTER TABLE agent_controller.agents
    ADD CONSTRAINT agents_owner_access_revision_unique
    UNIQUE (id, owner_user_id, access_revision);

ALTER TABLE agent_controller.agent_access_bindings
    DROP CONSTRAINT agent_access_bindings_agent_id_fkey,
    ADD CONSTRAINT access_bindings_owner_fk
        FOREIGN KEY (agent_id, principal_id, access_revision)
        REFERENCES agent_controller.agents (id, owner_user_id, access_revision)
        DEFERRABLE INITIALLY DEFERRED;
