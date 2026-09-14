ALTER TABLE tool_attempts
    ADD COLUMN runtime_call_stopped boolean NOT NULL DEFAULT false;

CREATE INDEX tool_attempts_unstopped_runtime_idx ON tool_attempts (run_id)
    WHERE source = 'runtime' AND NOT runtime_call_stopped;
