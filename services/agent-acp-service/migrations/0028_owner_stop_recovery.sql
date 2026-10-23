-- The complete authenticated response remains immutable, including its diagnostic
-- timestamp string. PostgreSQL timestamp precision never normalizes this proof.
CREATE TABLE owner_stop_receipts (
    receipt_id text PRIMARY KEY CHECK (receipt_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    registration_id text NOT NULL UNIQUE CHECK (registration_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    inspection jsonb NOT NULL,
    accepted_at timestamptz NOT NULL,
    UNIQUE (receipt_id, registration_id),
    CHECK ((
        jsonb_typeof(inspection) = 'object'
        AND inspection ?& ARRAY['state','registration_id','member_id','incarnation_id','stop_receipt']
        AND inspection - ARRAY['state','registration_id','member_id','incarnation_id','stop_receipt'] = '{}'::jsonb
        AND inspection->>'state' = 'stopped'
        AND inspection->>'registration_id' = registration_id
        AND jsonb_typeof(inspection->'member_id') = 'string'
        AND inspection->>'member_id' ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
        AND length(inspection->>'member_id') BETWEEN 1 AND 64
        AND inspection->>'incarnation_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof(inspection->'stop_receipt') = 'object'
        AND (inspection->'stop_receipt') ?& ARRAY['receipt_id','reason','observed_at']
        AND (inspection->'stop_receipt') - ARRAY['receipt_id','reason','observed_at'] = '{}'::jsonb
        AND inspection->'stop_receipt'->>'receipt_id' = receipt_id
        AND inspection->'stop_receipt'->>'reason' IN ('container_stopped','container_restarted','container_removed')
        AND inspection->'stop_receipt'->>'observed_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$'
    ) IS TRUE)
);

CREATE TABLE run_owner_recoveries (
    run_id text PRIMARY KEY REFERENCES runs(id),
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

-- A malformed INSERT must not permanently bind proof to unrelated history.
-- Current lease authorization remains the enclosing finite transaction's job;
-- no FK to a mutable lease prevents its later legitimate replacement.
CREATE FUNCTION validate_run_owner_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM runs r JOIN owner_stop_receipts p ON p.receipt_id=NEW.receipt_id
        WHERE r.id=NEW.run_id AND r.state IN ('admitting','running')
          AND r.organization_id=NEW.organization_id AND r.agent_id=NEW.agent_id
          AND r.execution_owner_registration_id=NEW.original_registration_id
          AND r.execution_owner_member_id=NEW.original_member_id
          AND r.execution_owner_incarnation_id=NEW.original_incarnation_id
          AND r.execution_owner_epoch=NEW.original_epoch
          AND p.registration_id=NEW.original_registration_id
          AND p.inspection->>'member_id'=NEW.original_member_id
          AND p.inspection->>'incarnation_id'=NEW.original_incarnation_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Recovery audit must match the original Run and proof';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER run_owner_recoveries_validate
BEFORE INSERT ON run_owner_recoveries
FOR EACH ROW EXECUTE FUNCTION validate_run_owner_recovery();

CREATE FUNCTION preserve_owner_recovery_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Owner recovery evidence is immutable';
END;
$$;

CREATE TRIGGER owner_stop_receipts_immutable
BEFORE UPDATE OR DELETE ON owner_stop_receipts
FOR EACH ROW EXECUTE FUNCTION preserve_owner_recovery_evidence();

CREATE TRIGGER run_owner_recoveries_immutable
BEFORE UPDATE OR DELETE ON run_owner_recoveries
FOR EACH ROW EXECUTE FUNCTION preserve_owner_recovery_evidence();
