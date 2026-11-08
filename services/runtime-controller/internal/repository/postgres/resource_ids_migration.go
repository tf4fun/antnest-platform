package postgres

const resourceIDsSQL = `
ALTER TABLE runtime_controller.skill_sets
    DROP CONSTRAINT skill_sets_organization_id_check,
    ADD CONSTRAINT skill_sets_organization_id_check CHECK (
        length(organization_id) BETWEEN 1 AND 200
        AND organization_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$'
        AND organization_id !~ '[^A-Za-z0-9_.-]'
    );
`
