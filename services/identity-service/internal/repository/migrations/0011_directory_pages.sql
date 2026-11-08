CREATE INDEX IF NOT EXISTS groups_organization_display_name_id_idx
    ON groups (organization_id, display_name, id);
