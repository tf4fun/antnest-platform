UPDATE runs
SET error_class = NULL
WHERE terminal_class = 'cancelled';

UPDATE runs
SET executor_state = 'quiescent'
WHERE terminal_class = 'unresolved'
  AND executor_state = 'unknown';

DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT conname
    INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'runs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%terminal_class = ''completed''%'
      AND pg_get_constraintdef(oid) LIKE '%terminal_class = ''cancelled''%'
      AND pg_get_constraintdef(oid) LIKE '%terminal_class = ''failed''%'
      AND pg_get_constraintdef(oid) LIKE '%terminal_class = ''unresolved''%'
      AND pg_get_constraintdef(oid) LIKE '%tool_effect_state%';

    IF constraint_name IS NULL THEN
        RAISE EXCEPTION 'runs terminal outcome constraint was not found';
    END IF;

    EXECUTE format('ALTER TABLE runs DROP CONSTRAINT %I', constraint_name);
END
$$;

ALTER TABLE runs
    ADD CONSTRAINT runs_terminal_outcome_valid CHECK (
        terminal_class IS NULL
        OR (terminal_class = 'completed' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled') AND error_class IS NULL)
        OR (terminal_class = 'cancelled' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled') AND error_class IS NULL)
        OR (terminal_class = 'failed' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled') AND error_class IS NOT NULL)
        OR (terminal_class = 'unresolved' AND executor_state = 'quiescent'
            AND tool_effect_state = 'unknown' AND error_class IS NOT NULL)
    );
