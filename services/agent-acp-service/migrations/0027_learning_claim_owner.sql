-- A source Run describes historical evidence, not the executor of Learning.
ALTER TABLE learning_tasks
    ADD COLUMN authority_mode text NOT NULL DEFAULT 'legacy'
        CHECK (authority_mode IN ('legacy', 'owned')),
    ADD COLUMN claim_owner_registration_id text,
    ADD COLUMN claim_owner_member_id text,
    ADD COLUMN claim_owner_incarnation_id text,
    ADD COLUMN claim_owner_epoch bigint,
    ADD CONSTRAINT learning_tasks_claim_owner_complete CHECK (
        (claim_owner_registration_id IS NULL AND claim_owner_member_id IS NULL
         AND claim_owner_incarnation_id IS NULL AND claim_owner_epoch IS NULL)
        OR
        (claim_owner_registration_id IS NOT NULL AND claim_owner_member_id IS NOT NULL
         AND claim_owner_incarnation_id IS NOT NULL AND claim_owner_epoch IS NOT NULL
         AND claim_owner_registration_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND claim_owner_member_id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
         AND length(claim_owner_member_id) BETWEEN 1 AND 64
         AND claim_owner_incarnation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND claim_owner_epoch > 0)
    ),
    ADD CONSTRAINT learning_tasks_authority_shape CHECK (
        (authority_mode = 'legacy' AND claim_owner_registration_id IS NULL)
        OR
        (authority_mode = 'owned' AND (
            (claim_id IS NULL AND generation = 0 AND started_at IS NULL
             AND claim_owner_registration_id IS NULL AND state IN ('pending', 'cancelled'))
            OR
            (claim_id IS NOT NULL AND generation > 0 AND started_at IS NOT NULL
             AND claim_owner_registration_id IS NOT NULL)
        ))
    );

CREATE FUNCTION preserve_learning_claim_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.authority_mode = 'owned' OR NEW.authority_mode = 'owned' THEN
        IF ROW(NEW.id, NEW.organization_id, NEW.agent_id, NEW.owner_principal_id,
               NEW.source_run_id, NEW.trigger_kind, NEW.policy_revision,
               NEW.frozen_policy, NEW.review_prompt_version, NEW.package_rules_version)
           IS DISTINCT FROM
           ROW(OLD.id, OLD.organization_id, OLD.agent_id, OLD.owner_principal_id,
               OLD.source_run_id, OLD.trigger_kind, OLD.policy_revision,
               OLD.frozen_policy, OLD.review_prompt_version, OLD.package_rules_version) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Learning task scope is immutable';
        END IF;
    END IF;
    IF OLD.authority_mode = 'owned' THEN
        IF NEW.authority_mode <> 'owned' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Learning authority cannot downgrade';
        END IF;
        IF OLD.claim_id IS NOT NULL THEN
            IF ROW(NEW.claim_id, NEW.generation, NEW.started_at,
                   NEW.claim_owner_registration_id, NEW.claim_owner_member_id,
                   NEW.claim_owner_incarnation_id, NEW.claim_owner_epoch)
               IS DISTINCT FROM
               ROW(OLD.claim_id, OLD.generation, OLD.started_at,
                   OLD.claim_owner_registration_id, OLD.claim_owner_member_id,
                   OLD.claim_owner_incarnation_id, OLD.claim_owner_epoch) THEN
                RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Learning claim owner is immutable';
            END IF;
        ELSIF NEW.claim_id IS NOT NULL AND NOT (
            OLD.state = 'pending' AND OLD.generation = 0 AND NEW.state = 'running'
            AND NEW.generation = 1 AND NEW.started_at IS NOT NULL
            AND NEW.claim_owner_registration_id IS NOT NULL
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Learning owner requires the first pending claim';
        END IF;
    ELSIF NEW.authority_mode = 'owned' THEN
        -- Adoption is an explicit, separate write before the first owned claim.
        -- Existing legacy claims and their evidence are never relabelled.
        IF NOT (
            OLD.state = 'pending' AND NEW.state = 'pending'
            AND OLD.generation = 0 AND NEW.generation = 0
            AND OLD.claim_id IS NULL AND NEW.claim_id IS NULL
            AND OLD.started_at IS NULL AND NEW.started_at IS NULL
            AND OLD.model_calls = 0 AND OLD.input_tokens = 0
            AND OLD.output_tokens = 0 AND OLD.model_time_ms = 0
            AND NEW.model_calls = 0 AND NEW.input_tokens = 0
            AND NEW.output_tokens = 0 AND NEW.model_time_ms = 0
        ) OR EXISTS (SELECT 1 FROM learning_review_attempts WHERE task_id = OLD.id)
          OR EXISTS (SELECT 1 FROM learning_model_calls WHERE task_id = OLD.id)
          OR EXISTS (SELECT 1 FROM learning_evidence_snapshots WHERE task_id = OLD.id)
          OR EXISTS (SELECT 1 FROM learning_candidates WHERE task_id = OLD.id)
          OR EXISTS (SELECT 1 FROM learning_apply_bases WHERE task_id = OLD.id)
          OR EXISTS (SELECT 1 FROM learning_maintenance_intents WHERE task_id = OLD.id)
          OR EXISTS (SELECT 1 FROM learning_changes WHERE task_id = OLD.id) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only pristine pending Learning work can be adopted';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER learning_tasks_preserve_claim_owner
BEFORE UPDATE ON learning_tasks
FOR EACH ROW EXECUTE FUNCTION preserve_learning_claim_owner();

-- Never invent an owner or claim for historical review attempts.
ALTER TABLE learning_review_attempts
    ADD COLUMN authority_mode text NOT NULL DEFAULT 'legacy'
        CHECK (authority_mode IN ('legacy', 'owned')),
    ADD COLUMN claim_id text,
    ADD COLUMN claim_owner_registration_id text,
    ADD COLUMN claim_owner_member_id text,
    ADD COLUMN claim_owner_incarnation_id text,
    ADD COLUMN claim_owner_epoch bigint,
    ADD CONSTRAINT learning_review_attempts_owner_shape CHECK (
        (authority_mode = 'legacy' AND claim_owner_registration_id IS NULL
         AND claim_owner_member_id IS NULL AND claim_owner_incarnation_id IS NULL
         AND claim_owner_epoch IS NULL)
        OR
        (authority_mode = 'owned' AND claim_id IS NOT NULL
         AND claim_owner_registration_id IS NOT NULL AND claim_owner_member_id IS NOT NULL
         AND claim_owner_incarnation_id IS NOT NULL AND claim_owner_epoch IS NOT NULL
         AND claim_owner_epoch > 0)
    );

CREATE FUNCTION preserve_learning_review_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.authority_mode = 'owned' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Owned Learning review history must be preserved';
        END IF;
        RETURN OLD;
    ELSIF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
            SELECT 1 FROM learning_tasks task
            WHERE task.id = NEW.task_id
              AND task.authority_mode = NEW.authority_mode
              AND (NEW.authority_mode = 'legacy' OR (
                  task.generation = NEW.generation
                  AND task.claim_id = NEW.claim_id AND task.started_at = NEW.started_at
                  AND task.claim_owner_registration_id = NEW.claim_owner_registration_id
                  AND task.claim_owner_member_id = NEW.claim_owner_member_id
                  AND task.claim_owner_incarnation_id = NEW.claim_owner_incarnation_id
                  AND task.claim_owner_epoch = NEW.claim_owner_epoch
              ))
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Learning review must preserve its admitted generation';
        END IF;
    ELSIF ROW(NEW.task_id, NEW.generation, NEW.authority_mode, NEW.claim_id,
              NEW.claim_owner_registration_id, NEW.claim_owner_member_id,
              NEW.claim_owner_incarnation_id, NEW.claim_owner_epoch)
          IS DISTINCT FROM
          ROW(OLD.task_id, OLD.generation, OLD.authority_mode, OLD.claim_id,
              OLD.claim_owner_registration_id, OLD.claim_owner_member_id,
              OLD.claim_owner_incarnation_id, OLD.claim_owner_epoch)
          OR (OLD.authority_mode = 'owned' AND NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Learning review owner is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER learning_review_attempts_preserve_owner
BEFORE INSERT OR UPDATE OR DELETE ON learning_review_attempts
FOR EACH ROW EXECUTE FUNCTION preserve_learning_review_owner();
