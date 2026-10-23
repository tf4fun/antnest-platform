-- History remains explicitly legacy; no current lease can identify its executor.
ALTER TABLE runs
    ADD COLUMN execution_owner_registration_id text,
    ADD COLUMN execution_owner_member_id text,
    ADD COLUMN execution_owner_incarnation_id text,
    ADD COLUMN execution_owner_epoch bigint,
    ADD CONSTRAINT runs_execution_owner_complete CHECK (
        (
            execution_owner_registration_id IS NULL AND
            execution_owner_member_id IS NULL AND
            execution_owner_incarnation_id IS NULL AND
            execution_owner_epoch IS NULL
        ) OR (
            execution_owner_registration_id IS NOT NULL AND
            execution_owner_member_id IS NOT NULL AND
            execution_owner_incarnation_id IS NOT NULL AND
            execution_owner_epoch IS NOT NULL AND
            execution_owner_registration_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
            execution_owner_member_id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND
            length(execution_owner_member_id) BETWEEN 1 AND 64 AND
            execution_owner_incarnation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
            execution_owner_epoch > 0
        )
    );

CREATE FUNCTION preserve_run_execution_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.execution_owner_registration_id, NEW.execution_owner_member_id,
           NEW.execution_owner_incarnation_id, NEW.execution_owner_epoch)
       IS DISTINCT FROM
       ROW(OLD.execution_owner_registration_id, OLD.execution_owner_member_id,
           OLD.execution_owner_incarnation_id, OLD.execution_owner_epoch) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'Run execution owner is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER runs_preserve_execution_owner
BEFORE UPDATE OF execution_owner_registration_id, execution_owner_member_id,
    execution_owner_incarnation_id, execution_owner_epoch ON runs
FOR EACH ROW EXECUTE FUNCTION preserve_run_execution_owner();
