CREATE FUNCTION agent_controller.notify_run_availability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('agent_controller_events', 'workspace_state');
    RETURN NULL;
END;
$$;

CREATE TRIGGER run_availability_insert_delete
AFTER INSERT OR DELETE ON agent_controller.run_admissions
FOR EACH ROW EXECUTE FUNCTION agent_controller.notify_run_availability();

CREATE TRIGGER run_availability_state_change
AFTER UPDATE OF state ON agent_controller.run_admissions
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION agent_controller.notify_run_availability();
