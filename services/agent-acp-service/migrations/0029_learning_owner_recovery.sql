CREATE TABLE learning_owner_recoveries (
    task_id text PRIMARY KEY REFERENCES learning_tasks(id),
    claim_id text NOT NULL,
    generation integer NOT NULL CHECK (generation > 0),
    receipt_id text NOT NULL,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    original_registration_id text NOT NULL,
    original_member_id text NOT NULL,
    original_incarnation_id text NOT NULL,
    original_epoch bigint NOT NULL CHECK (original_epoch > 0),
    recovering_registration_id text NOT NULL,
    recovering_member_id text NOT NULL,
    recovering_incarnation_id text NOT NULL,
    recovering_epoch bigint NOT NULL CHECK (recovering_epoch > original_epoch),
    accepted_at timestamptz NOT NULL,
    FOREIGN KEY (receipt_id, original_registration_id)
        REFERENCES owner_stop_receipts(receipt_id, registration_id),
    CHECK (original_incarnation_id <> recovering_incarnation_id),
    CHECK (original_registration_id <> recovering_registration_id),
    CHECK (recovering_registration_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CHECK (recovering_incarnation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CHECK (recovering_member_id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
           AND length(recovering_member_id) BETWEEN 1 AND 64)
);

CREATE FUNCTION validate_learning_owner_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM learning_tasks t JOIN owner_stop_receipts p ON p.receipt_id=NEW.receipt_id
        WHERE t.id=NEW.task_id AND t.authority_mode='owned' AND t.state IN ('running','paused')
          AND t.claim_id=NEW.claim_id AND t.generation=NEW.generation
          AND t.organization_id=NEW.organization_id AND t.agent_id=NEW.agent_id
          AND t.claim_owner_registration_id=NEW.original_registration_id
          AND t.claim_owner_member_id=NEW.original_member_id
          AND t.claim_owner_incarnation_id=NEW.original_incarnation_id
          AND t.claim_owner_epoch=NEW.original_epoch
          AND p.registration_id=NEW.original_registration_id
          AND p.inspection->>'member_id'=NEW.original_member_id
          AND p.inspection->>'incarnation_id'=NEW.original_incarnation_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Recovery audit must match the original Learning claim and proof';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER learning_owner_recoveries_validate
BEFORE INSERT ON learning_owner_recoveries
FOR EACH ROW EXECUTE FUNCTION validate_learning_owner_recovery();

CREATE TRIGGER learning_owner_recoveries_immutable
BEFORE UPDATE OR DELETE ON learning_owner_recoveries
FOR EACH ROW EXECUTE FUNCTION preserve_owner_recovery_evidence();

CREATE TABLE learning_runtime_protections (
    request_id text PRIMARY KEY REFERENCES learning_maintenance_intents(request_id),
    task_id text NOT NULL REFERENCES learning_owner_recoveries(task_id),
    claim_id text NOT NULL,
    generation integer NOT NULL CHECK (generation > 0),
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    execution_id text NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 200),
    runtime_revision text NOT NULL CHECK (runtime_revision ~ '^rtv_[0-9a-f]{32}$'),
    mcp_endpoint text NOT NULL CHECK (length(mcp_endpoint) BETWEEN 1 AND 2048),
    connection_id text NOT NULL CHECK (connection_id ~ '^rci_[0-9a-f]{32}$'),
    body_sha256 text NOT NULL CHECK (body_sha256 ~ '^sha256:[0-9a-f]{64}$'),
    accepted_at timestamptz NOT NULL,
    retired_at timestamptz
);

CREATE INDEX learning_runtime_protections_active_idx
    ON learning_runtime_protections(organization_id,agent_id,runtime_revision)
    WHERE retired_at IS NULL;

CREATE FUNCTION validate_learning_runtime_protection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Learning Runtime protection history is immutable';
    ELSIF TG_OP='UPDATE' THEN
        IF (to_jsonb(NEW)-'retired_at') IS DISTINCT FROM (to_jsonb(OLD)-'retired_at')
           OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Learning Runtime protection may only retire once';
        END IF;
    ELSIF NOT EXISTS (
        SELECT 1 FROM learning_maintenance_intents i
        JOIN learning_owner_recoveries a ON a.task_id=i.task_id
        WHERE i.request_id=NEW.request_id AND i.task_id=NEW.task_id
          AND i.action='install' AND i.state IN ('pending','unknown')
          AND i.claim_id=NEW.claim_id AND i.generation=NEW.generation
          AND a.claim_id=NEW.claim_id AND a.generation=NEW.generation
          AND a.organization_id=NEW.organization_id AND a.agent_id=NEW.agent_id
          AND i.execution_id=NEW.execution_id AND i.runtime_revision=NEW.runtime_revision
          AND i.mcp_endpoint=NEW.mcp_endpoint AND i.connection_id=NEW.connection_id
          AND i.body_sha256=NEW.body_sha256
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Learning Runtime protection must match the original intent';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER learning_runtime_protections_validate
BEFORE INSERT OR UPDATE OR DELETE ON learning_runtime_protections
FOR EACH ROW EXECUTE FUNCTION validate_learning_runtime_protection();
