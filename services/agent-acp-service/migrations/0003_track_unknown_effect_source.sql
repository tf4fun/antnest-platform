ALTER TABLE runs
    ADD COLUMN unknown_effect_source text;

UPDATE runs
SET unknown_effect_source = 'unclassified'
WHERE terminal_class = 'unresolved';

ALTER TABLE runs
    ADD CONSTRAINT runs_unknown_effect_source_known CHECK (
        unknown_effect_source IS NULL
        OR unknown_effect_source IN ('runtime_mcp', 'client_mcp', 'unclassified')
    ),
    DROP CONSTRAINT runs_terminal_outcome_valid,
    ADD CONSTRAINT runs_terminal_outcome_valid CHECK (
        (terminal_class IS NULL AND unknown_effect_source IS NULL)
        OR (terminal_class = 'completed' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled') AND error_class IS NULL
            AND unknown_effect_source IS NULL)
        OR (terminal_class = 'cancelled' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled') AND error_class IS NULL
            AND unknown_effect_source IS NULL)
        OR (terminal_class = 'failed' AND executor_state = 'quiescent'
            AND tool_effect_state IN ('none', 'settled') AND error_class IS NOT NULL
            AND unknown_effect_source IS NULL)
        OR (terminal_class = 'unresolved' AND executor_state = 'quiescent'
            AND tool_effect_state = 'unknown' AND error_class IS NOT NULL
            AND unknown_effect_source IS NOT NULL)
    );
